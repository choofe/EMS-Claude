"""
Database engine and session management.

A single async engine is created per process. FastAPI endpoints obtain
a scoped session via the get_db dependency, which guarantees the
session is closed (and rolled back on error) after each request.
"""
from collections.abc import AsyncGenerator

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

settings = get_settings()

# === تغییر جدید: اجبار به استفاده از درایور asyncpg ===
def _normalize_database_url(url: str | None) -> str | None:
    if not url:
        return url
    parsed = make_url(url)
    if parsed.drivername in ("postgresql", "postgresql+psycopg2"):
        parsed = parsed.set(drivername="postgresql+asyncpg")
    return parsed.render_as_string(hide_password=False)
# === پایان تغییر ===

engine = create_async_engine(
    _normalize_database_url(settings.database_url),
    echo=settings.debug,
    pool_pre_ping=True,  # avoids stale-connection errors on free-tier DBs that idle-timeout
    future=True,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()