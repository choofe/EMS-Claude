"""Admin primitives (CLI today, Phase 4 API later). Shared by SQLite and Postgres runs."""
import json

import pytest
from sqlalchemy import select

import app.models as m
from app.core.security import verify_password
from app.services import user_admin
from app.services.auth_service import PasswordPolicyError, login
from tests import factories as f


async def test_create_user_hashes_password_and_audits(db):
    u = await user_admin.create_user(db, username="admin", full_name="Admin", role_code="MANAGEMENT",
                                     password="a-very-good-passphrase")
    assert u.hashed_password.startswith("$argon2id$") and "passphrase" not in u.hashed_password
    assert verify_password(u.hashed_password, "a-very-good-passphrase")
    assert u.must_change_password is False
    row = (await db.execute(select(m.AuditLog).where(m.AuditLog.action == "user.create"))).scalar_one()
    assert row.entity_id == u.id and "passphrase" not in json.dumps(row.metadata_json)


@pytest.mark.parametrize("pw,code", [("short", "too_short"), ("password123", "too_common"), ("admin", "same_as_username")])
async def test_create_user_enforces_password_policy(db, pw, code):
    with pytest.raises(PasswordPolicyError) as exc:
        await user_admin.create_user(db, username="admin", full_name="A", role_code="USER", password=pw)
    assert code in exc.value.errors


async def test_create_user_rejects_unknown_role_and_duplicates(db):
    with pytest.raises(ValueError):
        await user_admin.create_user(db, username="x1", full_name="X", role_code="GOD", password="a-very-good-passphrase")
    await user_admin.create_user(db, username="dup", full_name="D", role_code="USER", password="a-very-good-passphrase")
    with pytest.raises(ValueError):
        await user_admin.create_user(db, username="dup", full_name="D2", role_code="USER", password="another-good-passphrase")


async def test_reset_password_forces_change_and_ends_sessions(db):
    u = await f.user(db, "ali", "USER")
    await db.commit()
    await login(db, "ali", f.PASSWORD, "1.2.3.4")  # creates a refresh token
    await user_admin.reset_password(db, username="ali", password="temporary-passphrase-1")
    await db.refresh(u)
    assert u.must_change_password is True and verify_password(u.hashed_password, "temporary-passphrase-1")
    tokens = (await db.execute(select(m.RefreshToken).where(m.RefreshToken.user_id == u.id))).scalars().all()
    assert tokens and all(t.revoked_at is not None for t in tokens)
    with pytest.raises(ValueError):
        await user_admin.reset_password(db, username="nobody", password="temporary-passphrase-1")


async def test_force_password_change_all_hits_every_active_user_regardless_of_password(db):
    strong = await user_admin.create_user(db, username="strong", full_name="S", role_code="USER",
                                          password="Xk9#mP2$vL7!qR4&wZ8@tY1^")  # 24 chars, very strong
    ok = await f.user(db, "ok", "EXPERT")
    gone = await f.user(db, "gone", "USER", active=False)
    await db.commit()
    await login(db, "ok", f.PASSWORD, None)
    count = await user_admin.force_password_change_all(db)
    assert count == 2
    for u in (strong, ok, gone):
        await db.refresh(u)
    assert strong.must_change_password and ok.must_change_password and not gone.must_change_password
    assert all(t.revoked_at is not None for t in (await db.execute(select(m.RefreshToken))).scalars())
    audit = (await db.execute(select(m.AuditLog).where(m.AuditLog.action == "auth.force_password_change_all"))).scalar_one()
    assert audit.metadata_json == {"users_affected": 2}
