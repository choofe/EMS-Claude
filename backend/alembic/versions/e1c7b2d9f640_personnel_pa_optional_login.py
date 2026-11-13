"""personnel phase Pa: one users row per person, login profile optional (decision P1)

Revision ID: e1c7b2d9f640
Revises: d0b8c4f1a539
Create Date: 2026-11-11

users.username / hashed_password / role_id become NULLable, tied together by CHECK login_all_or_none (all set or none:
a person without a profile holds no role and cannot authenticate). New columns: first_name, last_name,
personnel_code (1-9999, unique among non-NULL), mobile (normalised 09xxxxxxxxx, unique among non-NULL),
login_enabled (existing rows: true). Existing users keep working untouched.
"""
from alembic import op
import sqlalchemy as sa

revision = "e1c7b2d9f640"
down_revision = "d0b8c4f1a539"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("first_name", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("last_name", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("personnel_code", sa.Integer(), nullable=True))
    op.add_column("users", sa.Column("mobile", sa.String(length=11), nullable=True))
    op.add_column("users", sa.Column("login_enabled", sa.Boolean(), server_default=sa.true(), nullable=False))
    op.alter_column("users", "username", existing_type=sa.String(length=64), nullable=True)
    op.alter_column("users", "hashed_password", existing_type=sa.String(length=255), nullable=True)
    op.alter_column("users", "role_id", existing_type=sa.Integer(), nullable=True)
    op.create_check_constraint(
        op.f("ck_users_login_all_or_none"), "users",
        sa.text("(username IS NULL AND hashed_password IS NULL AND role_id IS NULL)"
                " OR (username IS NOT NULL AND hashed_password IS NOT NULL AND role_id IS NOT NULL)"),
    )
    op.create_check_constraint(
        op.f("ck_users_login_enabled_needs_profile"), "users", sa.text("username IS NOT NULL OR NOT login_enabled"))
    op.create_check_constraint(
        op.f("ck_users_personnel_code_range"), "users",
        sa.text("personnel_code IS NULL OR (personnel_code BETWEEN 1 AND 9999)"))
    op.create_check_constraint(
        op.f("ck_users_mobile_format"), "users",
        sa.text("mobile IS NULL OR (length(mobile) = 11 AND substr(mobile, 1, 2) = '09' AND "
                + " AND ".join(f"substr(mobile, {i}, 1) IN ('0','1','2','3','4','5','6','7','8','9')"
                               for i in range(3, 12)) + ")"))
    op.create_index("uq_users_personnel_code", "users", ["personnel_code"], unique=True,
                    postgresql_where=sa.text("personnel_code IS NOT NULL"))
    op.create_index("uq_users_mobile", "users", ["mobile"], unique=True,
                    postgresql_where=sa.text("mobile IS NOT NULL"))


def downgrade() -> None:
    # Refuses (NOT NULL violation) while login-less people exist: data is never dropped silently.
    op.drop_index("uq_users_mobile", table_name="users")
    op.drop_index("uq_users_personnel_code", table_name="users")
    for name in ("mobile_format", "personnel_code_range", "login_enabled_needs_profile", "login_all_or_none"):
        op.drop_constraint(op.f(f"ck_users_{name}"), "users", type_="check")
    op.alter_column("users", "role_id", existing_type=sa.Integer(), nullable=False)
    op.alter_column("users", "hashed_password", existing_type=sa.String(length=255), nullable=False)
    op.alter_column("users", "username", existing_type=sa.String(length=64), nullable=False)
    for col in ("login_enabled", "mobile", "personnel_code", "last_name", "first_name"):
        op.drop_column("users", col)
