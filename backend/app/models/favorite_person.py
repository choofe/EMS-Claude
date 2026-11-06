"""
Favorite people (Phase 6d, approved 2026-11-01): a user's private, starred shortlist of colleagues for the
report-entry person picker. It is a personal convenience, NOT history: rows are hard-deleted when un-starred, are
never audited, never counted by analytics/export and never visible to anyone but the owner.

Nothing here grants access to anybody: every use re-applies the participant-eligibility rule (`participant_filter`) for
the report's group, and every insert checks eligibility at star time, so a stale row can never put an ineligible
person on a report or reveal a name.

`user_report_preferences` keeps the one setting that must follow the user across devices (the picker's
"favorites only" switch); one row per user, created on first change.
"""
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, false, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class FavoritePerson(Base):
    __tablename__ = "favorite_people"
    __table_args__ = (CheckConstraint("owner_id <> favorite_user_id", name="not_self"),)

    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True)
    favorite_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class UserReportPreference(Base):
    __tablename__ = "user_report_preferences"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True)
    favorites_only: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
