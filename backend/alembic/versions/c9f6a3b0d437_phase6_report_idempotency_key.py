"""phase 6: idempotency key for report creation

Revision ID: c9f6a3b0d437
Revises: b8e5f2a9c326
Create Date: 2026-10-24

reports.client_request_id (nullable) + UNIQUE(created_by, client_request_id): a retried submission carrying the same key
returns the report it already created instead of making a second one (and doubling labor hours). NULLs do not collide.
"""
from alembic import op
import sqlalchemy as sa

revision = "c9f6a3b0d437"
down_revision = "b8e5f2a9c326"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reports", sa.Column("client_request_id", sa.String(length=64), nullable=True))
    op.create_unique_constraint(op.f("uq_reports_created_by_client_request_id"), "reports", ["created_by", "client_request_id"])


def downgrade() -> None:
    op.drop_constraint(op.f("uq_reports_created_by_client_request_id"), "reports", type_="unique")
    op.drop_column("reports", "client_request_id")
