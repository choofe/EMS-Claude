"""Phase 5 behaviour that needs real PostgreSQL: a realistic-size import, concurrent identical imports
(the unique constraint is the arbiter), and the undo guards against the real FK RESTRICT."""
import asyncio
import io

import pytest
from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

import app.models as m
from app.core.errors import DomainError
from app.services import equipment_import as svc
from tests import factories as f


def workbook(rows) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(["equipment_code", "group_code", "description"])
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def _seed(engine, code="ELV"):
    async with AsyncSession(engine, expire_on_commit=False) as s:
        g, boss = await f.group(s, code), await f.user(s, "boss", "MANAGEMENT")
        await s.commit()
        return g.id, boss.id


async def test_import_of_a_full_size_group_and_undo(db):
    g, boss = await f.group(db, "ESC"), await f.user(db, "boss", "MANAGEMENT")
    data = workbook([[f"es-{i:03d}\xa0", "esc", f"row {i}"] for i in range(300)])
    out = await svc.commit_import(db, actor_id=boss.id, group_id=g.id, filename="x.xlsx", data=data,
                                  expected_sha256=svc.hashlib.sha256(data).hexdigest())
    assert out["created_count"] == 300 and out["error_count"] == 0
    n = (await db.execute(select(func.count()).select_from(m.Equipment).where(m.Equipment.import_batch_id == out["batch_id"]))).scalar_one()
    assert n == 300
    res = await svc.undo_batch(db, actor_id=boss.id, batch_id=out["batch_id"])
    assert res["deleted_count"] == 300
    assert (await db.execute(select(func.count()).select_from(m.Equipment).where(m.Equipment.group_id == g.id))).scalar_one() == 0


@pytest.mark.parametrize("round_", range(3))
async def test_concurrent_identical_imports_create_each_code_once(committed_engine, round_):
    gid, boss = await _seed(committed_engine)
    data = workbook([[f"C-{i:03d}", "ELV", None] for i in range(150)])
    digest = svc.hashlib.sha256(data).hexdigest()

    async def run():
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await svc.commit_import(s, actor_id=boss, group_id=gid, filename="x.xlsx", data=data, expected_sha256=digest)

    results = await asyncio.gather(run(), run(), return_exceptions=True)
    ok = [r for r in results if isinstance(r, dict)]
    failed = [r for r in results if isinstance(r, DomainError)]
    assert len(ok) == 1 and len(failed) == 1, results
    assert failed[0].code in ("import_conflict", "nothing_to_import")
    async with AsyncSession(committed_engine) as s:
        assert (await s.execute(select(func.count()).select_from(m.Equipment))).scalar_one() == 150
        assert (await s.execute(select(func.count()).select_from(m.EquipmentImportBatch))).scalar_one() == 1
        assert (await s.execute(select(func.count()).select_from(m.AuditLog).where(m.AuditLog.action == "equipment.import"))).scalar_one() == 1


async def test_undo_guard_and_real_foreign_key_both_protect_equipment_with_reports(committed_engine):
    gid, boss = await _seed(committed_engine)
    data = workbook([["K-1", "ELV", None], ["K-2", "ELV", None]])
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        out = await svc.commit_import(s, actor_id=boss, group_id=gid, filename="x.xlsx", data=data,
                                      expected_sha256=svc.hashlib.sha256(data).hexdigest())
        e = (await s.execute(select(m.Equipment).where(m.Equipment.equipment_code == "K-1"))).scalar_one()
        grp = (await s.execute(select(m.Group))).scalar_one()
        user = (await s.execute(select(m.User))).scalar_one()
        await f.report(s, "05-ELV-001", e, grp, user)
        await s.commit()
        batch_id, eid = out["batch_id"], e.id
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        with pytest.raises(DomainError) as exc:
            await svc.undo_batch(s, actor_id=boss, batch_id=batch_id)
        assert exc.value.code == "batch_has_reports"
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:   # the DB itself refuses, too
        with pytest.raises(IntegrityError):
            await s.execute(m.Equipment.__table__.delete().where(m.Equipment.id == eid))
            await s.commit()
    async with AsyncSession(committed_engine) as s:
        assert (await s.execute(select(func.count()).select_from(m.Equipment))).scalar_one() == 2


async def test_batch_row_cannot_be_deleted_while_equipment_references_it(committed_engine):
    gid, boss = await _seed(committed_engine)
    data = workbook([["B-1", "ELV", None]])
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        out = await svc.commit_import(s, actor_id=boss, group_id=gid, filename="x.xlsx", data=data,
                                      expected_sha256=svc.hashlib.sha256(data).hexdigest())
    async with AsyncSession(committed_engine) as s:
        with pytest.raises(IntegrityError):
            await s.execute(m.EquipmentImportBatch.__table__.delete().where(m.EquipmentImportBatch.id == out["batch_id"]))
            await s.commit()
