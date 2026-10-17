"""The canonical-form CHECK constraints must exist in the MODELS (what SQLite tests and create_all use) AND match the
migration (what PostgreSQL gets). Alembic autogenerate does not compare CHECK constraints, so this guards the drift."""
import importlib.util
import pathlib

import pytest
from sqlalchemy.exc import IntegrityError

import app.models as m
from app.db.base import Base
from tests import factories as f


def _migration_targets():
    path = next(pathlib.Path("alembic/versions").glob("c4a9d7e2b610_*.py"))
    spec = importlib.util.spec_from_file_location("mig_c4a9", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._TARGETS


# CHECKs that are NOT canonical-form rules and live in their own migration (checked in test_report_creation.py
# and tests/postgres/test_report_creation_pg.py): labor minutes range (Phase 6, f6c3d9a7b104).
_OTHER_CHECKS = {"ck_report_participants_minutes_range", "ck_report_types_labor_mode_valid",
                 "ck_reports_equipment_or_general"}


def test_model_check_constraints_match_the_migration():
    declared = {
        c.name for t in Base.metadata.tables.values() for c in t.constraints if c.name and c.name.startswith("ck_")
    } - _OTHER_CHECKS
    assert declared == {name for _t, _c, _fn, name in _migration_targets()}


async def test_database_rejects_non_canonical_values(db):
    group = await f.group(db, "ELV")
    role = await f.role(db, "USER")
    await db.commit()
    gid, rid = group.id, role.id
    bad = [
        m.User(username="Bad", hashed_password="x", full_name="B", role_id=rid),
        m.Equipment(equipment_code="x-1", group_id=gid),
        m.Group(code="lower", name="n"),
        m.ReportType(code="lower_type", name_fa="n", is_failure=False),
    ]
    for obj in bad:
        db.add(obj)
        with pytest.raises(IntegrityError):
            await db.flush()
        await db.rollback()
