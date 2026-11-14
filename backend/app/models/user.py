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
from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, Integer, String, false, text, true
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.mixins import SoftDeleteMixin, TimestampMixin


# Canonical stored mobile: 09 + nine ASCII digits. Written with substr/IN only so it means the same on SQLite and
# PostgreSQL (no regex/GLOB); the migration carries its own copy of this text.
MOBILE_CHECK = ("mobile IS NULL OR (length(mobile) = 11 AND substr(mobile, 1, 2) = '09' AND "
                + " AND ".join(f"substr(mobile, {i}, 1) IN ('0','1','2','3','4','5','6','7','8','9')" for i in range(3, 12))
                + ")")


class User(TimestampMixin, SoftDeleteMixin, Base):
    """One row per PERSON (decision P1, personnel phase). A person may have no login profile: then `username`,
    `hashed_password` and `role_id` are all NULL (CHECK `login_all_or_none`), the row holds no role and therefore no
    capability, and it can never authenticate. `is_active` means "the person is active"; `login_enabled` means
    "the profile may sign in". Signing in needs credentials AND login_enabled AND is_active (auth_service)."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("username = lower(username)", name="username_lowercase"),
        CheckConstraint(
            "(username IS NULL AND hashed_password IS NULL AND role_id IS NULL)"
            " OR (username IS NOT NULL AND hashed_password IS NOT NULL AND role_id IS NOT NULL)",
            name="login_all_or_none",
        ),
        CheckConstraint("username IS NOT NULL OR NOT login_enabled", name="login_enabled_needs_profile"),
        CheckConstraint("personnel_code IS NULL OR (personnel_code BETWEEN 1 AND 9999)", name="personnel_code_range"),
        CheckConstraint(MOBILE_CHECK, name="mobile_format"),
        Index("uq_users_personnel_code", "personnel_code", unique=True,
              postgresql_where=text("personnel_code IS NOT NULL"), sqlite_where=text("personnel_code IS NOT NULL")),
        Index("uq_users_mobile", "mobile", unique=True,
              postgresql_where=text("mobile IS NOT NULL"), sqlite_where=text("mobile IS NOT NULL")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    hashed_password: Mapped[str | None] = mapped_column(String(255), nullable=True)
    full_name: Mapped[str] = mapped_column(String(128), nullable=False)
    first_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    personnel_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mobile: Mapped[str | None] = mapped_column(String(11), nullable=True)  # normalised 09xxxxxxxxx
    role_id: Mapped[int | None] = mapped_column(ForeignKey("roles.id", ondelete="RESTRICT"), nullable=True)
    # Manager-only UI state: how many people had no group when «don't show again» was chosen (NULL = never).
    no_group_alert_dismissed_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    login_enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true(), nullable=False)
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )

    role: Mapped["Role | None"] = relationship(back_populates="users")
    group_memberships: Mapped[list["UserGroup"]] = relationship(back_populates="user")
