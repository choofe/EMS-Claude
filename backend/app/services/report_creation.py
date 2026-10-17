"""
Report creation (Phase 6; spec s.14-17, Phase 0 decisions #4/#6, 2026-09-27 snapshot rule).

ONE transaction does everything, in a fixed lock order so concurrent creators can never deadlock:
  equipment row (FOR SHARE) -> report-type row (FOR SHARE) -> [draft row FOR UPDATE] -> report_sequences row
  (the UPDATE ... RETURNING) -> inserts -> audit -> commit.
The sequence row is taken last and held only until commit, so numbers are unique and gap-free: a failed
creation rolls the counter back with everything else.

Everything is re-validated here whatever the client (or a draft) says:
  * equipment must be in the caller's REPORT_CREATE scope and active (not-yours == missing -> 404);
  * reports.group_id is a snapshot of equipment.group_id taken now; the FOR SHARE lock stops a concurrent
    equipment move from changing it between our read and our insert;
  * participants: active users only, each at most once, and eligible per `participant_filter` (the single
    place that rule lives — the candidate-list endpoint uses it too, so the UI list and the server check
    cannot drift apart).
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.jalali import jalali_year, report_year_prefix
from app.core.permissions import Capability, Principal, Scope
from app.core.scoping import apply_equipment_scope
from app.models.equipment import Equipment
from app.models.group import Group
from app.models.report import Report
from app.models.report_draft import ReportDraft
from app.models.report_participant import ReportParticipant
from app.models.report_sequence import ReportSequence
from app.models.report_type import ReportType
from app.models.user import User
from app.models.user_group import UserGroup
from app.schemas.reports import MAX_DESCRIPTION_LENGTH, ReportCreate
from app.services.audit import add_audit
from app.services.queries import LIKE_ESCAPE, contains_pattern
from app.services.runtime_settings import ReportEntryPolicy, get_report_entry_policy

FUTURE_TOLERANCE = timedelta(minutes=5)  # approved 2026-10-16: clock skew between phone and server


def participant_filter(principal: Principal, policy: ReportEntryPolicy, group_id: int):
    """WHERE-clause of users that `principal` may list as participants of a report in `group_id`."""
    active = User.is_active.is_(True)
    unrestricted = principal.scope(Capability.REPORT_CREATE) is Scope.ALL or (
        principal.role_code == "EXPERT" and policy.expert_participants_all_users
    )
    if unrestricted:
        return active
    members = select(UserGroup.user_id).where(UserGroup.group_id == group_id)
    return and_(active, User.id.in_(members))


async def _equipment_for_report(db: AsyncSession, principal: Principal, equipment_id: int, *, lock: bool):
    # Lock/read the equipment row ALONE, then load its group in a second query. A joined
    # `SELECT ... FOR SHARE OF equipment` is wrong under a concurrent equipment move: Postgres re-checks the
    # join against the group row it read before the move, the join no longer matches, and the row silently
    # disappears (spurious 404). Found by test_equipment_move_during_creation_never_mixes_group_and_number.
    stmt = apply_equipment_scope(select(Equipment).where(Equipment.id == equipment_id), principal,
                                 Capability.REPORT_CREATE)
    if lock:
        stmt = stmt.with_for_update(read=True).execution_options(populate_existing=True)
    equipment = (await db.execute(stmt)).scalar_one_or_none()
    if equipment is None:
        raise DomainError("equipment_not_found", 404)  # same answer for "missing" and "not yours"
    if not equipment.is_active:
        raise DomainError("equipment_inactive", 409)
    group = (await db.execute(select(Group).where(Group.id == equipment.group_id))).scalar_one()
    return equipment, group


async def participant_candidates(db: AsyncSession, principal: Principal, equipment_id: int, q: str | None,
                                 limit: int) -> list[dict]:
    _, group = await _equipment_for_report(db, principal, equipment_id, lock=False)
    policy = await get_report_entry_policy(db)
    stmt = select(User.id, User.full_name).where(participant_filter(principal, policy, group.id))
    if q and q.strip():
        stmt = stmt.where(User.full_name.ilike(contains_pattern(q), escape=LIKE_ESCAPE))
    rows = (await db.execute(stmt.order_by(User.full_name, User.id).limit(limit))).all()
    return [{"id": i, "full_name": n} for i, n in rows]


def _clean_description(raw: str) -> str:
    text = "\n".join(line.rstrip() for line in raw.replace("\r\n", "\n").replace("\r", "\n").strip().split("\n"))
    if not text or len(text) > MAX_DESCRIPTION_LENGTH:
        raise DomainError("invalid_description", 422, max_length=MAX_DESCRIPTION_LENGTH)
    return text


async def _next_number(db: AsyncSession, group_id: int, year: int) -> int:
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    await db.execute(
        insert(ReportSequence).values(group_id=group_id, jalali_year=year, last_number=0)
        .on_conflict_do_nothing(index_elements=["group_id", "jalali_year"])
    )
    return (await db.execute(
        update(ReportSequence).where(ReportSequence.group_id == group_id, ReportSequence.jalali_year == year)
        .values(last_number=ReportSequence.last_number + 1).returning(ReportSequence.last_number)
    )).scalar_one()


async def create_report(db: AsyncSession, principal: Principal, body: ReportCreate) -> dict:
    try:
        return await _create(db, principal, body)
    except BaseException:
        await db.rollback()  # nothing half-written, and the sequence counter is released with it
        raise


async def _create(db: AsyncSession, principal: Principal, body: ReportCreate) -> dict:
    now = datetime.now(timezone.utc)
    event = body.event_datetime.astimezone(timezone.utc)
    if event > now + FUTURE_TOLERANCE:
        raise DomainError("event_in_future", 422)
    description = _clean_description(body.description)

    equipment, group = await _equipment_for_report(db, principal, body.equipment_id, lock=True)

    rtype = (await db.execute(select(ReportType).where(ReportType.id == body.report_type_id)
                              .with_for_update(read=True))).scalar_one_or_none()
    if rtype is None:
        raise DomainError("report_type_not_found", 404)
    if not rtype.is_active:
        raise DomainError("report_type_inactive", 409)

    user_ids = [p.user_id for p in body.participants]
    if len(set(user_ids)) != len(user_ids):
        raise DomainError("participant_duplicate", 422)
    policy = await get_report_entry_policy(db)
    allowed = set((await db.execute(
        select(User.id).where(User.id.in_(user_ids), participant_filter(principal, policy, group.id))
    )).scalars())
    rejected = sorted(set(user_ids) - allowed)
    if rejected:
        raise DomainError("participant_not_allowed", 422, user_ids=rejected)

    if body.draft_id is not None:  # lock + consume the draft: a double-submit finds it gone -> 404, no 2nd report
        draft = (await db.execute(select(ReportDraft).where(ReportDraft.id == body.draft_id,
                                                            ReportDraft.user_id == principal.user_id)
                                  .with_for_update())).scalar_one_or_none()
        if draft is None:
            raise DomainError("draft_not_found", 404)
        await db.delete(draft)

    year = jalali_year(now)
    number = await _next_number(db, group.id, year)
    report = Report(
        report_number=f"{report_year_prefix(year)}-{group.code}-{number:03d}",
        equipment_id=equipment.id, group_id=group.id,  # group_id: frozen snapshot, never re-derived
        report_type_id=rtype.id, event_datetime=event, report_jalali_year=year,
        created_by=principal.user_id, description=description, created_at=now,
    )
    db.add(report)
    await db.flush()
    for p in body.participants:
        db.add(ReportParticipant(report_id=report.id, user_id=p.user_id, minutes=p.minutes))
    add_audit(db, actor_id=principal.user_id, action="report.create", entity_type="report", entity_id=report.id,
              metadata={"report_number": report.report_number, "equipment_id": equipment.id, "group_id": group.id,
                        "report_type_id": rtype.id, "event_datetime": event.isoformat(),
                        "participant_count": len(body.participants),
                        "total_minutes": sum(p.minutes for p in body.participants),
                        "from_draft": body.draft_id is not None})
    try:
        await db.commit()
    except IntegrityError:  # unique(report_number) is the last line of defence; should be unreachable
        raise DomainError("report_number_conflict", 409)

    names = dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(user_ids)))).all())
    return {
        "id": report.id, "report_number": report.report_number, "equipment_id": equipment.id,
        "equipment_code": equipment.equipment_code, "group_id": group.id, "group_code": group.code,
        "report_type_id": rtype.id, "event_datetime": report.event_datetime, "created_at": report.created_at,
        "description": report.description,
        "participants": [{"user_id": p.user_id, "full_name": names[p.user_id], "minutes": p.minutes}
                         for p in body.participants],
    }


async def equipment_quick_pick(db: AsyncSession, principal: Principal, limit: int) -> dict:
    """The caller's OWN most recent / most used equipment (active, still in scope). Own reports only."""
    used = (
        select(Report.equipment_id.label("eid"), func.max(Report.created_at).label("last_at"),
               func.count().label("n"))
        .where(Report.created_by == principal.user_id, Report.is_active.is_(True))
        .group_by(Report.equipment_id).subquery()
    )
    base = apply_equipment_scope(
        select(Equipment, Group, used.c.last_at, used.c.n)
        .join(used, used.c.eid == Equipment.id).join(Group, Group.id == Equipment.group_id)
        .where(Equipment.is_active.is_(True)),
        principal, Capability.REPORT_CREATE,
    )

    def rows(order) -> list[dict]:
        return [
            {"id": e.id, "equipment_code": e.equipment_code, "group_id": g.id, "group_code": g.code,
             "description": e.description}
            for e, g, _, _ in order
        ]

    recent = (await db.execute(base.order_by(used.c.last_at.desc(), Equipment.id).limit(limit))).all()
    frequent = (await db.execute(base.order_by(used.c.n.desc(), used.c.last_at.desc(), Equipment.id).limit(limit))).all()
    return {"recent": rows(recent), "frequent": rows(frequent)}
