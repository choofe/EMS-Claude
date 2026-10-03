"""
Fixtures for the PostgreSQL-backed test suite.

Why this exists: the SQLite tests (tests/test_schema.py, conftest.py) are
fast but SQLite differs from Postgres in exactly the places this project
cares about — FK enforcement, boolean/timestamp types, row-level locking.
Anything that must be proven against the real engine (constraints, the
migration chain, concurrent report numbering in Phase 6) lives here.

Activation: set TEST_DATABASE_URL (env var or backend/.env). Unset -> every
test in this directory is skipped, so `pytest` still works without Postgres.

Safety: the database name MUST end with `_test`. The fixtures wipe and
re-migrate it, so they refuse to touch anything else (e.g. ems_db).

Isolation model:
  * `db`               per-test session inside an outer transaction that is
                       rolled back afterwards (session.commit() only releases
                       a SAVEPOINT). Seed rows from the migration (roles,
                       report types, settings) are always visible and never
                       modified. Use for ordinary schema/service tests.
  * `committed_engine` real, committed transactions on separate connections
                       (NullPool). Use ONLY when the test needs true
                       concurrency / commit visibility; cleanup deletes the
                       rows the test created (seed data is preserved).
"""
import asyncio
import re
from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from sqlalchemy import pool, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import get_settings

BACKEND_DIR = Path(__file__).resolve().parents[2]

# Child tables first so ON DELETE RESTRICT never blocks cleanup. Seed tables
# (roles, report_types, system_settings rows) are intentionally left alone.
_CLEANUP_SQL = (
    "DELETE FROM audit_logs",
    "DELETE FROM refresh_tokens",
    "DELETE FROM login_attempts",
    "DELETE FROM report_participants",
    "DELETE FROM reports",
    "DELETE FROM report_sequences",
    "DELETE FROM equipment",
    "DELETE FROM user_groups",
    "UPDATE system_settings SET updated_by = NULL",
    "DELETE FROM users",
    "DELETE FROM groups",
)


def pytest_collection_modifyitems(items):
    for item in items:
        if "tests/postgres" in item.nodeid.replace("\\", "/"):
            item.add_marker(pytest.mark.postgres)


@pytest.fixture(scope="session")
def pg_url() -> str:
    url = get_settings().test_database_url
    if not url:
        pytest.skip("TEST_DATABASE_URL not set — Postgres tests skipped")
    parsed = make_url(url)
    if parsed.get_backend_name() != "postgresql":
        pytest.fail("TEST_DATABASE_URL must be a postgresql+asyncpg URL")
    name = parsed.database or ""
    if not re.fullmatch(r"[A-Za-z0-9_]+_test", name):
        pytest.fail(
            f"Refusing to run: test database name {name!r} must match "
            "[A-Za-z0-9_]+_test (these fixtures wipe the database)."
        )
    return url


async def _ensure_database(url: str) -> None:
    """Create the test database if it does not exist (needs CREATEDB rights)."""
    parsed = make_url(url)
    conn = await asyncpg.connect(
        user=parsed.username,
        password=parsed.password,
        host=parsed.host,
        port=parsed.port,
        database="postgres",
    )
    try:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", parsed.database
        )
        if not exists:
            await conn.execute(f'CREATE DATABASE "{parsed.database}"')
    finally:
        await conn.close()


@pytest.fixture(scope="session")
def alembic_cfg(pg_url) -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    # env.py honours an explicitly-set URL (it only falls back to app
    # settings when this is empty), so migrations hit the TEST database.
    cfg.set_main_option("sqlalchemy.url", pg_url)
    return cfg


@pytest.fixture(scope="session")
def pg_migrated(pg_url, alembic_cfg) -> str:
    """Test DB rebuilt from scratch via the real migration chain, once per run."""
    asyncio.run(_ensure_database(pg_url))
    command.downgrade(alembic_cfg, "base")
    command.upgrade(alembic_cfg, "head")
    return pg_url


@pytest_asyncio.fixture
async def db(pg_migrated):
    engine = create_async_engine(pg_migrated, poolclass=pool.NullPool)
    async with engine.connect() as conn:
        outer = await conn.begin()
        session = AsyncSession(
            bind=conn,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        try:
            yield session
        finally:
            await session.close()
            await outer.rollback()
    await engine.dispose()


@pytest_asyncio.fixture
async def committed_engine(pg_migrated):
    engine = create_async_engine(pg_migrated, poolclass=pool.NullPool)
    try:
        yield engine
    finally:
        async with engine.begin() as conn:
            for stmt in _CLEANUP_SQL:
                await conn.execute(text(stmt))
        await engine.dispose()
