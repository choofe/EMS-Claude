"""Personnel import cancel (Pg) on real PostgreSQL: the migration round trip and the race between a cancel and a
report that starts to use one of the batch's people."""
import asyncio

from alembic import command
from sqlalchemy import func, pool, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models as m
from app.core.errors import DomainError
from app.services import personnel_import_history as history
from tests import factories as f

PREV = "a3e9d5b7c481"  # head before Pg


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


async def test_migration_round_trip_keeps_existing_batches(pg_migrated, alembic_cfg):
    await asyncio.to_thread(command.downgrade, alembic_cfg, PREV)
    try:
        cols = {r[0] for r in await _run(pg_migrated, "SELECT column_name FROM information_schema.columns "
                                                      "WHERE table_name='personnel_import_batches'")}
        assert "kind" not in cols and "removed_count" not in cols
        await _run(pg_migrated, "INSERT INTO users (id, full_name, is_active, login_enabled) VALUES (910001, 'M', true, false)",
                   "INSERT INTO personnel_import_batches (id, file_name, file_sha256, created_by, created_count, rejected_count) "
                   "VALUES (910001, 'old.xlsx', repeat('a', 64), 910001, 3, 0)")
        await asyncio.to_thread(command.upgrade, alembic_cfg, "head")
        row = (await _run(pg_migrated, "SELECT kind, removed_count FROM personnel_import_batches WHERE id = 910001"))[0]
        assert tuple(row) == ("PERSONNEL", 0)
    finally:
        await _run(pg_migrated, "DELETE FROM personnel_import_batches WHERE id = 910001",
                   "DELETE FROM users WHERE id = 910001")
        await asyncio.to_thread(command.upgrade, alembic_cfg, "head")


async def test_a_report_that_starts_using_a_person_during_a_cancel_wins(committed_engine):
    """The cancel locks the batch's people FOR UPDATE: a labor row inserted at the same time (it holds a key-share
    lock on the person) is either finished first, so the cancel sees it and answers batch_changed, or waits. Either
    way the person is never deleted from under a report."""
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        boss = await f.user(s, "boss_cancel", "MANAGEMENT")
        grp = await f.group(s, "CNL")
        author = await f.user(s, "author_cancel", "USER", [grp])
        eq = await f.equipment(s, "CNL-1", grp)
        batch = m.PersonnelImportBatch(file_name="x.xlsx", file_sha256="b" * 64, created_by=boss.id, created_count=2, rejected_count=0)
        s.add(batch)
        await s.flush()
        used = m.User(full_name="U U", first_name="U", last_name="U", personnel_code=9001, mobile="09129000001",
                      login_enabled=False, import_batch_id=batch.id)
        free = m.User(full_name="F F", first_name="F", last_name="F", personnel_code=9002, mobile="09129000002",
                      login_enabled=False, import_batch_id=batch.id)
        s.add_all([used, free])
        rep = await f.report(s, "26-CNL-001", eq, grp, author)
        await s.commit()
        boss_id, batch_id, used_id, free_id, rep_id = boss.id, batch.id, used.id, free.id, rep.id
    async with AsyncSession(committed_engine) as s:
        fp = (await history.cancel_preview(s, batch_id=batch_id))["fingerprint"]
    async with AsyncSession(committed_engine) as other:
        other.add(m.ReportParticipant(report_id=rep_id, user_id=used_id, minutes=30))
        await other.flush()  # open, uncommitted: holds a lock on the person

        async def cancel():
            async with AsyncSession(committed_engine, expire_on_commit=False) as s:
                return await history.cancel_confirm(s, actor_id=boss_id, batch_id=batch_id, expected_fingerprint=fp)

        task = asyncio.ensure_future(cancel())
        done, _ = await asyncio.wait({task}, timeout=1.0)
        assert not done, "the cancel must wait for the report that is being written"
        await other.commit()
    try:
        await asyncio.wait_for(task, 10)
        raise AssertionError("the cancel must not go through on the stale preview")
    except DomainError as e:
        assert e.code == "batch_changed" and e.extra["removable_count"] == 1 and e.extra["exempt_count"] == 1
    async with AsyncSession(committed_engine) as s:
        assert (await s.execute(select(func.count()).select_from(m.User).where(m.User.id.in_([used_id, free_id])))).scalar_one() == 2
        fresh = (await history.cancel_preview(s, batch_id=batch_id))["fingerprint"]
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        out = await history.cancel_confirm(s, actor_id=boss_id, batch_id=batch_id, expected_fingerprint=fresh)
    assert out["removed_count"] == 1 and out["kept_count"] == 1
