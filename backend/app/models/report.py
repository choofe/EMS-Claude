# path: backend/app/models/report.py
"""
Core report record (spec sections 14, 16, 17; Phase 0 decision #6;
2026-09-27 schema decisions).

Two independently-tracked timestamps, per spec section 17:
  - event_datetime: user-declared, WHEN the maintenance actually
    happened. Editable — USER within the configured edit window
    (system_settings), EXPERT/MANAGEMENT unlimited (Phase 0 #5) — but
    editing it never touches report_jalali_year (see below).
  - created_at (from TimestampMixin): the real system-clock moment the
    row was inserted. Has NO update path anywhere in the application —
    not exposed on any edit form or API field. Protected for both
    security and future audit purposes (know exactly when a report was
    actually filed).

report_jalali_year is derived from created_at and frozen at INSERT
time (set by application code in the Phase 6 create-report service,
not a DB trigger, since jdatetime conversion lives in Python). It is
never recomputed even if event_datetime is later edited into a
different year — a report's number must not become inconsistent
after the fact.

group_id is an independent snapshot of equipment.group_id taken at
creation time, then frozen forever — NOT re-derived if the equipment
is later reassigned to a different group. This is what makes
group-scoped visibility "just work" for equipment that changes groups
(2026-09-27 decision, see equipment.py): all authorization / analytics
/ history queries scoped by group MUST filter on reports.group_id,
never on equipment.group_id.

is_locked / locked_at / locked_by: Phase 0 decision #6. Once locked,
the report is frozen against ALL edits, including Management's, until
an explicit "unlock" action — implemented (Phase 7) as its own audited
operation, not by clearing these columns directly from an edit form.

is_active: soft delete (Management-only, Phase 7). ON DELETE RESTRICT
everywhere means a report can never be physically removed while any
report_participants / audit_logs rows still reference it.
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.mixins import SoftDeleteMixin, TimestampMixin


class Report(TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    report_number: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)

    equipment_id: Mapped[int] = mapped_column(
        ForeignKey("equipment.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # Frozen snapshot at creation time — see module docstring. Independent
    # of equipment.group_id, which may change later.
    group_id: Mapped[int] = mapped_column(
        ForeignKey("groups.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    report_type_id: Mapped[int] = mapped_column(
        ForeignKey("report_types.id", ondelete="RESTRICT"), nullable=False
    )

    event_datetime: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    # Frozen at creation from created_at's Jalali year — never recomputed.
    report_jalali_year: Mapped[int] = mapped_column(Integer, nullable=False)

    created_by: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    description: Mapped[str] = mapped_column(Text, nullable=False)

    is_locked: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    locked_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )

    equipment: Mapped["Equipment"] = relationship(back_populates="reports")
    group: Mapped["Group"] = relationship(foreign_keys=[group_id])
    report_type: Mapped["ReportType"] = relationship(back_populates="reports")
    creator: Mapped["User"] = relationship(foreign_keys=[created_by])
    locker: Mapped["User | None"] = relationship(foreign_keys=[locked_by])
    participants: Mapped[list["ReportParticipant"]] = relationship(back_populates="report")
