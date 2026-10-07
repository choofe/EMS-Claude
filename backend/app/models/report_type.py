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
    __table_args__ = (CheckConstraint("code = upper(code)", name="code_uppercase"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name_fa: Mapped[str] = mapped_column(String(128), nullable=False)
    is_failure: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    reports: Mapped[list["Report"]] = relationship(back_populates="report_type")
