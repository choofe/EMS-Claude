# path: backend/app/models/audit_log.py
"""
Append-only audit trail (spec section 25). Every report edit, every
equipment.group_id change (2026-09-27 decision — this is the "moved on
this date" record for equipment group reassignment; no separate
history table exists), every admin/import/config action must write a
row here. Never store passwords or secrets in metadata.

actor_id is nullable to allow system-initiated entries with no human
actor. metadata_json uses JSONB on Postgres (indexable, queryable) and
falls back to generic JSON on SQLite for local/dev testing.

A Postgres-level trigger blocking UPDATE/DELETE on this table has been
proposed (extra tamper-hardening) but is NOT yet confirmed as an MVP
requirement — left out of this migration pending Supervisor decision.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.db.base import Base

_JSONType = JSON().with_variant(JSONB(astext_type=String()), "postgresql")


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_entity", "entity_type", "entity_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    actor_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    metadata_json: Mapped[dict | None] = mapped_column(_JSONType, nullable=True)

    actor: Mapped["User | None"] = relationship()
