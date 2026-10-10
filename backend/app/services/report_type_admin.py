"""Report types (spec section 13). `code` is immutable. `is_failure` drives failure analytics, so it may only
change while NO report uses the type — otherwise historical failure statistics would silently change; create a
new type and deactivate the old one instead. (Phase 6 report creation must take a SHARE lock on the type row,
mirroring the FOR UPDATE taken here, so the two cannot interleave.)"""
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.normalize import canonical_report_type_code, clean_text
from app.models.report import Report
from app.models.report_type import ReportType
from app.services.audit import add_audit

_UNSET = object()


def _view(t: ReportType) -> dict:
    return {"id": t.id, "code": t.code, "name_fa": t.name_fa, "is_failure": t.is_failure, "is_active": t.is_active,
            "created_at": t.created_at, "updated_at": t.updated_at}


async def list_report_types(db: AsyncSession, *, include_inactive: bool) -> list[dict]:
    stmt = select(ReportType).order_by(ReportType.id)
    if not include_inactive:
        stmt = stmt.where(ReportType.is_active.is_(True))
    return [_view(t) for t in (await db.execute(stmt)).scalars()]


async def _type(db: AsyncSession, type_id: int) -> ReportType:
    t = (await db.execute(select(ReportType).where(ReportType.id == type_id).with_for_update()
                          .execution_options(populate_existing=True))).scalar_one_or_none()
    if t is None:
        raise DomainError("report_type_not_found", 404)
    return t


async def create_report_type(db: AsyncSession, *, actor_id: int, code: str, name_fa: str, is_failure: bool) -> dict:
    code = canonical_report_type_code(code)
    name = clean_text(name_fa, max_length=128, code="invalid_name")
    if (await db.execute(select(ReportType.id).where(ReportType.code == code))).first():
        raise DomainError("report_type_code_taken", 409)
    t = ReportType(code=code, name_fa=name, is_failure=is_failure)
    db.add(t)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise DomainError("report_type_code_taken", 409)
    add_audit(db, actor_id=actor_id, action="report_type.create", entity_type="report_type", entity_id=t.id,
              metadata={"code": code, "is_failure": is_failure})
    await db.commit()
    await db.refresh(t)
    return _view(t)


async def update_report_type(db: AsyncSession, *, actor_id: int, type_id: int, name_fa=_UNSET, is_failure=_UNSET) -> dict:
    t = await _type(db, type_id)
    changes: dict[str, list] = {}
    if name_fa is not _UNSET:
        new = clean_text(name_fa, max_length=128, code="invalid_name")
        if new != t.name_fa:
            changes["name_fa"] = [t.name_fa, new]
            t.name_fa = new
    if is_failure is None:
        raise DomainError("invalid_is_failure", 422)
    if is_failure is not _UNSET and is_failure != t.is_failure:
        used = (await db.execute(select(Report.id).where(Report.report_type_id == t.id).limit(1))).first()
        if used:
            await db.rollback()
            raise DomainError("report_type_in_use", 409)
        changes["is_failure"] = [t.is_failure, is_failure]
        t.is_failure = is_failure
    if changes:
        add_audit(db, actor_id=actor_id, action="report_type.update", entity_type="report_type", entity_id=t.id,
                  metadata={"changes": changes})
    await db.commit()
    await db.refresh(t)
    return _view(t)


async def set_report_type_active(db: AsyncSession, *, actor_id: int, type_id: int, active: bool) -> dict:
    t = await _type(db, type_id)
    if t.is_active != active:
        t.is_active = active
        add_audit(db, actor_id=actor_id, action="report_type.activate" if active else "report_type.deactivate",
                  entity_type="report_type", entity_id=t.id)
    await db.commit()
    await db.refresh(t)
    return _view(t)
