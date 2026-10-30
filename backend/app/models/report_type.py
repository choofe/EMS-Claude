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
from sqlalchemy import Boolean, CheckConstraint, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.mixins import SoftDeleteMixin, TimestampMixin


class ReportType(TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "report_types"
    __table_args__ = (
        CheckConstraint("code = upper(code)", name="code_uppercase"),
        CheckConstraint("labor_mode IN ('REQUIRED', 'OPTIONAL', 'NONE')", name="labor_mode_valid"),
        CheckConstraint("equipment_mode IN ('REQUIRED', 'OPTIONAL', 'NONE')", name="equipment_mode_valid"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name_fa: Mapped[str] = mapped_column(String(128), nullable=False)
    is_failure: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Labor hours and equipment follow ONE rule set (2026-10-22), per report type:
    #   REQUIRED - must be provided (labor: >=1 participant, the form pre-fills the author with DEFAULT_LABOR_MINUTES)
    #   OPTIONAL - not shown at first; the author may add it on request (button). Server rule: may be omitted.
    #   NONE     - cannot be added at all; the server rejects it.
    # Reports whose equipment_mode is not REQUIRED are "general" reports (letter-like: spare-part request, failure warning,
    # detailed analysis): an explicit in-scope group is required when no equipment is given; reports.is_general is the snapshot.
    labor_mode: Mapped[str] = mapped_column(String(16), default="REQUIRED", server_default="REQUIRED", nullable=False)
    equipment_mode: Mapped[str] = mapped_column(String(16), default="REQUIRED", server_default="REQUIRED", nullable=False)
    # Short management-written guide shown behind the «؟» next to the type in the entry form.
    help_fa: Mapped[str | None] = mapped_column(String(300), nullable=True)

    reports: Mapped[list["Report"]] = relationship(back_populates="report_type")
