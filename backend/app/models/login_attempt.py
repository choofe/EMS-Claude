"""
Login attempt log (Phase 3) backing username-based lockout.

`username` is whatever was typed (truncated to the column size), whether or
not such a user exists — counting attempts for non-existent names too is what
keeps lockout behaviour identical for real and fake accounts (no username
enumeration). No password or token is ever stored here.
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    __table_args__ = (
        Index("ix_login_attempts_username_attempted_at", "username", "attempted_at"),
        Index("ix_login_attempts_ip_attempted_at", "ip", "attempted_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    attempted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
