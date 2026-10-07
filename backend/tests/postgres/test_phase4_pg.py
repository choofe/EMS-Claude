"""Phase 4 behaviour that only real PostgreSQL can prove: the data migration + CHECK constraints, and the
concurrency guards (last MANAGEMENT, duplicate codes, group deactivation vs equipment creation)."""
import asyncio

import pytest
from alembic import command
from sqlalchemy import func, pool, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models as m
from app.core.errors import DomainError
from app.services import equipment_admin, group_admin, user_admin
from app.services.auth_service import load_principal
from tests import factories as f

PREV = "b7c2e5f81a34"


async def _exec(url, *stmts):
    engine = create_async_engine(url, poolclass=pool.NullPool)
    try:
        async with engine.begin() as conn:
            for sql, params in stmts:
                await conn.execute(text(sql), params)
    finally:
        await engine.dispose()


async def _scalar(url, sql):
    engine = create_async_engine(url, poolclass=pool.NullPool)
    try:
        async with engine.connect() as conn:
            return (await conn.execute(text(sql))).all()
    finally:
        await engine.dispose()


_WIPE = [("DELETE FROM equipment", {}), ("DELETE FROM users", {}), ("DELETE FROM groups", {}),
         ("DELETE FROM report_types WHERE code IN ('my_type','MY_TYPE','other_type')", {})]


async def test_migration_normalises_existing_rows_and_enforces_canonical_form(pg_migrated, alembic_cfg):
    await asyncio.to_thread(command.downgrade, alembic_cfg, PREV)
    try:
        await _exec(pg_migrated,
            ("INSERT INTO groups (name, code, is_active) VALUES ('Lifts', 'Elv', true)", {}),
            ("INSERT INTO users (username, hashed_password, full_name, role_id, is_active) "
             "SELECT 'MixedCase', 'x', 'M', id, true FROM roles WHERE code='USER'", {}),
            ("INSERT INTO equipment (equipment_code, group_id, is_active) SELECT 'elv-1.a', id, true FROM groups", {}),
            ("INSERT INTO report_types (code, name_fa, is_failure, is_active) VALUES ('my_type', 'x', false, true)", {}),
        )
        await asyncio.to_thread(command.upgrade, alembic_cfg, "head")
        assert await _scalar(pg_migrated, "SELECT username FROM users") == [("mixedcase",)]
        assert await _scalar(pg_migrated, "SELECT equipment_code FROM equipment") == [("ELV-1.A",)]
        assert await _scalar(pg_migrated, "SELECT code FROM groups") == [("ELV",)]
        assert await _scalar(pg_migrated, "SELECT code FROM report_types WHERE name_fa='x'") == [("MY_TYPE",)]

        # the database itself now refuses non-canonical values, whatever code path writes them
        for sql in (
            "INSERT INTO users (username, hashed_password, full_name, role_id, is_active) SELECT 'Bad', 'x', 'B', id, true FROM roles LIMIT 1",
            "INSERT INTO equipment (equipment_code, group_id, is_active) SELECT 'x-1', id, true FROM groups LIMIT 1",
            "INSERT INTO groups (name, code, is_active) VALUES ('n', 'lower', true)",
            "INSERT INTO report_types (code, name_fa, is_failure, is_active) VALUES ('other_type', 'y', false, true)",
        ):
            with pytest.raises(IntegrityError):
                await _exec(pg_migrated, (sql, {}))
    finally:
        await _exec(pg_migrated, *_WIPE)
        await asyncio.to_thread(command.upgrade, alembic_cfg, "head")


async def test_migration_refuses_to_merge_case_clashes(pg_migrated, alembic_cfg):
    await asyncio.to_thread(command.downgrade, alembic_cfg, PREV)
    try:
        await _exec(pg_migrated,
            ("INSERT INTO users (username, hashed_password, full_name, role_id, is_active) "
             "SELECT n, 'x', 'M', id, true FROM roles, (VALUES ('Ali'), ('ali')) AS t(n) WHERE code='USER'", {}))
        with pytest.raises(RuntimeError, match="differ only by letter case"):
            await asyncio.to_thread(command.upgrade, alembic_cfg, "head")
        assert await _scalar(pg_migrated, "SELECT count(*) FROM users") == [(2,)]  # nothing was silently merged or altered
    finally:
        await _exec(pg_migrated, *_WIPE)
        await asyncio.to_thread(command.upgrade, alembic_cfg, "head")
    assert await _scalar(pg_migrated, "SELECT version_num FROM alembic_version") == [("c4a9d7e2b610",)]


@pytest.mark.parametrize("round_", range(3))
async def test_concurrent_demotions_never_remove_the_last_management(committed_engine, round_):
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        a, b = await f.user(s, "boss_a", "MANAGEMENT"), await f.user(s, "boss_b", "MANAGEMENT")
        await s.commit()
        pa, pb = await load_principal(s, a.id), await load_principal(s, b.id)
        a_id, b_id = a.id, b.id

    async def demote(actor, target):
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await user_admin.update_user(s, actor=actor, user_id=target, role_code="USER")

    # both actors authenticated as MANAGEMENT BEFORE either change committed (the dangerous interleaving)
    results = await asyncio.gather(demote(pa, b_id), demote(pb, a_id), return_exceptions=True)
    ok = [r for r in results if isinstance(r, dict)]
    failed = [r for r in results if isinstance(r, DomainError)]
    assert len(ok) == 1 and len(failed) == 1 and failed[0].code == "last_management", results
    async with AsyncSession(committed_engine) as s:
        n = (await s.execute(select(func.count()).select_from(m.User).join(m.Role)
                             .where(m.Role.code == "MANAGEMENT", m.User.is_active.is_(True)))).scalar_one()
    assert n == 1


async def test_concurrent_deactivation_of_both_managers_keeps_one(committed_engine):
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        a, b = await f.user(s, "boss_a", "MANAGEMENT"), await f.user(s, "boss_b", "MANAGEMENT")
        await s.commit()
        pa, pb = await load_principal(s, a.id), await load_principal(s, b.id)
        a_id, b_id = a.id, b.id

    async def deactivate(actor, target):
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await user_admin.set_active(s, actor=actor, user_id=target, active=False)

    results = await asyncio.gather(deactivate(pa, b_id), deactivate(pb, a_id), return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 1 and sum(isinstance(r, DomainError) for r in results) == 1


async def test_concurrent_equipment_creation_with_same_code_yields_one_row_and_one_clean_409(committed_engine):
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        g = await f.group(s, "ELV")
        await s.commit()
        gid = g.id

    async def create(code):
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await equipment_admin.create_equipment(s, actor_id=None, equipment_code=code, group_id=gid, description=None)

    results = await asyncio.gather(create("ELV-9"), create("elv-9"), create(" Elv-9 "), return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 1
    assert all(isinstance(r, DomainError) and r.code == "equipment_code_taken" for r in results if not isinstance(r, dict)), results
    async with AsyncSession(committed_engine) as s:
        assert (await s.execute(select(func.count()).select_from(m.Equipment))).scalar_one() == 1


@pytest.mark.parametrize("round_", range(4))
async def test_group_deactivation_and_equipment_creation_cannot_both_win(committed_engine, round_):
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        g = await f.group(s, "ELV")
        await s.commit()
        gid = g.id

    async def deactivate():
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await group_admin.set_group_active(s, actor_id=None, group_id=gid, active=False)

    async def create():
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await equipment_admin.create_equipment(s, actor_id=None, equipment_code="ELV-1", group_id=gid, description=None)

    results = await asyncio.gather(deactivate(), create(), return_exceptions=True)
    assert not any(isinstance(r, Exception) and not isinstance(r, DomainError) for r in results), results  # no 500s/deadlocks
    async with AsyncSession(committed_engine) as s:
        group_active = (await s.get(m.Group, gid)).is_active
        active_equipment = (await s.execute(select(func.count()).select_from(m.Equipment)
                                            .where(m.Equipment.group_id == gid, m.Equipment.is_active.is_(True)))).scalar_one()
    assert not ((not group_active) and active_equipment > 0), "inactive group holds active equipment"
