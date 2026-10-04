"""HTTP-level tests of the auth flow on a minimal app = real auth router + a few test-only
protected routes that exercise the real dependencies (get_current_principal, require_capability,
query scoping / IDOR)."""
import json
from datetime import timedelta

import pytest
import pytest_asyncio
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update

import app.models as m
from app.api.auth import router as auth_router
from app.api.deps import get_current_principal, require_capability
from app.core.permissions import Capability as C
from app.core.config import get_settings
from app.core.scoping import apply_report_scope
from app.core.security import hash_password, utcnow
from app.db.session import get_db
from tests import factories as f

CSRF = {"X-Requested-With": "ems-web"}
PW = f.PASSWORD


def build_app(maker) -> FastAPI:
    t = APIRouter(prefix="/_t")

    @t.get("/ping")
    async def ping(p=Depends(get_current_principal)):
        return {"user": p.username}

    @t.get("/admin-only")
    async def admin_only(p=Depends(require_capability(C.USERS_MANAGE))):
        return {"ok": True}

    @t.get("/reports/{rid}")
    async def get_report(rid: int, p=Depends(require_capability(C.REPORT_VIEW)), db=Depends(get_db)):
        stmt = apply_report_scope(select(m.Report).where(m.Report.id == rid), p, C.REPORT_VIEW)
        row = (await db.execute(stmt)).scalar_one_or_none()
        if row is None:
            raise HTTPException(404, "not_found")  # same answer for "missing" and "not yours" (anti-IDOR)
        return {"number": row.report_number}

    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(t)

    async def _db():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    return app


@pytest_asyncio.fixture
async def env(db):
    elv, door = await f.group(db, "ELV"), await f.group(db, "DOOR")
    ali = await f.user(db, "ali", "USER", [elv])
    boss = await f.user(db, "boss", "MANAGEMENT")
    e1, d1 = await f.equipment(db, "ELV-1", elv), await f.equipment(db, "DOOR-1", door)
    r_elv = await f.report(db, "05-ELV-001", e1, elv, ali)
    r_door = await f.report(db, "05-DOOR-001", d1, door, boss)
    await db.commit()
    transport = ASGITransport(app=build_app(db.session_maker))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield dict(db=db, client=client, ali=ali, boss=boss, r_elv=r_elv, r_door=r_door)


async def login(client, username="ali", password=PW):
    return await client.post("/auth/login", json={"username": username, "password": password})


def bearer(resp):
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# ---------- login ----------

async def test_login_success_shape_and_cookie(env):
    c = env["client"]
    r = await login(c)
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer" and body["expires_in"] == get_settings().access_token_expire_minutes * 60
    assert body["user"]["username"] == "ali" and body["user"]["role_code"] == "USER"
    assert "refresh" not in json.dumps(body).lower()          # refresh token never in the body
    assert r.headers["cache-control"] == "no-store"
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "path=/auth" in cookie and "samesite=lax" in cookie
    assert (await c.get("/_t/ping", headers=bearer(r))).json() == {"user": "ali"}


async def test_all_login_failures_are_indistinguishable(env):
    db, c = env["db"], env["client"]
    inactive = await f.user(db, "gone", "USER", active=False)
    await db.commit()
    responses = [
        await login(c, "ali", "wrong-password-x"),
        await login(c, "nobody", PW),
        await login(c, "gone", PW),  # right password, deactivated account
    ]
    assert {r.status_code for r in responses} == {401}
    assert len({r.text for r in responses}) == 1
    assert responses[0].json() == {"detail": "invalid_credentials"}
    assert all("set-cookie" not in r.headers for r in responses)


async def test_login_input_validation(env):
    c = env["client"]
    assert (await c.post("/auth/login", json={"username": "ali", "password": "x" * 129})).status_code == 422
    assert (await c.post("/auth/login", json={"username": "", "password": "x"})).status_code == 422
    assert (await c.post("/auth/login", json={"username": "ali"})).status_code == 422


# ---------- lockout ----------

async def test_lockout_after_five_failures_even_with_correct_password(env):
    c = env["client"]
    for _ in range(5):
        assert (await login(c, "ali", "bad-password-1")).status_code == 401
    r = await login(c, "ali", PW)
    assert r.status_code == 429 and r.json() == {"detail": "too_many_attempts"}
    assert 1 <= int(r.headers["retry-after"]) <= 15 * 60
    assert (await login(c, "boss", PW)).status_code == 200  # other accounts unaffected


async def test_lockout_is_identical_for_unknown_usernames(env):
    c = env["client"]
    for _ in range(5):
        assert (await login(c, "ghost", "whatever-1")).status_code == 401
    assert (await login(c, "ghost", "whatever-1")).status_code == 429  # no enumeration signal


async def test_requests_during_lockout_do_not_extend_it(env):
    db, c = env["db"], env["client"]
    for _ in range(5):
        await login(c, "ali", "bad-password-1")
    for _ in range(3):
        assert (await login(c, "ali", PW)).status_code == 429
    count = (await db.execute(select(func.count()).select_from(m.LoginAttempt))).scalar_one()
    assert count == 5


async def test_success_resets_failure_count(env):
    c = env["client"]
    for _ in range(4):
        await login(c, "ali", "bad-password-1")
    assert (await login(c, "ali", PW)).status_code == 200
    for _ in range(4):
        assert (await login(c, "ali", "bad-password-1")).status_code == 401  # would be 429 without the reset
    assert (await login(c, "ali", "bad-password-1")).status_code == 401
    assert (await login(c, "ali", PW)).status_code == 429


async def test_lockout_expires_with_the_window(env):
    db, c = env["db"], env["client"]
    for _ in range(5):
        await login(c, "ali", "bad-password-1")
    assert (await login(c, "ali", PW)).status_code == 429
    await db.execute(update(m.LoginAttempt).values(attempted_at=utcnow() - timedelta(minutes=16)))
    await db.commit()
    assert (await login(c, "ali", PW)).status_code == 200


async def test_policy_settings_change_lockout_threshold_and_are_clamped(env):
    db, c = env["db"], env["client"]
    db.add(m.SystemSetting(key="LOGIN_MAX_ATTEMPTS", value="3"))
    await db.commit()
    for _ in range(3):
        await login(c, "ali", "bad-password-1")
    assert (await login(c, "ali", PW)).status_code == 429

    from app.services.runtime_settings import get_auth_policy
    for key, raw, expected in (("PASSWORD_MIN_LENGTH", "3", 8), ("LOGIN_MAX_ATTEMPTS", "1", 3),
                               ("LOGIN_MAX_ATTEMPTS", "garbage", 5), ("LOGIN_LOCKOUT_MINUTES", "999999", 1440)):
        await db.execute(update(m.SystemSetting).where(m.SystemSetting.key == key).values(value=raw)) \
            if (await db.get(m.SystemSetting, key)) else db.add(m.SystemSetting(key=key, value=raw))
        await db.commit()
        policy = await get_auth_policy(db)
        got = {"PASSWORD_MIN_LENGTH": policy.password_min_length, "LOGIN_MAX_ATTEMPTS": policy.login_max_attempts,
               "LOGIN_LOCKOUT_MINUTES": policy.login_lockout_minutes}[key]
        assert got == expected


# ---------- bearer / authorization wiring ----------

async def test_missing_malformed_and_foreign_tokens_get_401(env):
    c = env["client"]
    for headers in ({}, {"Authorization": "Bearer nonsense"}, {"Authorization": "Basic abc"}):
        r = await c.get("/_t/ping", headers=headers)
        assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"


async def test_expired_access_token_rejected(env):
    from app.core.security import create_access_token
    token, _ = create_access_token(env["ali"].id, now=utcnow() - timedelta(hours=1))
    assert (await env["client"].get("/_t/ping", headers={"Authorization": f"Bearer {token}"})).status_code == 401


async def test_deactivation_applies_immediately_to_a_live_access_token(env):
    db, c = env["db"], env["client"]
    h = bearer(await login(c))
    assert (await c.get("/_t/ping", headers=h)).status_code == 200
    (await db.get(m.User, env["ali"].id)).is_active = False
    await db.commit()
    assert (await c.get("/_t/ping", headers=h)).status_code == 401


async def test_role_change_applies_immediately_to_a_live_access_token(env):
    db, c = env["db"], env["client"]
    h = bearer(await login(c))
    assert (await c.get("/_t/admin-only", headers=h)).status_code == 403
    (await db.get(m.User, env["ali"].id)).role_id = (await f.role(db, "MANAGEMENT")).id
    await db.commit()
    assert (await c.get("/_t/admin-only", headers=h)).status_code == 200


async def test_idor_out_of_scope_report_looks_exactly_like_missing(env):
    c = env["client"]
    h = bearer(await login(c))
    mine = await c.get(f"/_t/reports/{env['r_elv'].id}", headers=h)
    other_group = await c.get(f"/_t/reports/{env['r_door'].id}", headers=h)
    missing = await c.get("/_t/reports/999999", headers=h)
    assert mine.status_code == 200 and mine.json() == {"number": "05-ELV-001"}
    assert other_group.status_code == missing.status_code == 404
    assert other_group.json() == missing.json()
    boss_h = bearer(await login(c, "boss"))
    assert (await c.get(f"/_t/reports/{env['r_door'].id}", headers=boss_h)).status_code == 200


# ---------- refresh / logout ----------

async def test_refresh_rotates_and_issues_new_access_token(env):
    c = env["client"]
    first = await login(c)
    r = await c.post("/auth/refresh", headers=CSRF)
    assert r.status_code == 200 and r.json()["access_token"] != first.json()["access_token"]
    assert "ems_refresh=" in r.headers["set-cookie"]
    assert (await c.get("/_t/ping", headers=bearer(r))).status_code == 200


async def test_refresh_token_replay_revokes_the_whole_family(env):
    db, c = env["db"], env["client"]
    await login(c)
    stolen = c.cookies.get("ems_refresh")
    assert (await c.post("/auth/refresh", headers=CSRF)).status_code == 200      # legit rotation
    latest = c.cookies.get("ems_refresh")
    assert latest != stolen
    c.cookies.set("ems_refresh", stolen, path="/auth")                            # attacker replays the old one
    replay = await c.post("/auth/refresh", headers=CSRF)
    assert replay.status_code == 401 and replay.json() == {"detail": "invalid_refresh_token"}
    c.cookies.set("ems_refresh", latest, path="/auth")                            # even the newest is now dead
    assert (await c.post("/auth/refresh", headers=CSRF)).status_code == 401
    actions = (await db.execute(select(m.AuditLog.action))).scalars().all()
    assert "auth.refresh_reuse_detected" in actions


async def test_refresh_requires_csrf_header_and_allowed_origin(env):
    c = env["client"]
    await login(c)
    assert (await c.post("/auth/refresh")).status_code == 403
    assert (await c.post("/auth/refresh", headers={**CSRF, "Origin": "https://evil.example"})).status_code == 403
    assert (await c.post("/auth/refresh", headers={**CSRF, "Origin": "http://localhost:5173"})).status_code == 200


async def test_refresh_without_or_with_garbage_cookie_is_401(env):
    c = env["client"]
    assert (await c.post("/auth/refresh", headers=CSRF)).status_code == 401
    c.cookies.set("ems_refresh", "garbage", path="/auth")
    assert (await c.post("/auth/refresh", headers=CSRF)).status_code == 401


async def test_expired_refresh_token_rejected(env):
    db, c = env["db"], env["client"]
    await login(c)
    await db.execute(update(m.RefreshToken).values(expires_at=utcnow() - timedelta(seconds=1)))
    await db.commit()
    assert (await c.post("/auth/refresh", headers=CSRF)).status_code == 401


async def test_refresh_fails_for_deactivated_user(env):
    db, c = env["db"], env["client"]
    await login(c)
    (await db.get(m.User, env["ali"].id)).is_active = False
    await db.commit()
    assert (await c.post("/auth/refresh", headers=CSRF)).status_code == 401


async def test_logout_revokes_and_clears_cookie(env):
    c = env["client"]
    await login(c)
    token = c.cookies.get("ems_refresh")
    r = await c.post("/auth/logout", headers=CSRF)
    assert r.status_code == 204 and "ems_refresh" in r.headers["set-cookie"]
    c.cookies.set("ems_refresh", token, path="/auth")
    assert (await c.post("/auth/refresh", headers=CSRF)).status_code == 401
    assert (await c.post("/auth/logout")).status_code == 403  # CSRF guard applies here too


async def test_only_hash_of_refresh_token_is_stored(env):
    db, c = env["db"], env["client"]
    await login(c)
    raw = c.cookies.get("ems_refresh")
    stored = (await db.execute(select(m.RefreshToken.token_hash))).scalars().all()
    assert raw not in stored and len(stored) == 1 and len(stored[0]) == 64


# ---------- must_change_password + change-password ----------

async def test_forced_change_blocks_everything_except_change_flow(env):
    db, c = env["db"], env["client"]
    (await db.get(m.User, env["ali"].id)).must_change_password = True
    await db.commit()
    r = await login(c)
    assert r.status_code == 200 and r.json()["must_change_password"] is True
    h = bearer(r)
    blocked = await c.get("/_t/ping", headers=h)
    assert blocked.status_code == 403 and blocked.json() == {"detail": "password_change_required"}
    assert (await c.get(f"/_t/reports/{env['r_elv'].id}", headers=h)).status_code == 403
    assert (await c.get("/auth/me", headers=h)).json()["must_change_password"] is True

    done = await c.post("/auth/change-password", headers=h,
                        json={"current_password": PW, "new_password": "a-brand-new-passphrase"})
    assert done.status_code == 200 and done.json()["must_change_password"] is False
    assert (await c.get("/_t/ping", headers=bearer(done))).status_code == 200
    assert (await login(c, "ali", "a-brand-new-passphrase")).status_code == 200
    assert (await login(c, "ali", PW)).status_code == 401


async def test_change_password_revokes_all_other_sessions(env):
    c = env["client"]
    await login(c)
    old_refresh = c.cookies.get("ems_refresh")
    h = bearer(await login(c))
    assert (await c.post("/auth/change-password", headers=h,
                         json={"current_password": PW, "new_password": "another-good-passphrase"})).status_code == 200
    c.cookies.set("ems_refresh", old_refresh, path="/auth")
    assert (await c.post("/auth/refresh", headers=CSRF)).status_code == 401


async def test_change_password_validation_errors(env):
    c = env["client"]
    h = bearer(await login(c))
    async def change(cur, new):
        return await c.post("/auth/change-password", headers=h, json={"current_password": cur, "new_password": new})
    short = await change(PW, "short1")
    assert short.status_code == 422 and short.json()["detail"] == {"code": "password_policy", "errors": ["too_short"]}
    assert "too_common" in (await change(PW, "password123")).json()["detail"]["errors"]
    assert (await change(PW, PW)).json()["detail"]["errors"] == ["same_as_current"]
    assert (await change("wrong-current-pw", "a-brand-new-passphrase")).status_code == 401


async def test_wrong_current_password_counts_toward_lockout(env):
    c = env["client"]
    h = bearer(await login(c))
    for _ in range(5):
        assert (await c.post("/auth/change-password", headers=h,
                             json={"current_password": "wrong-current-pw", "new_password": "x" * 12})).status_code == 401
    r = await c.post("/auth/change-password", headers=h, json={"current_password": PW, "new_password": "a-brand-new-passphrase"})
    assert r.status_code == 429


async def test_raising_minimum_length_forces_change_at_next_login(env):
    db, c = env["db"], env["client"]
    assert (await login(c)).json()["must_change_password"] is False       # 21-char password, default min 8
    db.add(m.SystemSetting(key="PASSWORD_MIN_LENGTH", value="30"))
    await db.commit()
    r = await login(c)
    assert r.status_code == 200 and r.json()["must_change_password"] is True
    assert (await c.get("/_t/ping", headers=bearer(r))).status_code == 403
    actions = (await db.execute(select(m.AuditLog.action))).scalars().all()
    assert "auth.password_change_required" in actions


async def test_weaker_stored_hash_is_upgraded_on_login(env):
    db, c = env["db"], env["client"]
    from argon2 import PasswordHasher
    weak = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1).hash(PW)
    (await db.get(m.User, env["ali"].id)).hashed_password = weak
    await db.commit()
    assert (await login(c)).status_code == 200
    await db.refresh(await db.get(m.User, env["ali"].id))
    assert (await db.get(m.User, env["ali"].id)).hashed_password != weak


# ---------- audit hygiene ----------

async def test_audit_log_never_contains_secrets(env):
    db, c = env["db"], env["client"]
    r = await login(c)
    await c.post("/auth/refresh", headers=CSRF)
    await c.post("/auth/change-password", headers=bearer(r),
                 json={"current_password": PW, "new_password": "a-brand-new-passphrase"})
    blob = json.dumps([row.metadata_json for row in (await db.execute(select(m.AuditLog))).scalars()])
    rows = (await db.execute(select(m.AuditLog.action))).scalars().all()
    assert {"auth.login", "auth.password_change"} <= set(rows)
    for secret in (PW, "a-brand-new-passphrase", r.json()["access_token"], c.cookies.get("ems_refresh") or "∅"):
        assert secret not in blob
