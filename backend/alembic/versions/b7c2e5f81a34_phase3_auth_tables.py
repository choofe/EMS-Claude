"""phase 3: refresh_tokens, login_attempts, users.must_change_password

Revision ID: b7c2e5f81a34
Revises: a3f1c9d47b20
Create Date: 2026-10-03

Adds the storage for authentication (Phase 3):
  * refresh_tokens   — hashed, rotating refresh tokens grouped by family
  * login_attempts   — per-username attempt log used for lockout
  * users.must_change_password — forced password change flag (default false)
Existing rows are unaffected (the new column has a server default).
"""
from alembic import op
import sqlalchemy as sa

revision = "b7c2e5f81a34"
down_revision = "a3f1c9d47b20"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("must_change_password", sa.Boolean(), server_default=sa.false(), nullable=False),
    )

    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("family_id", sa.String(length=32), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_refresh_tokens_user_id_users"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_refresh_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_refresh_tokens_token_hash")),
    )
    op.create_index(op.f("ix_refresh_tokens_user_id"), "refresh_tokens", ["user_id"], unique=False)
    op.create_index(op.f("ix_refresh_tokens_family_id"), "refresh_tokens", ["family_id"], unique=False)

    op.create_table(
        "login_attempts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("ip", sa.String(length=45), nullable=True),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("attempted_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_login_attempts")),
    )
    op.create_index("ix_login_attempts_username_attempted_at", "login_attempts", ["username", "attempted_at"], unique=False)
    op.create_index("ix_login_attempts_ip_attempted_at", "login_attempts", ["ip", "attempted_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_login_attempts_ip_attempted_at", table_name="login_attempts")
    op.drop_index("ix_login_attempts_username_attempted_at", table_name="login_attempts")
    op.drop_table("login_attempts")
    op.drop_index(op.f("ix_refresh_tokens_family_id"), table_name="refresh_tokens")
    op.drop_index(op.f("ix_refresh_tokens_user_id"), table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
    op.drop_column("users", "must_change_password")
