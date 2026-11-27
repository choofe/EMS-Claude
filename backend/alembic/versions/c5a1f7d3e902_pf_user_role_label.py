"""personnel phase Pf: display label of the USER role

Revision ID: c5a1f7d3e902
Revises: b4f0e6c8d592
Create Date: 2026-11-27

Data only: roles.label_fa of USER becomes «تکنسین کاربر» (design of 2026-11-23). The role CODE and every
permission are unchanged; no role is added.
"""
from alembic import op

revision = "c5a1f7d3e902"
down_revision = "b4f0e6c8d592"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE roles SET label_fa = 'تکنسین کاربر' WHERE code = 'USER'")


def downgrade() -> None:
    op.execute("UPDATE roles SET label_fa = 'کاربر' WHERE code = 'USER'")
