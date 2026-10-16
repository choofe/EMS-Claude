"""
One row per CONFIRMED equipment import (spec s.21 / Phase 5). Equipment created by the import carries
equipment.import_batch_id, so a mistaken import can be undone as a unit — but only while none of its
equipment has history (see services/equipment_import.undo_batch). The batch row itself is never deleted:
after an undo it stays as the record (undone_at / undone_by), next to the audit rows.

rejected_count is informational (rows the file contained that were NOT imported); the rejected rows
themselves are not stored — the manager gets the error report at import time.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class EquipmentImportBatch(Base):
    __tablename__ = "equipment_import_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="RESTRICT"), nullable=False, index=True)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    created_count: Mapped[int] = mapped_column(Integer, nullable=False)
    rejected_count: Mapped[int] = mapped_column(Integer, nullable=False)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    undone_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=True)

    group: Mapped["Group"] = relationship()
    creator: Mapped["User"] = relationship(foreign_keys=[created_by])
