"""
Users are never physically deleted (spec section 26 — a deactivated
user must not break historical reports still pointing at them via
created_by / report_participants.user_id), hence SoftDeleteMixin
instead of a DELETE path.

Password hashing (Argon2id) and auth/session logic live in
app.core.security / app.services.auth_service (Phase 3) — this model only
defines the storage shape.

must_change_password: when true the account may only change its password
or log out (enforced in the API dependency layer, not the frontend). Set by
the "force password change" admin action, an admin password reset, or
automatically at login when the password no longer satisfies the current
password policy.
"""
from sqlalchemy import Boolean, ForeignKey, String, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.mixins import SoftDeleteMixin, TimestampMixin


class User(TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(128), nullable=False)
    role_id: Mapped[int] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), nullable=False
    )
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )

    role: Mapped["Role"] = relationship(back_populates="users")
    group_memberships: Mapped[list["UserGroup"]] = relationship(back_populates="user")
