"""personnel phase Pb: per-manager state of the «users without a group» alert

Revision ID: f2d8c3a1b750
Revises: e1c7b2d9f640
Create Date: 2026-11-13

users.no_group_alert_dismissed_count: the number of people without a group at the moment this manager chose
«don't show again» (NULL = never dismissed). The alert is shown again when the current count is larger.
"""
from alembic import op
import sqlalchemy as sa

revision = "f2d8c3a1b750"
down_revision = "e1c7b2d9f640"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("no_group_alert_dismissed_count", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "no_group_alert_dismissed_count")
