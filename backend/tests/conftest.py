"""
Test fixtures.

Phase 1 has no domain models yet, so tests only need a DB connection
that responds to `SELECT 1` (for the /health/ready check). We use an
in-memory SQLite engine via aiosqlite so tests run without a real
Postgres instance — later phases add a Postgres-backed integration
fixture for schema/constraint tests (Phase 2 onward).
"""
import os

# Must run before anything imports app.core.config (settings are cached).
os.environ.setdefault("JWT_SECRET_KEY", "test-only-jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz")

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.session import get_db
from app.main import app
import app.models as models

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


@pytest_asyncio.fixture
async def db():
    """Fresh in-memory SQLite (FKs enforced, full schema, roles seeded) per test.
    StaticPool keeps one connection so every session in the test sees the same data."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(dbapi_conn, _):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(bind=engine, expire_on_commit=False)
    async with maker() as session:
        for code, label in (("USER", "کاربر"), ("EXPERT", "کارشناس"), ("MANAGEMENT", "مدیریت"), ("AUDITOR", "بازرس ارشد")):
            session.add(models.Role(code=code, label_fa=label))
        await session.commit()
        session.session_maker = maker  # lets API tests open extra sessions on the same DB
        yield session
    await engine.dispose()

