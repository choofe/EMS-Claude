"""phase 4: canonical identifier forms (username lower, codes upper) + CHECK constraints

Revision ID: c4a9d7e2b610
Revises: b7c2e5f81a34
Create Date: 2026-10-04

Existing rows are normalised first (users.username -> lower, equipment/group/report-type codes ->
upper). If two rows would collapse into the same value the migration STOPS with a clear message
instead of silently merging/overwriting anything. Then CHECK constraints make the canonical form a
database-level invariant.
"""
from alembic import op
import sqlalchemy as sa

revision = "c4a9d7e2b610"
down_revision = "b7c2e5f81a34"
branch_labels = None
depends_on = None

# (table, column, normaliser, constraint name)  — all identifiers are constants, never user input
_TARGETS = (
    ("users", "username", "lower", "ck_users_username_lowercase"),
    ("equipment", "equipment_code", "upper", "ck_equipment_code_uppercase"),
    ("groups", "code", "upper", "ck_groups_code_uppercase"),
    ("report_types", "code", "upper", "ck_report_types_code_uppercase"),
)


def upgrade() -> None:
    bind = op.get_bind()
    for table, col, fn, _ in _TARGETS:
        clashes = bind.execute(
            sa.text(f"SELECT {fn}({col}) AS k, count(*) AS n FROM {table} GROUP BY {fn}({col}) HAVING count(*) > 1")
        ).fetchall()
        if clashes:
            raise RuntimeError(
                f"Cannot normalise {table}.{col}: these values differ only by letter case and must be "
                f"merged or renamed by hand first: {[row[0] for row in clashes]}"
            )
    for table, col, fn, name in _TARGETS:
        op.execute(sa.text(f"UPDATE {table} SET {col} = {fn}({col}) WHERE {col} <> {fn}({col})"))
        op.create_check_constraint(op.f(name), table, sa.text(f"{col} = {fn}({col})"))


def downgrade() -> None:
    for table, _col, _fn, name in reversed(_TARGETS):
        op.drop_constraint(op.f(name), table, type_="check")
