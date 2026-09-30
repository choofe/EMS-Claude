# path: backend/app/models/user.py
"""
Users are never physically deleted (spec section 26 — a deactivated
user must not break historical reports still pointing at them via
created_by / report_participants.user_id), hence SoftDeleteMixin
instead of a DELETE path.

Password hashing (argon2) and auth/session logic are Phase 3 work —
this model only defines the storage shape.
"""
from sqlalchemy import ForeignKey, String
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

    role: Mapped["Role"] = relationship(back_populates="users")
    group_memberships: Mapped[list["UserGroup"]] = relationship(back_populates="user")
