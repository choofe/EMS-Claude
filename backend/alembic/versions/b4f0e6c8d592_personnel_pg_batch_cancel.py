"""personnel phase Pg: batch kind and removed count

Revision ID: b4f0e6c8d592
Revises: a3e9d5b7c481
Create Date: 2026-11-17

Adds personnel_import_batches.kind (always PERSONNEL for now; lets the equipment import share the import history
later) and removed_count (people removed by cancels so far). Existing rows get PERSONNEL and 0.
"""
from alembic import op
import sqlalchemy as sa

revision = "b4f0e6c8d592"
down_revision = "a3e9d5b7c481"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("personnel_import_batches") as batch:
        batch.add_column(sa.Column("kind", sa.String(length=16), server_default="PERSONNEL", nullable=False))
        batch.add_column(sa.Column("removed_count", sa.Integer(), server_default="0", nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("personnel_import_batches") as batch:
        batch.drop_column("removed_count")
        batch.drop_column("kind")
