"""
Report creation (Phase 6; spec s.14-17, Phase 0 decisions #4/#6, 2026-09-27 snapshot rule).

ONE transaction does everything, in a fixed lock order so concurrent creators can never deadlock:
  equipment row (FOR SHARE) -> report-type row (FOR SHARE) -> [group row FOR SHARE, general reports] -> [draft row FOR UPDATE] -> report_sequences row
  (the UPDATE ... RETURNING) -> inserts -> audit -> commit.
The sequence row is taken last and held only until commit, so numbers are unique and gap-free: a failed
creation rolls the counter back with everything else.

Everything is re-validated here whatever the client (or a draft) says:
  * equipment must be in the caller's REPORT_CREATE scope and active (not-yours == missing -> 404); it may be
    omitted only for types whose equipment_mode is not REQUIRED (NONE rejects equipment altogether), then an explicit in-scope
    group is required;
  * labor rules follow the type's labor_mode (REQUIRED >=1 / OPTIONAL any / NONE none);
  * reports.group_id is a snapshot of equipment.group_id taken now; the FOR SHARE lock stops a concurrent
    equipment move from changing it between our read and our insert;
  * participants: active users only, each at most once, and eligible per `participant_filter` (the single
    place that rule lives — the candidate-list endpoint uses it too, so the UI list and the server check
    cannot drift apart).
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.jalali import jalali_year, report_year_prefix
from app.core.permissions import Capability, Principal, Scope
from app.core.scoping import apply_equipment_scope, apply_group_scope
from app.models.equipment import Equipment
from app.models.group import Group
from app.models.report import Report
from app.models.report_draft import ReportDraft
from app.models.report_participant import ReportParticipant
from app.models.report_sequence import ReportSequence
from app.models.report_type import ReportType
from app.models.user import User
from app.models.user_group import UserGroup
from app.models.report_participant import MAX_PARTICIPANT_MINUTES
from app.schemas.reports import MAX_DESCRIPTION_LENGTH, MAX_PARTICIPANTS, ReportCreate
from app.services.audit import add_audit
from app.services.queries import LIKE_ESCAPE, contains_pattern
from app.services.runtime_settings import ReportEntryPolicy, get_report_entry_policy

FUTURE_TOLERANCE = timedelta(minutes=5)  # approved 2026-10-16: clock skew between phone and server

# Phase 6c quick-add (approved 2026-10-31; fixed in code on purpose, not settings).
FREQUENT_WINDOW = timedelta(days=30)  # a colleague counts only through the author's own reports of the last 30 days
FREQUENT_MIN_REPORTS = 2              # ... and only when he/she appears in at least 2 of them
FREQUENT_POOL = 15                    # candidates returned, best first; the form shows 5 at a time and refills as people are picked
# After the frequent people, the people of the author's latest own report (any age) fill the pool: someone who files
# rarely (every few months) has nobody frequent in 30 days but still benefits from the people of the last report.


def participant_filter(principal: Principal, policy: ReportEntryPolicy, group_id: int):
    """WHERE-clause of users that `principal` may list as participants of a report in `group_id`."""
    active = User.is_active.is_(True)
    unrestricted = (
        principal.scope(Capability.REPORT_CREATE) is Scope.ALL
        or (principal.role_code == "EXPERT" and policy.expert_participants_all_users)
        or (principal.role_code == "USER" and policy.user_participants_all_users)
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


async def _group_for_report(db: AsyncSession, principal: Principal, group_id: int | None, *, lock: bool) -> Group:
    """Group chosen explicitly (general reports). Outside the caller's REPORT_CREATE scope == missing -> 404."""
    if group_id is None:
        raise DomainError("group_required", 422)
    stmt = apply_group_scope(select(Group).where(Group.id == group_id), principal, Capability.REPORT_CREATE)
    if lock:  # deactivating a group takes FOR UPDATE on it: we either finish first or see it inactive
        stmt = stmt.with_for_update(read=True).execution_options(populate_existing=True)
    group = (await db.execute(stmt)).scalar_one_or_none()
    if group is None:
        raise DomainError("group_not_found", 404)
    if not group.is_active:
        raise DomainError("group_inactive", 409)
    return group


async def participant_candidates(db: AsyncSession, principal: Principal, equipment_id: int | None,
                                 group_id: int | None, q: str | None, limit: int) -> list[dict]:
    if (equipment_id is None) == (group_id is None):
        raise DomainError("equipment_or_group_required", 422)
    if equipment_id is not None:
        _, group = await _equipment_for_report(db, principal, equipment_id, lock=False)
    else:
        group = await _group_for_report(db, principal, group_id, lock=False)
    policy = await get_report_entry_policy(db)
    stmt = select(User.id, User.full_name).where(participant_filter(principal, policy, group.id))
    if q and q.strip():
        stmt = stmt.where(User.full_name.ilike(contains_pattern(q), escape=LIKE_ESCAPE))
    rows = (await db.execute(stmt.order_by(User.full_name, User.id).limit(limit))).all()
    return [{"id": i, "full_name": n} for i, n in rows]


async def participant_suggestions(db: AsyncSession, principal: Principal, equipment_id: int | None,
                                  group_id: int | None) -> dict:
    """Quick-add people (Phase 6c), ranked best first:
      1. colleagues in at least FREQUENT_MIN_REPORTS of the caller's OWN-CREATED active reports of the last
         FREQUENT_WINDOW (most reports first, then most recent, then name);
      2. then the people of the caller's most recent own report (any age), for authors who file rarely.
    Capped at FREQUENT_POOL. Reports where the caller was merely a participant are never used, so no colleague's
    report/labor rows can leak; ids and names only (no minutes). Every person is re-checked with
    `participant_filter` for the report's group (the same single eligibility rule as the candidate list and the
    create check); the author and inactive users are never suggested."""
    if (equipment_id is None) == (group_id is None):
        raise DomainError("equipment_or_group_required", 422)
    if equipment_id is not None:
        _, group = await _equipment_for_report(db, principal, equipment_id, lock=False)
    else:
        group = await _group_for_report(db, principal, group_id, lock=False)
    policy = await get_report_entry_policy(db)
    eligible = and_(participant_filter(principal, policy, group.id), User.id != principal.user_id)
    own = and_(Report.created_by == principal.user_id, Report.is_active.is_(True))
    since = datetime.now(timezone.utc) - FREQUENT_WINDOW
    reports_n = func.count(func.distinct(Report.id))
    rows = (await db.execute(
        select(User.id, User.full_name)
        .join(ReportParticipant, ReportParticipant.user_id == User.id)
        .join(Report, Report.id == ReportParticipant.report_id)
        .where(own, Report.created_at >= since, eligible)
        .group_by(User.id, User.full_name).having(reports_n >= FREQUENT_MIN_REPORTS)
        .order_by(reports_n.desc(), func.max(Report.created_at).desc(), User.full_name, User.id)
        .limit(FREQUENT_POOL))).all()
    ranked = [(i, n) for i, n in rows]

    if len(ranked) < FREQUENT_POOL:
        last_id = (await db.execute(
            select(Report.id).where(own).order_by(Report.created_at.desc(), Report.id.desc()).limit(1))).scalar_one_or_none()
        if last_id is not None:
            stmt = (select(User.id, User.full_name)
                    .join(ReportParticipant, ReportParticipant.user_id == User.id)
                    .where(ReportParticipant.report_id == last_id, eligible))
            if ranked:
                stmt = stmt.where(User.id.notin_([i for i, _ in ranked]))
            ranked += [(i, n) for i, n in (await db.execute(
                stmt.order_by(User.full_name, User.id).limit(FREQUENT_POOL - len(ranked)))).all()]
    return {"suggestions": [{"id": i, "full_name": n} for i, n in ranked]}


async def entry_config(db: AsyncSession, principal: Principal) -> dict:
    policy = await get_report_entry_policy(db)
    groups = (await db.execute(apply_group_scope(select(Group).where(Group.is_active.is_(True)), principal,
                                                 Capability.REPORT_CREATE).order_by(Group.code))).scalars()
    return {
        "default_labor_minutes": policy.default_labor_minutes, "max_participant_minutes": MAX_PARTICIPANT_MINUTES,
        "max_participants": MAX_PARTICIPANTS, "max_description_length": MAX_DESCRIPTION_LENGTH,
        "future_tolerance_minutes": int(FUTURE_TOLERANCE.total_seconds() // 60),
        "groups": [{"id": g.id, "code": g.code, "name": g.name} for g in groups],
    }


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


async def _existing_by_key(db: AsyncSession, principal: Principal, key: str | None) -> dict | None:
    """The report this author already created with this idempotency key, as the same response a fresh creation gives."""
    if not key:
        return None
    report = (await db.execute(select(Report).where(Report.created_by == principal.user_id,
                                                    Report.client_request_id == key))).scalar_one_or_none()
    if report is None:
        return None
    equipment = (await db.get(Equipment, report.equipment_id)) if report.equipment_id else None
    group = await db.get(Group, report.group_id)
    rows = (await db.execute(select(ReportParticipant.user_id, User.full_name, ReportParticipant.minutes)
                             .join(User, User.id == ReportParticipant.user_id)
                             .where(ReportParticipant.report_id == report.id).order_by(ReportParticipant.id))).all()
    return {
        "id": report.id, "report_number": report.report_number,
        "equipment_id": equipment.id if equipment else None, "equipment_code": equipment.equipment_code if equipment else None,
        "group_id": group.id, "group_code": group.code, "report_type_id": report.report_type_id, "is_general": report.is_general,
        "event_datetime": report.event_datetime, "created_at": report.created_at, "description": report.description,
        "participants": [{"user_id": u, "full_name": n, "minutes": m} for u, n, m in rows], "already_created": True,
    }


async def _lost_race_or_conflict(db: AsyncSession, principal: Principal, body: ReportCreate) -> dict:
    """Two attempts with the same key raced and the other one won: hand back ITS report (our transaction, including the
    sequence increment, is rolled back). Anything else (unique report_number) is the last line of defence."""
    await db.rollback()
    winner = await _existing_by_key(db, principal, body.client_request_id)
    if winner is not None:
        return winner
    raise DomainError("report_number_conflict", 409)


async def create_report(db: AsyncSession, principal: Principal, body: ReportCreate) -> dict:
    try:
        return await _create(db, principal, body)
    except BaseException:
        await db.rollback()  # nothing half-written, and the sequence counter is released with it
        raise


async def _create(db: AsyncSession, principal: Principal, body: ReportCreate) -> dict:
    earlier = await _existing_by_key(db, principal, body.client_request_id)  # a retry of an attempt that already succeeded
    if earlier is not None:
        return earlier
    now = datetime.now(timezone.utc)
    event = body.event_datetime.astimezone(timezone.utc)
    if event > now + FUTURE_TOLERANCE:
        raise DomainError("event_in_future", 422)
    description = _clean_description(body.description)

    # Lock order (global, deadlock-free): equipment -> report type -> group (explicit-group path only) -> draft -> sequence.
    equipment = group = None
    if body.equipment_id is not None:
        equipment, group = await _equipment_for_report(db, principal, body.equipment_id, lock=True)
        if body.group_id is not None and body.group_id != group.id:
            raise DomainError("group_mismatch", 422)

    rtype = (await db.execute(select(ReportType).where(ReportType.id == body.report_type_id)
                              .with_for_update(read=True))).scalar_one_or_none()
    if rtype is None:
        raise DomainError("report_type_not_found", 404)
    if not rtype.is_active:
        raise DomainError("report_type_inactive", 409)

    if equipment is not None and rtype.equipment_mode == "NONE":
        raise DomainError("equipment_not_allowed", 422)
    if equipment is None:
        if rtype.equipment_mode == "REQUIRED":
            raise DomainError("equipment_required", 422)
        group = await _group_for_report(db, principal, body.group_id, lock=True)

    if rtype.labor_mode == "NONE" and body.participants:
        raise DomainError("labor_not_allowed", 422)
    if rtype.labor_mode == "REQUIRED" and not body.participants:
        raise DomainError("labor_required", 422)

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

    if body.draft_id is not None:  # lock the named draft: a double-submit finds it gone -> 404, no 2nd report
        draft = (await db.execute(select(ReportDraft).where(ReportDraft.id == body.draft_id,
                                                            ReportDraft.user_id == principal.user_id)
                                  .with_for_update())).scalar_one_or_none()
        if draft is None:
            # A parallel attempt with the SAME key may have created the report and consumed this draft while we waited for its
            # lock: then this is a retry of a successful submission, not a missing draft — hand back that report.
            raced = await _existing_by_key(db, principal, body.client_request_id)
            if raced is not None:
                return raced
            raise DomainError("draft_not_found", 404)
    # Whatever was submitted, the author's draft(s) are consumed in the same transaction (one draft per user).
    await db.execute(delete(ReportDraft).where(ReportDraft.user_id == principal.user_id))

    year = jalali_year(now)
    number = await _next_number(db, group.id, year)
    report = Report(
        report_number=f"{report_year_prefix(year)}-{group.code}-{number:03d}",
        equipment_id=equipment.id if equipment else None, group_id=group.id,  # group_id: frozen snapshot
        report_type_id=rtype.id, is_general=rtype.equipment_mode != "REQUIRED", event_datetime=event, report_jalali_year=year,
        created_by=principal.user_id, description=description, created_at=now, client_request_id=body.client_request_id,
    )
    db.add(report)
    try:
        await db.flush()  # a unique violation (same author + key, or report_number) surfaces here, at INSERT time
    except IntegrityError:
        return await _lost_race_or_conflict(db, principal, body)
    for p in body.participants:
        db.add(ReportParticipant(report_id=report.id, user_id=p.user_id, minutes=p.minutes))
    add_audit(db, actor_id=principal.user_id, action="report.create", entity_type="report", entity_id=report.id,
              metadata={"report_number": report.report_number, "equipment_id": equipment.id if equipment else None,
                        "group_id": group.id, "report_type_id": rtype.id, "is_general": report.is_general,
                        "labor_mode": rtype.labor_mode, "event_datetime": event.isoformat(),
                        "participant_count": len(body.participants),
                        "total_minutes": sum(p.minutes for p in body.participants),
                        "from_draft": body.draft_id is not None})
    try:
        await db.commit()
    except IntegrityError:
        return await _lost_race_or_conflict(db, principal, body)

    names = dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(user_ids)))).all())
    return {
        "id": report.id, "report_number": report.report_number,
        "equipment_id": equipment.id if equipment else None,
        "equipment_code": equipment.equipment_code if equipment else None,
        "group_id": group.id, "group_code": group.code, "report_type_id": rtype.id, "is_general": report.is_general, "event_datetime": report.event_datetime, "created_at": report.created_at,
        "description": report.description,
        "participants": [{"user_id": p.user_id, "full_name": names[p.user_id], "minutes": p.minutes}
                         for p in body.participants],
        "already_created": False,
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
