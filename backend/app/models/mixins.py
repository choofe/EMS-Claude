# path: backend/app/models/mixins.py
"""
Shared column mixins.

TimestampMixin: created_at / updated_at present on every domain table.
created_at is set once by the DB (server_default=now()) and is NEVER
updated by the application afterwards for any table that also needs an
audit-safe creation record (reports rely on this for report_jalali_year
freezing — see reports.py). updated_at is bumped by the app on every
write.

SoftDeleteMixin: uniform is_active flag. Per spec section 26, nothing
with historical significance (users, groups, equipment, report_types,
reports) is ever physically deleted — only deactivated. Combined with
ON DELETE RESTRICT on every FK pointing at these tables, physical
deletion of anything with history is impossible at the DB level.

is_active also carries a DB-level server_default (true) so raw / bulk
INSERTs that bypass the ORM (e.g. the Phase 5 Excel import) cannot fail
with a NOT NULL violation just because the column was omitted.
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, func, true
from sqlalchemy.orm import Mapped, mapped_column


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class SoftDeleteMixin:
    is_active: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=true(), nullable=False
    )
