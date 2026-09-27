# path: backend/app/models/system_setting.py
"""
Key-value runtime settings (e.g. REPORT_EDIT_WINDOW_HOURS, spec
section 18), so adding a new configurable setting later never needs a
schema migration — only a new row. value is stored as text; callers
parse to the expected type (int/bool/etc.) at the point of use.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    updated_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )

    updater: Mapped["User | None"] = relationship()
