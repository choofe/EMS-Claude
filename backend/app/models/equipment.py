# path: backend/app/models/equipment.py
"""
Equipment (spec section 6). equipment_code is globally unique across
the whole organization (Phase 0 decision #1), entered mainly via Excel
import, and never changes.

group_id IS MUTABLE (2026-09-27 decision): equipment can be reassigned
to a different group. This is intentionally rare and Management-only
at the application layer, and every change MUST be written to
audit_logs (actor, timestamp, old_group, new_group) — that audit row
IS the "moved on this date" record; no separate history table exists
or is needed. See reports.py for why this is safe: reports.group_id is
an independent, creation-time-frozen snapshot, never re-derived from
equipment.group_id after the fact.
"""
from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.mixins import SoftDeleteMixin, TimestampMixin


class Equipment(TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "equipment"

    id: Mapped[int] = mapped_column(primary_key=True)
    equipment_code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    group_id: Mapped[int] = mapped_column(
        ForeignKey("groups.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    group: Mapped["Group"] = relationship(back_populates="equipment")
    reports: Mapped[list["Report"]] = relationship(back_populates="equipment")
