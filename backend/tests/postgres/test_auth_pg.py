"""Auth behaviour that depends on the real engine: concurrent refresh serialisation and the Phase 3 migration."""
import asyncio

from alembic import command
from sqlalchemy import func, inspect, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy import pool

import app.models as m
from app.services.auth_service import InvalidRefreshToken, login, rotate_refresh_token
from tests import factories as f


async def test_concurrent_refresh_with_same_token_only_one_wins_and_family_dies(committed_engine):
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        await f.user(s, "ali", "USER")
        await s.commit()
        _, session = await login(s, "ali", f.PASSWORD, None)
    raw = session.refresh_token

    async def attempt():
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            try:
                await rotate_refresh_token(s, raw)
                return "ok"
            except InvalidRefreshToken:
                return "rejected"

    results = await asyncio.gather(attempt(), attempt(), attempt())
    assert sorted(results) == ["ok", "rejected", "rejected"]  # FOR UPDATE serialised them; replays detected

    async with AsyncSession(committed_engine) as s:
        rows = (await s.execute(select(m.RefreshToken))).scalars().all()
        assert rows and all(t.revoked_at is not None for t in rows)  # replay killed the whole family


async def test_phase3_migration_schema_and_downgrade(pg_migrated, alembic_cfg):
    engine = create_async_engine(pg_migrated, poolclass=pool.NullPool)
    async with engine.connect() as conn:
        tables = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))
        user_cols = await conn.run_sync(lambda c: {col["name"]: col for col in inspect(c).get_columns("users")})
        default = (await conn.execute(text(
            "select column_default from information_schema.columns where table_name='users' and column_name='must_change_password'"
        ))).scalar_one()
    await engine.dispose()
    assert {"refresh_tokens", "login_attempts"} <= tables
    assert user_cols["must_change_password"]["nullable"] is False and "false" in default.lower()

    await asyncio.to_thread(command.downgrade, alembic_cfg, "a3f1c9d47b20")
    engine = create_async_engine(pg_migrated, poolclass=pool.NullPool)
    async with engine.connect() as conn:
        tables = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))
        cols = await conn.run_sync(lambda c: {col["name"] for col in inspect(c).get_columns("users")})
    await engine.dispose()
    assert "refresh_tokens" not in tables and "login_attempts" not in tables and "must_change_password" not in cols
    await asyncio.to_thread(command.upgrade, alembic_cfg, "head")
