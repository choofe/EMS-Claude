"""Personnel import (Pd) on real PostgreSQL: the migration round trip and two concurrent commits of the same file."""
import asyncio
import io

import pytest
from alembic import command
from openpyxl import Workbook
from sqlalchemy import func, pool, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models as m
from app.core.errors import DomainError
from app.services import personnel_import
from tests import factories as f

PREV = "f2d8c3a1b750"  # head before Pd


def _xlsx(rows):
    wb = Workbook()
    ws = wb.active
    ws.append(["first_name", "last_name", "personnel_code", "mobile", "groups"])
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def _run(url, *stmts):
    engine = create_async_engine(url, poolclass=pool.NullPool)
    try:
        async with engine.begin() as conn:
            out = None
            for sql in stmts:
                res = await conn.execute(text(sql))
                out = res.all() if res.returns_rows else None
            return out
    finally:
        await engine.dispose()


async def test_migration_round_trip_and_foreign_key(pg_migrated, alembic_cfg):
    await asyncio.to_thread(command.downgrade, alembic_cfg, PREV)
    try:
        assert (await _run(pg_migrated, "SELECT to_regclass('personnel_import_batches')"))[0][0] is None
        await asyncio.to_thread(command.upgrade, alembic_cfg, "head")
        cols = {r[0] for r in await _run(pg_migrated, "SELECT column_name FROM information_schema.columns "
                                                      "WHERE table_name='users'")}
        assert "import_batch_id" in cols
        with pytest.raises(IntegrityError):  # the foreign key is real
            await _run(pg_migrated, "INSERT INTO users (full_name, is_active, login_enabled, import_batch_id) "
                                    "VALUES ('X', true, false, 999999)")
    finally:
        await asyncio.to_thread(command.upgrade, alembic_cfg, "head")


async def test_two_concurrent_commits_of_the_same_file_create_the_people_once(committed_engine, monkeypatch):
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        boss = await f.user(s, "boss_pg", "MANAGEMENT")
        await f.group(s, "ELV")
        await s.commit()
        boss_id = boss.id
    data = _xlsx([["A", "One", 71, "09120000071", "ELV"], ["B", "Two", 72, "09120000072", None]])
    digest = __import__("hashlib").sha256(data).hexdigest()

    # Both contenders must finish validation BEFORE either inserts, or the second would just see the first one's
    # people, reject every row as taken and never reach the insert-time clash this test is about.
    barrier = asyncio.Barrier(2)
    real = personnel_import.analyse_with_corrections

    async def synced(*args, **kwargs):
        out = await real(*args, **kwargs)
        await barrier.wait()
        return out

    monkeypatch.setattr(personnel_import, "analyse_with_corrections", synced)

    async def commit():
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await personnel_import.commit_import(s, actor_id=boss_id, filename="p.xlsx", data=data,
                                                        expected_sha256=digest, corrections=[])

    results = await asyncio.gather(commit(), commit(), return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 1, results
    assert [r.code for r in results if isinstance(r, DomainError)] == ["import_conflict"], results
    async with AsyncSession(committed_engine) as s:
        assert (await s.execute(select(func.count()).select_from(m.User).where(m.User.personnel_code.in_([71, 72])))).scalar_one() == 2
        assert (await s.execute(select(func.count()).select_from(m.PersonnelImportBatch))).scalar_one() == 1


async def test_commit_waits_for_a_group_deactivation_and_then_refuses_the_group(committed_engine):
    """Deactivating a group takes a row lock; the import's shared lock on the active groups makes the two exclusive,
    so a person can never be put into a group that was deactivated while the import was running."""
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        boss = await f.user(s, "boss_lock", "MANAGEMENT")
        grp = await f.group(s, "LCK")
        await s.commit()
        boss_id, grp_id = boss.id, grp.id
    data = _xlsx([["L", "Ock", 81, "09120000081", "LCK"]])
    digest = __import__("hashlib").sha256(data).hexdigest()
    async with AsyncSession(committed_engine) as other:
        await other.execute(text(f"UPDATE groups SET is_active = false WHERE id = {grp_id}"))  # open, uncommitted

        async def commit():
            async with AsyncSession(committed_engine, expire_on_commit=False) as s:
                return await personnel_import.commit_import(s, actor_id=boss_id, filename="p.xlsx", data=data,
                                                            expected_sha256=digest, corrections=[])

        task = asyncio.ensure_future(commit())
        done, _ = await asyncio.wait({task}, timeout=1.0)
        assert not done, "the import must wait for the deactivation instead of using the stale group"
        await other.commit()
    with pytest.raises(DomainError) as e:
        await asyncio.wait_for(task, 10)
    assert e.value.code in {"import_conflict", "group_issues_unresolved"}
    async with AsyncSession(committed_engine) as s:
        assert (await s.execute(select(func.count()).select_from(m.User).where(m.User.personnel_code == 81))).scalar_one() == 0
