"""Read side of reports (Phase 7a): list (also the equipment history), detail.

Visibility is decided HERE, in the query, never by the UI:
- report scope = `reports.group_id` (frozen snapshot) against REPORT_VIEW: GROUPS -> the caller's groups, ALL -> everything;
  a report outside it is simply absent (list) or 404 (detail). Soft-deleted reports are hidden from everybody until 7d.
- labor rows: a viewer sees ALL rows of a report only when LABOR_VIEW allows (USER: reports he created; EXPERT: reports
  of his groups; MANAGEMENT/AUDITOR: all). In any visible report he always sees his OWN row, and nobody else's.
"""
import base64
import json
from datetime import datetime

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.permissions import Capability as C, Principal, Scope
from app.models import Equipment, Group, Report, ReportParticipant, ReportType, User
from app.services.queries import LIKE_ESCAPE, contains_pattern
from app.services.report_columns import SORTABLE

DEFAULT_PAGE = 25
MAX_PAGE = 100
SUMMARY_CHARS = 140


def _visible(principal: Principal):
    scope = principal.scope(C.REPORT_VIEW)
    if scope is Scope.ALL:
        return Report.is_active.is_(True)
    if scope is Scope.GROUPS:
        return and_(Report.is_active.is_(True), Report.group_id.in_(sorted(principal.group_ids)))
    raise DomainError("forbidden", 403)


def can_see_all_labor(principal: Principal, group_id: int, created_by: int) -> bool:
    scope = principal.scope(C.LABOR_VIEW)
    if scope is Scope.ALL:
        return True
    if scope is Scope.GROUPS:
        return group_id in principal.group_ids
    if scope is Scope.OWN:
        return created_by == principal.user_id
    return False


def _encode_cursor(value: datetime, report_id: int) -> str:
    return base64.urlsafe_b64encode(json.dumps({"v": value.isoformat(), "i": report_id}).encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return datetime.fromisoformat(data["v"]), int(data["i"])
    except (ValueError, KeyError, TypeError):
        raise DomainError("invalid_cursor", 422)


def _summary(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= SUMMARY_CHARS else flat[: SUMMARY_CHARS - 1] + "…"


def _item(principal: Principal, r: Report, rows: list[ReportParticipant]) -> dict:
    mine = next((p.minutes for p in rows if p.user_id == principal.user_id), None)
    full = can_see_all_labor(principal, r.group_id, r.created_by)
    return {
        "id": r.id, "report_number": r.report_number, "event_datetime": r.event_datetime, "created_at": r.created_at,
        "group": {"id": r.group.id, "code": r.group.code, "name": r.group.name},
        "report_type": {"id": r.report_type.id, "code": r.report_type.code, "name_fa": r.report_type.name_fa,
                        "is_failure": r.report_type.is_failure},
        "equipment": {"id": r.equipment.id, "code": r.equipment.equipment_code} if r.equipment else None,
        "is_general": r.is_general,
        "creator": {"id": r.creator.id, "full_name": r.creator.full_name},
        "description_summary": _summary(r.description), "is_locked": r.is_locked,
        "my_minutes": mine,
        "total_minutes": sum(p.minutes for p in rows) if full else None,
        "people_count": len(rows) if full else None,
    }


async def _participants(db: AsyncSession, report_ids: list[int]) -> dict[int, list[ReportParticipant]]:
    out: dict[int, list[ReportParticipant]] = {i: [] for i in report_ids}
    if report_ids:
        res = await db.execute(select(ReportParticipant).where(ReportParticipant.report_id.in_(report_ids)))
        for p in res.scalars():
            out[p.report_id].append(p)
    return out


def _loaded(stmt):
    from sqlalchemy.orm import selectinload
    return stmt.options(selectinload(Report.group), selectinload(Report.report_type), selectinload(Report.equipment),
                        selectinload(Report.creator))


async def list_reports(db: AsyncSession, principal: Principal, *, limit: int = DEFAULT_PAGE, cursor: str | None = None,
                       sort_by: str = "event_datetime", descending: bool = True, date_from: datetime | None = None,
                       date_to: datetime | None = None, report_type_id: int | None = None, group_id: int | None = None,
                       equipment_id: int | None = None, equipment_code: str | None = None, created_by: int | None = None,
                       general_only: bool = False, report_number: str | None = None, q: str | None = None,
                       mine: bool = False) -> dict:
    if sort_by not in SORTABLE:
        raise DomainError("invalid_sort", 422)
    limit = max(1, min(limit, MAX_PAGE))
    where = [_visible(principal)]
    if date_from:
        where.append(Report.event_datetime >= date_from)
    if date_to:
        where.append(Report.event_datetime <= date_to)
    if report_type_id:
        where.append(Report.report_type_id == report_type_id)
    if group_id:
        where.append(Report.group_id == group_id)
    if equipment_id:
        where.append(Report.equipment_id == equipment_id)
    if equipment_code and equipment_code.strip():
        where.append(Report.equipment_id.in_(select(Equipment.id).where(
            Equipment.equipment_code.like(contains_pattern(equipment_code.upper()), escape=LIKE_ESCAPE))))
    if created_by:
        where.append(Report.created_by == created_by)
    if general_only:
        where.append(Report.is_general.is_(True))
    if report_number and report_number.strip():
        where.append(Report.report_number.like(contains_pattern(report_number.upper()), escape=LIKE_ESCAPE))
    if q and q.strip():
        where.append(Report.description.ilike(contains_pattern(q), escape=LIKE_ESCAPE))
    if mine:
        where.append(exists().where(ReportParticipant.report_id == Report.id,
                                    ReportParticipant.user_id == principal.user_id))
    col = getattr(Report, sort_by)
    if cursor:
        value, rid = _decode_cursor(cursor)
        after = (col < value, and_(col == value, Report.id < rid)) if descending else (col > value, and_(col == value, Report.id > rid))
        where.append(or_(*after))
    order = (col.desc(), Report.id.desc()) if descending else (col.asc(), Report.id.asc())
    rows = list((await db.execute(_loaded(select(Report).where(*where).order_by(*order).limit(limit + 1)))).scalars())
    page, has_more = rows[:limit], len(rows) > limit
    parts = await _participants(db, [r.id for r in page])
    out = {"items": [_item(principal, r, parts[r.id]) for r in page], "next_cursor": None,
           "other_group_reports_may_exist": False}
    if has_more:
        out["next_cursor"] = _encode_cursor(getattr(page[-1], sort_by), page[-1].id)
    if equipment_id and principal.scope(C.REPORT_VIEW) is not Scope.ALL:
        out["other_group_reports_may_exist"] = bool((await db.execute(select(exists().where(
            Report.equipment_id == equipment_id, Report.is_active.is_(True),
            Report.group_id.not_in(sorted(principal.group_ids)))))).scalar())
    return out


async def get_report(db: AsyncSession, principal: Principal, report_id: int) -> dict:
    r = (await db.execute(_loaded(select(Report).where(Report.id == report_id, _visible(principal))))).scalar_one_or_none()
    if r is None:
        raise DomainError("report_not_found", 404)  # same answer for missing and not-yours (no id probing)
    rows = (await _participants(db, [r.id]))[r.id]
    full = can_see_all_labor(principal, r.group_id, r.created_by)
    shown = rows if full else [p for p in rows if p.user_id == principal.user_id]
    names = {u.id: u.full_name for u in (await db.execute(select(User).where(User.id.in_([p.user_id for p in shown])))).scalars()} if shown else {}
    return {**_item(principal, r, rows), "description": r.description, "locked_at": r.locked_at,
            "participants": [{"user_id": p.user_id, "full_name": names[p.user_id], "minutes": p.minutes,
                              "is_me": p.user_id == principal.user_id} for p in sorted(shown, key=lambda p: names[p.user_id])],
            "participants_complete": full}
