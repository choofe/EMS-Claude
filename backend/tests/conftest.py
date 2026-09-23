"""
Test fixtures.

Phase 1 has no domain models yet, so tests only need a DB connection
that responds to `SELECT 1` (for the /health/ready check). We use an
in-memory SQLite engine via aiosqlite so tests run without a real
Postgres instance — later phases add a Postgres-backed integration
fixture for schema/constraint tests (Phase 2 onward).
"""
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.session import get_db
from app.main import app

test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
TestSessionLocal = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)


async def _override_get_db():
    async with TestSessionLocal() as session:
        yield session


app.dependency_overrides[get_db] = _override_get_db


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
