# path: backend/app/models/role.py
"""
Roles are DB-driven (spec section 4 + Phase 0 decision #9 on AUDITOR),
not a hard-coded enum, so a role's Persian display label can be edited
without a code change/redeploy. The role CODE (used everywhere in
permission-check logic) is a stable machine-readable string and is
never surfaced to end users directly — only label_fa is shown in UI.

Seed data (inserted by the migration's data step, not hard-coded in
application logic): USER, EXPERT, MANAGEMENT, AUDITOR ("بازرس ارشد").
"""
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.mixins import TimestampMixin


class Role(TimestampMixin, Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    label_fa: Mapped[str] = mapped_column(String(64), nullable=False)

    users: Mapped[list["User"]] = relationship(back_populates="role")
