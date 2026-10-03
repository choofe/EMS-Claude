"""
Refresh tokens (Phase 3). The raw token is a random opaque string handed to
the client in an HttpOnly cookie; only its SHA-256 hash is stored, so a
database leak does not yield usable tokens.

Rotation: every successful /auth/refresh marks the presented row as used
(used_at) and inserts a new row in the same family_id. Presenting a token
that is already used or revoked is treated as theft/replay: the whole family
is revoked. Logout and password change revoke too. Rows are never deleted
here (they double as a security trail); a purge job can come later.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    family_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
