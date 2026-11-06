"""phase 6: report-type labor_mode / equipment_required, general reports

Revision ID: a7d4e1b8c215
Revises: f6c3d9a7b104
Create Date: 2026-10-17

report_types.labor_mode (REQUIRED|OPTIONAL|ON_REQUEST|NONE) and report_types.equipment_required; reports.equipment_id
becomes nullable and reports.is_general is added, tied together by CHECK (equipment_id IS NOT NULL OR is_general) so
a report can only lack equipment when it was filed as a general report. Existing rows keep today's behaviour
(labor REQUIRED, equipment required, is_general false).
"""
from alembic import op
import sqlalchemy as sa

revision = "a7d4e1b8c215"
down_revision = "f6c3d9a7b104"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("report_types", sa.Column("labor_mode", sa.String(length=16), server_default="REQUIRED", nullable=False))
    op.add_column("report_types", sa.Column("equipment_required", sa.Boolean(), server_default=sa.true(), nullable=False))
    op.create_check_constraint(
        op.f("ck_report_types_labor_mode_valid"), "report_types",
        sa.text("labor_mode IN ('REQUIRED', 'OPTIONAL', 'ON_REQUEST', 'NONE')"),
    )
    op.add_column("reports", sa.Column("is_general", sa.Boolean(), server_default=sa.false(), nullable=False))
    op.alter_column("reports", "equipment_id", existing_type=sa.Integer(), nullable=True)
    op.create_check_constraint(
        op.f("ck_reports_equipment_or_general"), "reports", sa.text("equipment_id IS NOT NULL OR is_general")
    )


def downgrade() -> None:
    # Refuses (NOT NULL violation) if general reports without equipment exist: data is never dropped silently.
    op.drop_constraint(op.f("ck_reports_equipment_or_general"), "reports", type_="check")
    op.alter_column("reports", "equipment_id", existing_type=sa.Integer(), nullable=False)
    op.drop_column("reports", "is_general")
    op.drop_constraint(op.f("ck_report_types_labor_mode_valid"), "report_types", type_="check")
    op.drop_column("report_types", "equipment_required")
    op.drop_column("report_types", "labor_mode")
