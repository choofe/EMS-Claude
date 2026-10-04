"""
Query-level authorization. THE one place that turns a Principal's scope into
SQL filters — endpoints and services must route every report / participant /
equipment query through these helpers instead of writing their own WHERE
clauses, so a scope bug can only exist (and be fixed) here.

Rules baked in:
  * Report visibility/analytics/export/edit is by reports.group_id (frozen at
    creation), never equipment.group_id.
  * Labor rows (report_participants) are filtered through their PARENT report:
    a USER (scope OWN) only ever sees participant rows of reports they
    created, whoever the hours were logged for (Phase 0 decision #4).
  * Equipment is the one thing scoped by its CURRENT group (equipment.group_id).
  * Scope NONE -> no rows (fail closed).
"""
from typing import Any

from sqlalchemy import Select, false, select

from app.core.permissions import Capability, Principal, Scope
from app.models.equipment import Equipment
from app.models.report import Report
from app.models.report_participant import ReportParticipant


def apply_report_scope(
    stmt: Select, principal: Principal, capability: Capability, entity: Any = Report
) -> Select:
    """`stmt` must select from `entity` — Report by default; pass the alias
    (`aliased(Report)`) when the query uses one, otherwise the filter would attach to a
    different FROM element and silently not restrict the aliased rows."""
    scope = principal.scope(capability)
    if scope is Scope.ALL:
        return stmt
    if scope is Scope.GROUPS:
        return stmt.where(entity.group_id.in_(sorted(principal.group_ids)))
    if scope is Scope.OWN:
        return stmt.where(entity.created_by == principal.user_id)
    return stmt.where(false())


def apply_participant_scope(
    stmt: Select, principal: Principal, capability: Capability = Capability.LABOR_VIEW
) -> Select:
    """`stmt` must select from ReportParticipant. Works regardless of the caller's own joins."""
    visible_reports = apply_report_scope(select(Report.id), principal, capability)
    return stmt.where(ReportParticipant.report_id.in_(visible_reports))


def apply_equipment_scope(
    stmt: Select, principal: Principal, capability: Capability = Capability.EQUIPMENT_VIEW
) -> Select:
    """`stmt` must select from Equipment."""
    scope = principal.scope(capability)
    if scope is Scope.ALL:
        return stmt
    if scope is Scope.GROUPS:
        return stmt.where(Equipment.group_id.in_(sorted(principal.group_ids)))
    return stmt.where(false())
