"""Personnel phase Pa on real PostgreSQL: the MIGRATED constraints (CHECKs are not compared by Alembic) and the
partial unique indexes behave like the model's SQLite twins in tests/test_personnel_foundation.py."""
import pytest
from sqlalchemy.exc import DBAPIError, IntegrityError

import app.models as m

from .helpers import get_role


async def _rejected(db, error=IntegrityError, **kw):
    async with db.begin_nested():
        db.add(m.User(full_name="P", **kw))
        with pytest.raises(error):
            await db.flush()


async def test_login_less_people_and_null_duplicates_are_allowed(db):
    db.add_all([m.User(full_name="A", login_enabled=False), m.User(full_name="B", login_enabled=False)])
    await db.flush()


async def test_migrated_checks_reject_bad_rows(db):
    role = await get_role(db, "USER")
    await _rejected(db, username="onlyname")                                   # all-or-none
    await _rejected(db, role_id=role.id, login_enabled=False)                  # role without credentials
    await _rejected(db)                                                        # login_enabled true without profile
    await _rejected(db, login_enabled=False, personnel_code=0)
    await _rejected(db, login_enabled=False, personnel_code=10000)
    await _rejected(db, login_enabled=False, mobile="0912345678")
    await _rejected(db, login_enabled=False, mobile="08123456789")
    for bad in ("09abcdefghi", "09123abc789", "09 23456789"):
        await _rejected(db, login_enabled=False, mobile=bad)                    # digits only (PA-002): the CHECK
    for too_long in ("+989123456789", "091234567890"):
        await _rejected(db, DBAPIError, login_enabled=False, mobile=too_long)   # longer than the column
    db.add(m.User(full_name="Z", login_enabled=False, mobile="09000000000"))
    await db.flush()


async def test_partial_unique_indexes(db):
    db.add(m.User(full_name="A", login_enabled=False, personnel_code=5, mobile="09121234567"))
    await db.flush()
    await _rejected(db, login_enabled=False, personnel_code=5)
    await _rejected(db, login_enabled=False, mobile="09121234567")
    db.add(m.User(full_name="B", login_enabled=False, personnel_code=6, mobile="09121234568"))
    await db.flush()


async def test_name_longer_than_the_column_is_rejected_by_postgres(db):
    async with db.begin_nested():
        db.add(m.User(full_name="x" * 129, login_enabled=False))
        with pytest.raises(DBAPIError):  # value too long for type character varying(128)
            await db.flush()
