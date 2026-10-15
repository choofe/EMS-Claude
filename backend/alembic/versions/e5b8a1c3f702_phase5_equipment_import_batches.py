"""phase 5: equipment import batches (undoable Excel imports)

Revision ID: e5b8a1c3f702
Revises: c4a9d7e2b610
Create Date: 2026-10-15

Adds equipment_import_batches (one row per confirmed import) and equipment.import_batch_id (NULL for
equipment created any other way). No data is changed.
"""
from alembic import op
import sqlalchemy as sa

revision = "e5b8a1c3f702"
down_revision = "c4a9d7e2b610"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "equipment_import_batches",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("file_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("created_count", sa.Integer(), nullable=False),
        sa.Column("rejected_count", sa.Integer(), nullable=False),
        sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("undone_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], name=op.f("fk_equipment_import_batches_group_id_groups"), ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], name=op.f("fk_equipment_import_batches_created_by_users"), ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["undone_by"], ["users.id"], name=op.f("fk_equipment_import_batches_undone_by_users"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_equipment_import_batches")),
    )
    op.create_index(op.f("ix_equipment_import_batches_group_id"), "equipment_import_batches", ["group_id"], unique=False)
    op.add_column("equipment", sa.Column("import_batch_id", sa.Integer(), nullable=True))
    op.create_index(op.f("ix_equipment_import_batch_id"), "equipment", ["import_batch_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_equipment_import_batch_id_equipment_import_batches"),
        "equipment", "equipment_import_batches", ["import_batch_id"], ["id"], ondelete="RESTRICT",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_equipment_import_batch_id_equipment_import_batches"), "equipment", type_="foreignkey")
    op.drop_index(op.f("ix_equipment_import_batch_id"), table_name="equipment")
    op.drop_column("equipment", "import_batch_id")
    op.drop_index(op.f("ix_equipment_import_batches_group_id"), table_name="equipment_import_batches")
    op.drop_table("equipment_import_batches")
