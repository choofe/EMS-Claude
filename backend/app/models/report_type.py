# path: backend/app/models/report_type.py
"""
Report types are DB-driven (spec section 13), Management can add/edit/
deactivate. is_failure is a structured flag, not text-sniffing (spec
section 23: "Do NOT attempt to determine failures by searching
arbitrary text") — failure analytics filters on this column.

Deactivating a type must not break historical reports that used it
(spec section 13's "remain understandable") — hence SoftDeleteMixin
instead of delete, and reports.report_type_id uses ON DELETE RESTRICT.

Seed data (migration data step): Minor Failure Repair (is_failure=True),
Major Failure Repair (is_failure=True), Periodic Service
(is_failure=False), Inspection / Visit (is_failure=False).
"""
from sqlalchemy import true as sa_true
from sqlalchemy import Boolean, CheckConstraint, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.mixins import SoftDeleteMixin, TimestampMixin


class ReportType(TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "report_types"
    __table_args__ = (
        CheckConstraint("code = upper(code)", name="code_uppercase"),
        CheckConstraint("labor_mode IN ('REQUIRED', 'OPTIONAL', 'ON_REQUEST', 'NONE')", name="labor_mode_valid"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name_fa: Mapped[str] = mapped_column(String(128), nullable=False)
    is_failure: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # How labor hours are handled for reports of this type (Phase 6, 2026-10-16):
    #   REQUIRED   - at least one participant with minutes (the form pre-fills the author with DEFAULT_LABOR_MINUTES)
    #   OPTIONAL   - labor section is shown, may be left empty
    #   ON_REQUEST - section hidden behind an "add people's hours - optional" button; server rule = OPTIONAL
    #   NONE       - no labor at all; the server rejects participants
    labor_mode: Mapped[str] = mapped_column(String(16), default="REQUIRED", server_default="REQUIRED", nullable=False)
    # False = "general" report (letter-like: spare-part request, failure warning, detailed analysis): equipment may
    # be omitted, the group must then be chosen explicitly. Reports of such a type are flagged reports.is_general.
    equipment_required: Mapped[bool] = mapped_column(Boolean, default=True, server_default=sa_true(), nullable=False)

    reports: Mapped[list["Report"]] = relationship(back_populates="report_type")
