"""Pa migration on populated PostgreSQL data: existing users survive the upgrade, and the downgrade refuses (rather
than silently dropping) login-less people. Sync-style helpers like test_phase4_pg; Alembic runs in a thread."""
import asyncio

import pytest
from alembic import command
from sqlalchemy import pool, text
from sqlalchemy.ext.asyncio import create_async_engine

PREV = "d0b8c4f1a539"  # head before Pa


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


async def test_upgrade_keeps_existing_users_and_downgrade_refuses_login_less_people(pg_migrated, alembic_cfg):
    await asyncio.to_thread(command.downgrade, alembic_cfg, PREV)
    try:
        await _run(pg_migrated, "INSERT INTO users (username, hashed_password, full_name, role_id, is_active) "
                                "SELECT 'olduser', 'x', 'Old User', id, true FROM roles WHERE code='USER'")
        await asyncio.to_thread(command.upgrade, alembic_cfg, "head")
        row = (await _run(pg_migrated, "SELECT username, login_enabled, first_name, personnel_code, mobile "
                                       "FROM users WHERE username='olduser'"))[0]
        assert tuple(row) == ("olduser", True, None, None, None)

        await _run(pg_migrated, "INSERT INTO users (full_name, is_active, login_enabled) VALUES ('No Login', true, false)")
        with pytest.raises(Exception):  # NOT NULL cannot be restored while a person without a profile exists
            await asyncio.to_thread(command.downgrade, alembic_cfg, PREV)
        assert (await _run(pg_migrated, "SELECT version_num FROM alembic_version"))[0][0] != PREV  # rolled back, still at head
    finally:
        await _run(pg_migrated, "DELETE FROM users")
        await asyncio.to_thread(command.upgrade, alembic_cfg, "head")
