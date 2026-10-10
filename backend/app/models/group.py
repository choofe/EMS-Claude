# path: backend/app/models/group.py
"""
Equipment/maintenance category (spec section 5). code is the short
uppercase identifier used inside report numbers (e.g. ELV, ESC, DOOR).
"""
from sqlalchemy import CheckConstraint, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.mixins import SoftDeleteMixin, TimestampMixin


class Group(TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "groups"
    __table_args__ = (CheckConstraint("code = upper(code)", name="code_uppercase"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    equipment: Mapped[list["Equipment"]] = relationship(back_populates="group")
    user_memberships: Mapped[list["UserGroup"]] = relationship(back_populates="group")
