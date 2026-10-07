import json

import pytest
from sqlalchemy import func, select, update

import app.models as m
from app.core.permissions import Principal
from app.services import user_admin
from app.services.auth_service import load_principal
from tests import factories as f

PW = f.PASSWORD
NEW_PW = "a-good-temporary-pass-1"


async def audit(db, action):
    return (await db.execute(select(m.AuditLog).where(m.AuditLog.action == action).order_by(m.AuditLog.id))).scalars().all()


def new_user(**kw):
    body = dict(username="newbie", full_name="New Bie", role_code="EXPERT", password=NEW_PW)
    body.update(kw)
    return body


# ---------- create ----------

async def test_create_user_full_flow(api, world, db):
    r = await api.post("/users", "boss", json=new_user(group_ids=[world.elv.id]))
    assert r.status_code == 201
    u = r.json()
    assert u["username"] == "newbie" and u["role_code"] == "EXPERT" and u["group_ids"] == [world.elv.id]
    assert u["must_change_password"] is True and u["is_active"] is True
    assert not ({"password", "hashed_password"} & set(u))
    row = (await audit(db, "user.create"))[-1]
    assert row.actor_id == world.boss.id and row.entity_id == u["id"]
    assert NEW_PW not in json.dumps(row.metadata_json)
    login = await api.post("/auth/login", json={"username": "newbie", "password": NEW_PW})
    assert login.status_code == 200 and login.json()["must_change_password"] is True
    assert (await api.get("/users", login.json()["access_token"] and None, headers={"Authorization": f"Bearer {login.json()['access_token']}"})).status_code == 403


async def test_username_is_canonicalised_and_case_insensitively_unique(api, world):
    r = await api.post("/users", "boss", json=new_user(username="  NewBie.One "))
    assert r.status_code == 201 and r.json()["username"] == "newbie.one"
    dup = await api.post("/users", "boss", json=new_user(username="NEWBIE.ONE"))
    assert dup.status_code == 409 and dup.json() == {"detail": "username_taken"}
    assert (await api.post("/users", "boss", json=new_user(username="ALI"))).status_code == 409  # existing seed user


@pytest.mark.parametrize("name", ["ab", "علی", "has space", "-lead", "a@b"])
async def test_invalid_usernames_rejected(api, world, name):
    r = await api.post("/users", "boss", json=new_user(username=name))
    assert r.status_code == 422 and r.json() == {"detail": "invalid_username"}


async def test_create_validations(api, world, db):
    weak = await api.post("/users", "boss", json=new_user(password="short1"))
    assert weak.status_code == 422 and weak.json()["detail"] == {"code": "password_policy", "errors": ["too_short"]}
    assert (await api.post("/users", "boss", json=new_user(role_code="GOD"))).json()["detail"]["code"] == "unknown_role"
    assert (await api.post("/users", "boss", json=new_user(group_ids=[9999]))).status_code == 404
    (await db.get(m.Group, world.door.id)).is_active = False
    await db.commit()
    inactive = await api.post("/users", "boss", json=new_user(group_ids=[world.door.id]))
    assert inactive.status_code == 409 and inactive.json()["detail"]["code"] == "group_inactive"
    assert (await api.post("/users", "boss", json={**new_user(), "is_active": False})).status_code == 422  # unknown field
    assert (await db.execute(select(func.count()).select_from(m.User).where(m.User.username == "newbie"))).scalar_one() == 0


async def test_login_is_case_insensitive_and_lockout_spans_case_variants(api, world):
    assert (await api.post("/auth/login", json={"username": "ALI", "password": PW})).status_code == 200
    for name in ("Ali", "ALI", "aLi", "ali", "Ali"):
        assert (await api.post("/auth/login", json={"username": name, "password": "wrong-password-1"})).status_code == 401
    assert (await api.post("/auth/login", json={"username": "ali", "password": PW})).status_code == 429


# ---------- permissions ----------

@pytest.mark.parametrize("who", ["ali", "exp", "aud"])
async def test_only_management_may_write_users(api, world, who):
    uid = world.omid.id
    calls = [
        ("POST", "/users", dict(json=new_user())),
        ("PATCH", f"/users/{uid}", dict(json={"full_name": "X"})),
        ("POST", f"/users/{uid}/deactivate", {}),
        ("POST", f"/users/{uid}/activate", {}),
        ("PUT", f"/users/{uid}/groups", dict(json={"group_ids": []})),
        ("POST", f"/users/{uid}/reset-password", dict(json={"password": NEW_PW})),
        ("POST", f"/users/{uid}/force-password-change", {}),
        ("POST", "/users/force-password-change-all", {}),
    ]
    for method, path, kw in calls:
        r = await api.call(method, path, who, **kw)
        assert r.status_code == 403 and r.json() == {"detail": "forbidden"}, (who, method, path)


async def test_reading_users_needs_users_view(api, world):
    for who in ("ali", "exp"):
        assert (await api.get("/users", who)).status_code == 403
        assert (await api.get(f"/users/{world.ali.id}", who)).status_code == 403
    for who in ("aud", "boss"):
        assert (await api.get("/users", who)).status_code == 200
        assert (await api.get(f"/users/{world.ali.id}", who)).status_code == 200


# ---------- list ----------

async def test_list_filters_search_and_pagination(api, world):
    allu = (await api.get("/users", "boss")).json()
    assert allu["total"] == 6 and [u["username"] for u in allu["items"]] == sorted(u["username"] for u in allu["items"])
    assert {u["username"] for u in (await api.get("/users?q=AL", "boss")).json()["items"]} == {"ali"}
    assert [u["username"] for u in (await api.get("/users?role_code=EXPERT", "boss")).json()["items"]] == ["exp"]
    assert {u["username"] for u in (await api.get(f"/users?group_id={world.elv.id}", "boss")).json()["items"]} == {"exp", "ali"}
    page = (await api.get("/users?limit=2&offset=4", "boss")).json()
    assert page["total"] == 6 and len(page["items"]) == 2 and page["limit"] == 2 and page["offset"] == 4
    assert (await api.get("/users?q=%25", "boss")).json()["total"] == 0  # '%' is literal, not a wildcard
    for bad in ("limit=0", "limit=101", "offset=-1"):
        assert (await api.get(f"/users?{bad}", "boss")).status_code == 422
    assert (await api.get("/users/999999", "boss")).status_code == 404


# ---------- update / roles ----------

async def test_update_name_and_role_are_audited(api, world, db):
    r = await api.patch(f"/users/{world.ali.id}", "boss", json={"full_name": "  Ali   Reza ", "role_code": "EXPERT"})
    assert r.status_code == 200 and r.json()["full_name"] == "Ali Reza" and r.json()["role_code"] == "EXPERT"
    assert (await audit(db, "user.role_change"))[-1].metadata_json == {"from": "USER", "to": "EXPERT"}
    assert (await audit(db, "user.update"))[-1].metadata_json["changes"]["full_name"] == ["Ali", "Ali Reza"]
    before = len(await audit(db, "user.role_change"))
    await api.patch(f"/users/{world.ali.id}", "boss", json={"role_code": "EXPERT"})  # no-op
    assert len(await audit(db, "user.role_change")) == before
    assert (await api.patch(f"/users/{world.ali.id}", "boss", json={"role_code": "NOPE"})).status_code == 422
    assert (await api.patch("/users/9999", "boss", json={"full_name": "x"})).status_code == 404


async def test_role_change_applies_to_the_users_live_token(api, world):
    assert (await api.get("/users", "ali")).status_code == 403
    await api.patch(f"/users/{world.ali.id}", "boss", json={"role_code": "AUDITOR"})
    assert (await api.get("/users", "ali")).status_code == 200  # same access token, new role, no re-login


async def test_cannot_change_own_role_and_last_management_is_protected(api, world, db):
    r = await api.patch(f"/users/{world.boss.id}", "boss", json={"role_code": "USER"})
    assert r.status_code == 409 and r.json() == {"detail": "cannot_change_own_role"}
    assert (await api.patch(f"/users/{world.boss.id}", "boss", json={"full_name": "Boss Renamed"})).status_code == 200  # name is fine
    # A stale actor (demoted after authenticating) must not be able to remove the last remaining MANAGEMENT.
    boss_id, boss2_id = world.boss.id, world.boss2.id  # a rollback below expires ORM objects; keep plain ids
    stale = await load_principal(db, boss_id)
    await user_admin.update_user(db, actor=await load_principal(db, boss2_id), user_id=boss_id, role_code="USER")
    from app.core.errors import DomainError
    with pytest.raises(DomainError) as e:
        await user_admin.update_user(db, actor=stale, user_id=boss2_id, role_code="USER")
    assert e.value.code == "last_management"
    with pytest.raises(DomainError) as e:
        await user_admin.set_active(db, actor=stale, user_id=boss2_id, active=False)
    assert e.value.code == "last_management"
    n = (await db.execute(select(func.count()).select_from(m.User).join(m.Role).where(m.Role.code == "MANAGEMENT", m.User.is_active.is_(True)))).scalar_one()
    assert n == 1


# ---------- deactivate / activate ----------

async def test_deactivate_ends_sessions_at_once_and_activate_restores(api, world, db):
    assert (await api.get("/auth/me", "ali")).status_code == 200
    r = await api.post(f"/users/{world.ali.id}/deactivate", "boss")
    assert r.status_code == 200 and r.json()["is_active"] is False
    assert (await api.get("/auth/me", "ali")).status_code == 401  # live access token dies immediately
    toks = (await db.execute(select(m.RefreshToken).where(m.RefreshToken.user_id == world.ali.id))).scalars().all()
    assert toks and all(t.revoked_at is not None for t in toks)
    assert (await api.post("/auth/login", json={"username": "ali", "password": PW})).status_code == 401
    assert (await api.post(f"/users/{world.ali.id}/activate", "boss")).json()["is_active"] is True
    assert (await api.post("/auth/login", json={"username": "ali", "password": PW})).status_code == 200
    assert [a.entity_id for a in await audit(db, "user.deactivate")] == [world.ali.id]
    again = len(await audit(db, "user.deactivate"))
    await api.post(f"/users/{world.omid.id}/deactivate", "boss")
    await api.post(f"/users/{world.omid.id}/deactivate", "boss")  # idempotent, audited once
    assert len(await audit(db, "user.deactivate")) == again + 1


async def test_cannot_deactivate_self_and_unknown_user(api, world):
    r = await api.post(f"/users/{world.boss.id}/deactivate", "boss")
    assert r.status_code == 409 and r.json() == {"detail": "cannot_deactivate_self"}
    assert (await api.post("/users/9999/deactivate", "boss")).status_code == 404


# ---------- group membership ----------

async def test_set_groups_adds_removes_and_audits_only_real_changes(api, world, db):
    r = await api.put(f"/users/{world.ali.id}/groups", "boss", json={"group_ids": [world.door.id, world.door.id]})
    assert r.status_code == 200 and r.json()["group_ids"] == [world.door.id]
    assert (await audit(db, "user.groups_change"))[-1].metadata_json == {"added": [world.door.id], "removed": [world.elv.id]}
    n = len(await audit(db, "user.groups_change"))
    await api.put(f"/users/{world.ali.id}/groups", "boss", json={"group_ids": [world.door.id]})
    assert len(await audit(db, "user.groups_change")) == n
    assert (await api.put(f"/users/{world.ali.id}/groups", "boss", json={"group_ids": []})).json()["group_ids"] == []
    assert (await api.put(f"/users/{world.ali.id}/groups", "boss", json={"group_ids": [9999]})).status_code == 404


async def test_cannot_add_inactive_group_but_can_leave_one(api, world, db):
    (await db.get(m.Group, world.elv.id)).is_active = False
    await db.commit()
    r = await api.put(f"/users/{world.omid.id}/groups", "boss", json={"group_ids": [world.door.id, world.elv.id]})
    assert r.status_code == 409 and r.json()["detail"] == {"code": "group_inactive", "group_id": world.elv.id}
    assert (await api.put(f"/users/{world.ali.id}/groups", "boss", json={"group_ids": []})).status_code == 200  # leaving is fine


async def test_membership_change_takes_effect_on_live_token(api, world):
    assert (await api.get("/groups", "ali")).json()["items"][0]["code"] == "ELV"
    await api.put(f"/users/{world.ali.id}/groups", "boss", json={"group_ids": [world.door.id]})
    assert [g["code"] for g in (await api.get("/groups", "ali")).json()["items"]] == ["DOOR"]


# ---------- passwords ----------

async def test_admin_reset_password(api, world, db):
    await api.token("ali")  # an existing session
    r = await api.post(f"/users/{world.ali.id}/reset-password", "boss", json={"password": NEW_PW})
    assert r.status_code == 200 and r.json()["must_change_password"] is True
    assert (await api.post("/auth/login", json={"username": "ali", "password": PW})).status_code == 401
    login = await api.post("/auth/login", json={"username": "ali", "password": NEW_PW})
    assert login.status_code == 200 and login.json()["must_change_password"] is True
    toks = (await db.execute(select(m.RefreshToken).where(m.RefreshToken.user_id == world.ali.id).order_by(m.RefreshToken.id))).scalars().all()
    assert toks[0].revoked_at is not None  # the pre-reset session was ended
    row = (await audit(db, "user.password_reset"))[-1]
    assert NEW_PW not in json.dumps(row.metadata_json) and row.metadata_json == {"force_change": True}
    soft = await api.post(f"/users/{world.omid.id}/reset-password", "boss", json={"password": NEW_PW, "must_change_password": False})
    assert soft.json()["must_change_password"] is False


async def test_admin_reset_validation_and_self_reset_blocked(api, world):
    weak = await api.post(f"/users/{world.ali.id}/reset-password", "boss", json={"password": "password123"})
    assert weak.status_code == 422 and "too_common" in weak.json()["detail"]["errors"]
    own = await api.post(f"/users/{world.boss.id}/reset-password", "boss", json={"password": NEW_PW})
    assert own.status_code == 409 and own.json() == {"detail": "use_change_password_endpoint"}
    assert (await api.post("/users/9999/reset-password", "boss", json={"password": NEW_PW})).status_code == 404


async def test_force_password_change_one_and_all(api, world, db):
    await api.token("exp")
    r = await api.post(f"/users/{world.exp.id}/force-password-change", "boss")
    assert r.json()["must_change_password"] is True
    assert (await api.get("/groups", "exp")).status_code in (401, 403)  # blocked (flag) or session ended
    await api.post(f"/users/{world.omid.id}/deactivate", "boss")
    r = await api.post("/users/force-password-change-all", "boss")
    assert r.status_code == 200 and r.json() == {"users_affected": 5}  # 6 users minus the deactivated one
    db.expire_all()  # the API wrote through other sessions; drop this session's cached rows
    flags = {u.username: u.must_change_password for u in (await db.execute(select(m.User))).scalars()}
    assert flags == {"boss": True, "boss2": True, "aud": True, "exp": True, "ali": True, "omid": False}
    assert (await audit(db, "auth.force_password_change_all"))[-1].metadata_json == {"users_affected": 5}
    assert (await api.get("/users", "aud")).status_code == 403  # even a strong-password user is forced to change first
