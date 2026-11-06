"""
Server-side report drafts (Phase 6, approved 2026-10-14 / 2026-10-16).

A draft is a user's private scratch copy of the report form, autosaved while they type. It is NOT a report:
it has no number, is never counted by analytics/export, and is never visible to anyone but its owner. It is
hard-deleted when the report is submitted from it (or when the owner discards it) — the one place besides
import-undo where physical deletion is intended, because a draft carries no history.

`payload` holds the raw form values (ids and text only). Nothing in it is trusted: submitting a report
re-validates every field (equipment scope, active type, participants, ...) exactly as if no draft existed.

A user holds at most ONE draft (2026-10-22 decision, enforced in the service under a user-row lock, not by a unique
constraint, so lifting the limit later needs no migration).

`version` is an optimistic-lock counter: a save must quote the version it last saw, so two open tabs cannot
silently overwrite each other.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.db.base import Base

_JSONType = JSON().with_variant(JSONB(astext_type=String()), "postgresql")


class ReportDraft(Base):
    __tablename__ = "report_drafts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    payload: Mapped[dict] = mapped_column(_JSONType, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    owner: Mapped["User"] = relationship()
