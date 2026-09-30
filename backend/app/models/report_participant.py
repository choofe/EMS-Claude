# path: backend/app/models/report_participant.py
"""
Labor-hour records (spec section 15). One relational row per
participant per report — never a packed text field. Duration is
stored as integer minutes (not float hours) to avoid floating-point
rounding in aggregation; the UI formats minutes into "1h", "2h 30m".

Visibility rule (Phase 0 decision #4, enforced in the API layer, not
here): a USER may only query rows where the PARENT report's
created_by = themselves, regardless of which user_id the hours were
logged for. EXPERT/MANAGEMENT can aggregate by user_id across all
reports in their scope.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class ReportParticipant(Base):
    __tablename__ = "report_participants"

    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    report: Mapped["Report"] = relationship(back_populates="participants")
    user: Mapped["User"] = relationship()
