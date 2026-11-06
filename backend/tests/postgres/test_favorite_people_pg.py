"""Phase 6d on the real engine: the per-owner lock keeps the quota exact under parallel stars, stars are idempotent
under parallel duplicates, and the migrated schema carries the constraints."""
import asyncio

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.models as m
from app.core.errors import DomainError
from app.services import favorite_people, report_creation
from tests.postgres import helpers as h
from tests.postgres.test_report_creation_pg import principal_of


async def _seed(engine, n_mates):
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as s:
        group = await h.make_group(s, "FAV", "Favorites")
        owner = await h.make_user(s, "owner", "USER")
        mates = [await h.make_user(s, f"mate{i}", "USER") for i in range(n_mates)]
        for u in [owner, *mates]:
            s.add(m.UserGroup(user_id=u.id, group_id=group.id))
        await s.commit()
        return maker, principal_of(owner, "USER", {group.id}), [u.id for u in mates]


async def _count(maker, owner_id):
    async with maker() as s:
        return (await s.execute(select(func.count()).select_from(m.FavoritePerson)
                                .where(m.FavoritePerson.owner_id == owner_id))).scalar_one()


async def test_parallel_stars_never_exceed_the_quota(committed_engine):
    maker, owner, mates = await _seed(committed_engine, 10)
    async with maker() as s:
        s.add(m.SystemSetting(key="FAVORITE_PEOPLE_MAX", value="3"))
        await s.commit()
    try:
        async def one(uid):
            async with maker() as s:
                await favorite_people.add_favorite(s, owner, uid)

        results = await asyncio.gather(*[one(u) for u in mates], return_exceptions=True)
        assert sum(r is None for r in results) == 3
        assert sum(isinstance(r, DomainError) and r.code == "favorites_limit_reached" for r in results) == 7
        assert await _count(maker, owner.user_id) == 3
    finally:
        async with maker() as s:
            await s.execute(text("DELETE FROM system_settings WHERE key = 'FAVORITE_PEOPLE_MAX'"))
            await s.commit()


async def test_parallel_duplicate_stars_leave_one_row_and_all_succeed(committed_engine):
    maker, owner, mates = await _seed(committed_engine, 1)

    async def one():
        async with maker() as s:
            await favorite_people.add_favorite(s, owner, mates[0])

    results = await asyncio.gather(*[one() for _ in range(8)], return_exceptions=True)
    assert all(r is None for r in results), results
    assert await _count(maker, owner.user_id) == 1


async def test_parallel_star_and_unstar_end_consistent(committed_engine):
    maker, owner, mates = await _seed(committed_engine, 1)

    async def star():
        async with maker() as s:
            await favorite_people.add_favorite(s, owner, mates[0])

    async def unstar():
        async with maker() as s:
            await favorite_people.remove_favorite(s, owner, mates[0])

    results = await asyncio.gather(*[(star() if i % 2 else unstar()) for i in range(10)], return_exceptions=True)
    assert all(r is None for r in results), results
    assert await _count(maker, owner.user_id) in (0, 1)  # either order is legal; never an error or a duplicate


async def test_migrated_schema_refuses_self_star_and_has_a_composite_key(db):
    a = await h.make_user(db, "fa", "USER")
    b = await h.make_user(db, "fb", "USER")
    db.add(m.FavoritePerson(owner_id=a.id, favorite_user_id=b.id))
    await db.flush()
    nested = await db.begin_nested()
    db.add(m.FavoritePerson(owner_id=a.id, favorite_user_id=b.id))
    with pytest.raises(IntegrityError):
        await db.flush()
    await nested.rollback()
    nested = await db.begin_nested()
    db.add(m.FavoritePerson(owner_id=a.id, favorite_user_id=a.id))
    with pytest.raises(IntegrityError):
        await db.flush()
    await nested.rollback()
    names = set((await db.execute(text(
        "SELECT conname FROM pg_constraint WHERE conrelid = 'favorite_people'::regclass"))).scalars())
    assert {"pk_favorite_people", "ck_favorite_people_not_self"} <= names


async def test_candidates_flag_and_filter_work_on_postgres(committed_engine):
    """The `is_favorite` column is an `IN (subquery)` expression and `favorites_only` filters on it: prove both on the real engine,
    together with the preference upsert and the entry-config read."""
    maker, owner, mates = await _seed(committed_engine, 3)
    async with maker() as s:
        group_id = next(iter(owner.group_ids))
        await favorite_people.add_favorite(s, owner, mates[1])
    async with maker() as s:
        everyone = await report_creation.participant_candidates(s, owner, None, group_id, None, 50)
        starred = await report_creation.participant_candidates(s, owner, None, group_id, None, 50, favorites_only=True)
    assert {c["id"]: c["is_favorite"] for c in everyone if c["id"] in mates} == {mates[0]: False, mates[1]: True, mates[2]: False}
    assert [c["id"] for c in starred] == [mates[1]]
    async with maker() as s:
        assert (await report_creation.entry_config(s, owner))["favorites_only"] is False
    for value in (True, False, True):  # insert, then update in place twice
        async with maker() as s:
            assert await favorite_people.set_favorites_only(s, owner, value) == {"favorites_only": value}
    async with maker() as s:
        assert (await report_creation.entry_config(s, owner))["favorites_only"] is True
        rows = (await s.execute(select(func.count()).select_from(m.UserReportPreference)
                                .where(m.UserReportPreference.user_id == owner.user_id))).scalar_one()
    assert rows == 1
