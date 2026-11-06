"""phase 6: three modes for labor AND equipment, report-type help text

Revision ID: b8e5f2a9c326
Revises: a7d4e1b8c215
Create Date: 2026-10-22

Labor and equipment now follow one rule set per report type: REQUIRED / OPTIONAL (added on request) / NONE.
- labor_mode: ON_REQUEST is merged into OPTIONAL (they were the same server rule).
- equipment_required (bool) is replaced by equipment_mode: true -> REQUIRED, false -> OPTIONAL (general types keep
  working exactly as before; NONE is new).
- report_types.help_fa: short guide shown behind the «؟» in the entry form.
Existing reports are untouched (reports.is_general is a snapshot).
"""
from alembic import op
import sqlalchemy as sa

revision = "b8e5f2a9c326"
down_revision = "a7d4e1b8c215"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_report_types_labor_mode_valid"), "report_types", type_="check")
    op.execute("UPDATE report_types SET labor_mode = 'OPTIONAL' WHERE labor_mode = 'ON_REQUEST'")
    op.create_check_constraint(
        op.f("ck_report_types_labor_mode_valid"), "report_types", sa.text("labor_mode IN ('REQUIRED', 'OPTIONAL', 'NONE')")
    )
    op.add_column("report_types", sa.Column("equipment_mode", sa.String(length=16), server_default="REQUIRED", nullable=False))
    op.execute("UPDATE report_types SET equipment_mode = CASE WHEN equipment_required THEN 'REQUIRED' ELSE 'OPTIONAL' END")
    op.create_check_constraint(
        op.f("ck_report_types_equipment_mode_valid"), "report_types", sa.text("equipment_mode IN ('REQUIRED', 'OPTIONAL', 'NONE')")
    )
    op.drop_column("report_types", "equipment_required")
    op.add_column("report_types", sa.Column("help_fa", sa.String(length=300), nullable=True))


def downgrade() -> None:
    op.drop_column("report_types", "help_fa")
    op.add_column("report_types", sa.Column("equipment_required", sa.Boolean(), server_default=sa.true(), nullable=False))
    op.execute("UPDATE report_types SET equipment_required = (equipment_mode = 'REQUIRED')")
    op.drop_constraint(op.f("ck_report_types_equipment_mode_valid"), "report_types", type_="check")
    op.drop_column("report_types", "equipment_mode")
    op.drop_constraint(op.f("ck_report_types_labor_mode_valid"), "report_types", type_="check")
    op.create_check_constraint(
        op.f("ck_report_types_labor_mode_valid"), "report_types",
        sa.text("labor_mode IN ('REQUIRED', 'OPTIONAL', 'ON_REQUEST', 'NONE')"),
    )
