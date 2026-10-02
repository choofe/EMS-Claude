"""add DB-level server defaults for is_active and is_locked

Revision ID: a3f1c9d47b20
Revises: d522c7da2351
Create Date: 2026-09-30

Why: is_active / is_locked were NOT NULL with only an ORM-side default,
so any INSERT that bypasses the ORM (raw SQL, bulk import, manual fixes)
had to supply them explicitly or fail. The database now supplies the
defaults itself: is_active = true, is_locked = false.

Existing rows are unaffected (a server default only applies to future
INSERTs that omit the column).
"""
from alembic import op
import sqlalchemy as sa

revision = "a3f1c9d47b20"
down_revision = "d522c7da2351"
branch_labels = None
depends_on = None

_SOFT_DELETE_TABLES = ("groups", "report_types", "equipment", "users", "reports")


def upgrade() -> None:
    for table in _SOFT_DELETE_TABLES:
        op.alter_column(
            table,
            "is_active",
            existing_type=sa.Boolean(),
            existing_nullable=False,
            server_default=sa.true(),
        )
    op.alter_column(
        "reports",
        "is_locked",
        existing_type=sa.Boolean(),
        existing_nullable=False,
        server_default=sa.false(),
    )


def downgrade() -> None:
    op.alter_column(
        "reports",
        "is_locked",
        existing_type=sa.Boolean(),
        existing_nullable=False,
        server_default=None,
    )
    for table in reversed(_SOFT_DELETE_TABLES):
        op.alter_column(
            table,
            "is_active",
            existing_type=sa.Boolean(),
            existing_nullable=False,
            server_default=None,
        )
