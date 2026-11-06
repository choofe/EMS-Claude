"""phase 6: report drafts + labor-row integrity

Revision ID: f6c3d9a7b104
Revises: e5b8a1c3f702
Create Date: 2026-10-16

Adds report_drafts (server-side autosaved form copies) and two integrity rules on report_participants:
one row per (report, user) and 0 < minutes <= 1440. Safe on existing data: no reports can exist before
Phase 6 (report creation did not exist), so the new constraints cannot be violated by old rows.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "f6c3d9a7b104"
down_revision = "e5b8a1c3f702"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "report_drafts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.String()), "postgresql"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_report_drafts_user_id_users"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_report_drafts")),
    )
    op.create_index(op.f("ix_report_drafts_user_id"), "report_drafts", ["user_id"], unique=False)
    op.create_unique_constraint(
        op.f("uq_report_participants_report_user"), "report_participants", ["report_id", "user_id"]
    )
    op.create_check_constraint(
        op.f("ck_report_participants_minutes_range"), "report_participants", sa.text("minutes > 0 AND minutes <= 1440")
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_report_participants_minutes_range"), "report_participants", type_="check")
    op.drop_constraint(op.f("uq_report_participants_report_user"), "report_participants", type_="unique")
    op.drop_index(op.f("ix_report_drafts_user_id"), table_name="report_drafts")
    op.drop_table("report_drafts")
