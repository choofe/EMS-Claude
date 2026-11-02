"""phase 6d: favorite people + per-user picker preference

Revision ID: d0b8c4f1a539
Revises: c9f6a3b0d437
Create Date: 2026-11-01

favorite_people: a user's private starred colleagues (composite PK, no self-star). user_report_preferences: the
picker's "favorites only" switch, stored server-side so it follows the user across devices. Purely additive; no
existing data is touched.
"""
from alembic import op
import sqlalchemy as sa

revision = "d0b8c4f1a539"
down_revision = "c9f6a3b0d437"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "favorite_people",
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("favorite_user_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint("owner_id <> favorite_user_id", name=op.f("ck_favorite_people_not_self")),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], name=op.f("fk_favorite_people_owner_id_users"), ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["favorite_user_id"], ["users.id"], name=op.f("fk_favorite_people_favorite_user_id_users"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("owner_id", "favorite_user_id", name=op.f("pk_favorite_people")),
    )
    op.create_table(
        "user_report_preferences",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("favorites_only", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_user_report_preferences_user_id_users"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_user_report_preferences")),
    )


def downgrade() -> None:
    op.drop_table("user_report_preferences")
    op.drop_table("favorite_people")
