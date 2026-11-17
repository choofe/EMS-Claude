"""personnel phase Pd: personnel import batches

Revision ID: a3e9d5b7c481
Revises: f2d8c3a1b750
Create Date: 2026-11-16

Adds personnel_import_batches (one row per confirmed personnel import) and users.import_batch_id (NULL for
people created any other way). No data is changed.
"""
from alembic import op
import sqlalchemy as sa

revision = "a3e9d5b7c481"
down_revision = "f2d8c3a1b750"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "personnel_import_batches",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("file_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("created_count", sa.Integer(), nullable=False),
        sa.Column("rejected_count", sa.Integer(), nullable=False),
        sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("undone_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], name=op.f("fk_personnel_import_batches_created_by_users"), ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["undone_by"], ["users.id"], name=op.f("fk_personnel_import_batches_undone_by_users"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_personnel_import_batches")),
    )
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("import_batch_id", sa.Integer(), nullable=True))
        batch.create_index(op.f("ix_users_import_batch_id"), ["import_batch_id"], unique=False)
        batch.create_foreign_key(
            "fk_users_import_batch_id_personnel_import_batches", "personnel_import_batches", ["import_batch_id"], ["id"],
            ondelete="RESTRICT",
        )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.drop_constraint("fk_users_import_batch_id_personnel_import_batches", type_="foreignkey")
        batch.drop_index(op.f("ix_users_import_batch_id"))
        batch.drop_column("import_batch_id")
    op.drop_table("personnel_import_batches")
