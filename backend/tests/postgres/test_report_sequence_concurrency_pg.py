"""
Concurrency proof for report numbering (spec section 16), written as
infrastructure for Phase 6: it exercises the exact atomic pattern
documented in app/models/report_sequence.py using separate, truly
concurrent, committed Postgres transactions.

The Phase 6 create-report service should call the same statements; when it
exists, point these tests at the service instead of raw SQL.
"""
import asyncio

from sqlalchemy import text

ENSURE_ROW = text(
    """
    INSERT INTO report_sequences (group_id, jalali_year, last_number)
    VALUES (:g, :y, 0)
    ON CONFLICT (group_id, jalali_year) DO NOTHING
    """
)
NEXT_NUMBER = text(
    """
    UPDATE report_sequences
    SET last_number = last_number + 1
    WHERE group_id = :g AND jalali_year = :y
    RETURNING last_number
    """
)


async def _next_number(engine, group_id: int, year: int) -> int:
    async with engine.begin() as conn:  # own connection + own transaction
        await conn.execute(ENSURE_ROW, {"g": group_id, "y": year})
        return (await conn.execute(NEXT_NUMBER, {"g": group_id, "y": year})).scalar_one()


async def _make_group(engine, code: str) -> int:
    async with engine.begin() as conn:
        return (
            await conn.execute(
                text("INSERT INTO groups (code, name) VALUES (:c, :c) RETURNING id"), {"c": code}
            )
        ).scalar_one()


async def test_concurrent_numbers_are_unique_and_gapless(committed_engine):
    group_id = await _make_group(committed_engine, "CON")
    n = 30
    numbers = await asyncio.gather(*[_next_number(committed_engine, group_id, 1404) for _ in range(n)])
    assert sorted(numbers) == list(range(1, n + 1))


async def test_counters_are_independent_per_group_and_year(committed_engine):
    g1 = await _make_group(committed_engine, "G1")
    g2 = await _make_group(committed_engine, "G2")
    jobs = [(g1, 1404)] * 5 + [(g1, 1405)] * 5 + [(g2, 1404)] * 5
    results = await asyncio.gather(*[_next_number(committed_engine, g, y) for g, y in jobs])

    by_key: dict[tuple[int, int], list[int]] = {}
    for (g, y), num in zip(jobs, results):
        by_key.setdefault((g, y), []).append(num)
    for key, nums in by_key.items():
        assert sorted(nums) == [1, 2, 3, 4, 5], key
