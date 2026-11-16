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


async def test_two_concurrent_commits_of_the_same_file_create_the_people_once(committed_engine):
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        boss = await f.user(s, "boss_pg", "MANAGEMENT")
        await f.group(s, "ELV")
        await s.commit()
        boss_id = boss.id
    data = _xlsx([["A", "One", 71, "09120000071", "ELV"], ["B", "Two", 72, "09120000072", None]])
    digest = __import__("hashlib").sha256(data).hexdigest()

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
