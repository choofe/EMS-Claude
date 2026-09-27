# path: backend/app/models/report_sequence.py
"""
Backs report numbering (spec section 16): format YY-GROUPCODE-NNN,
one counter per (group_id, jalali_year). Deleted reports never cause
reuse — this table only ever counts up.

Concurrency (implemented in Phase 6, not here): the counter is
incremented with a single atomic statement inside the report-creation
transaction —

    UPDATE report_sequences
    SET last_number = last_number + 1
    WHERE group_id = :group_id AND jalali_year = :jalali_year
    RETURNING last_number

(inserting the row first with last_number=0 if it doesn't exist yet).
Postgres row-level locking on the UPDATE makes concurrent report
creation safe without any explicit application-level lock.
"""
from sqlalchemy import ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class ReportSequence(Base):
    __tablename__ = "report_sequences"
    __table_args__ = (
        UniqueConstraint("group_id", "jalali_year", name="uq_report_sequences_group_year"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(
        ForeignKey("groups.id", ondelete="RESTRICT"), nullable=False
    )
    jalali_year: Mapped[int] = mapped_column(Integer, nullable=False)
    last_number: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    group: Mapped["Group"] = relationship()
