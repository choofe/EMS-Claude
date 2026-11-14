"""Personnel phase, sub-phase Pb: management API for people with or without a login profile."""
import json

import pytest
from sqlalchemy import select

import app.models as m
from app.core.permissions import Principal
from app.services import auth_service
from tests import factories as f

PW = "a-good-temporary-pass-1"
PERSON = dict(first_name="سارا", last_name="کریمی", personnel_code="۱۲۳", mobile="+98 912 345 6789")


async def audit(db, action):
    return (await db.execute(select(m.AuditLog).where(m.AuditLog.action == action).order_by(m.AuditLog.id))).scalars().all()


async def person(api, who="boss", **over):
    r = await api.post("/users/people", who, json={**PERSON, **over})
    return r


def profile(**over):
    return {"username": "sara", "password": PW, "role_code": "USER", **over}


# ---------------------------------------------------------------- create person

async def test_create_person_without_profile(api, world, db):
    r = await person(api, group_ids=[world.elv.id])
    assert r.status_code == 201
    u = r.json()
    assert u["username"] is None and u["has_login"] is False and u["role_code"] is None and u["login_enabled"] is False
    assert u["personnel_code"] == 123 and u["mobile"] == "09123456789" and u["group_ids"] == [world.elv.id]
    assert u["full_name"] == "سارا کریمی" and u["first_name"] == "سارا"
    row = (await audit(db, "user.create_person"))[-1]
    assert row.actor_id == world.boss.id and row.metadata_json["personnel_code"] == 123
    assert row.metadata_json["has_profile"] is False
    assert "09123456789" not in json.dumps(row.metadata_json) and "9123456789" not in json.dumps(row.metadata_json)
    assert await auth_service.load_principal(db, u["id"]) is None


async def test_create_person_with_profile_in_one_step(api, world, db):
    r = await person(api, profile=profile(role_code="EXPERT"))
    assert r.status_code == 201
    u = r.json()
    assert u["username"] == "sara" and u["role_code"] == "EXPERT" and u["has_login"] and u["login_enabled"]
    assert u["must_change_password"] is True and not ({"password", "hashed_password"} & set(u))
    row = (await audit(db, "user.create_person"))[-1]
    assert row.metadata_json["has_profile"] is True and PW not in json.dumps(row.metadata_json)
    login = await api.post("/auth/login", json={"username": "sara", "password": PW})
    assert login.status_code == 200 and login.json()["must_change_password"] is True


@pytest.mark.parametrize("missing", ["first_name", "last_name", "personnel_code", "mobile"])
async def test_every_identity_field_is_mandatory(api, world, missing):
    body = {k: v for k, v in PERSON.items() if k != missing}
    assert (await api.post("/users/people", "boss", json=body)).status_code == 422


@pytest.mark.parametrize("over,code", [
    ({"personnel_code": "0"}, "invalid_personnel_code"), ({"personnel_code": "10000"}, "invalid_personnel_code"),
    ({"personnel_code": "012"}, "invalid_personnel_code"), ({"mobile": "0812345678"}, "invalid_mobile"),
    ({"first_name": "  "}, "invalid_first_name"), ({"first_name": "a" * 64, "last_name": "b" * 64}, "invalid_full_name"),
])
async def test_person_input_rules(api, world, over, code):
    r = await person(api, **over)
    assert r.status_code == 422 and code in r.text


async def test_duplicates_and_bad_groups_are_refused(api, world, db):
    assert (await person(api)).status_code == 201
    assert (await person(api, mobile="09120000000")).status_code == 409          # same personnel code
    assert (await person(api, personnel_code="5")).status_code == 409            # same mobile
    assert (await person(api, personnel_code="6", mobile="09120000001", group_ids=[999])).status_code == 404
    world.door.is_active = False
    await db.commit()
    assert (await person(api, personnel_code="7", mobile="09120000002", group_ids=[world.door.id])).status_code == 409
    n = (await db.execute(select(m.User).where(m.User.username.is_(None)))).scalars().all()
    assert len(n) == 1  # nothing half-created


async def test_profile_role_must_be_user_or_expert_and_username_unique(api, world, db):
    for role in ("MANAGEMENT", "AUDITOR", "NOPE"):
        r = await person(api, profile=profile(role_code=role))
        assert r.status_code in (404, 422)
    assert (await person(api, profile=profile(username="ali"))).status_code == 409
    assert (await person(api, profile=profile(password="short"))).status_code == 422
    assert not (await db.execute(select(m.User).where(m.User.personnel_code == 123))).first()  # rolled back as a whole


@pytest.mark.parametrize("who", ["aud", "exp", "ali", None])
async def test_only_management_may_use_the_new_endpoints(api, world, who):
    calls = [("post", "/users/people", PERSON), ("post", f"/users/{world.ali.id}/profile", profile()),
             ("put", f"/users/{world.ali.id}/personnel-code", {"personnel_code": "9", "reason": "TYPO"}),
             ("put", f"/users/{world.ali.id}/mobile", {"mobile": "09121111111"}),
             ("put", f"/users/{world.ali.id}/username", {"username": "ali2", "reason": "TYPO"}),
             ("post", f"/users/{world.ali.id}/login/disable", None), ("post", f"/users/{world.ali.id}/login/enable", None),
             ("get", "/users/no-group-alert", None), ("post", "/users/no-group-alert/dismiss", None)]
    for method, path, body in calls:
        kw = {"json": body} if body is not None else {}
        r = await getattr(api, method)(path, who, **kw)
        assert r.status_code == (401 if who is None else 403), (path, r.status_code)


# ---------------------------------------------------------------- profile for an existing person

async def test_create_profile_for_existing_person(api, world, db):
    pid = (await person(api, group_ids=[world.elv.id])).json()["id"]
    r = await api.post(f"/users/{pid}/profile", "boss", json=profile(must_change_password=False))
    assert r.status_code == 201
    u = r.json()
    assert u["username"] == "sara" and u["role_code"] == "USER" and u["login_enabled"] and u["must_change_password"] is False
    row = (await audit(db, "user.profile_create"))[-1]
    assert row.entity_id == pid and PW not in json.dumps(row.metadata_json)
    assert (await api.post("/auth/login", json={"username": "sara", "password": PW})).status_code == 200
    again = await api.post(f"/users/{pid}/profile", "boss", json=profile(username="sara2"))
    assert again.status_code == 409                                              # already has a profile
    assert (await api.post(f"/users/{world.ali.id}/profile", "boss", json=profile(username="x1y"))).status_code == 409


async def test_create_profile_guards(api, world, db):
    pid = (await person(api)).json()["id"]
    assert (await api.post(f"/users/{pid}/profile", "boss", json=profile(username="ali"))).status_code == 409
    assert (await api.post(f"/users/{pid}/profile", "boss", json=profile(role_code="MANAGEMENT"))).status_code == 422
    assert (await api.post("/users/9999/profile", "boss", json=profile())).status_code == 404
    await api.post(f"/users/{pid}/deactivate", "boss")
    assert (await api.post(f"/users/{pid}/profile", "boss", json=profile())).status_code == 409
    row = await db.get(m.User, pid)
    await db.refresh(row)
    assert row.username is None and row.role_id is None  # nothing written by the refused calls


# ---------------------------------------------------------------- personnel code

async def test_personnel_code_first_assignment_needs_no_reason_then_change_does(api, world, db):
    uid = world.ali.id
    r = await api.put(f"/users/{uid}/personnel-code", "boss", json={"personnel_code": "77"})
    assert r.status_code == 200 and r.json()["personnel_code"] == 77
    assert (await audit(db, "user.personnel_code_change"))[-1].metadata_json["from"] is None
    assert (await api.put(f"/users/{uid}/personnel-code", "boss", json={"personnel_code": "78"})).status_code == 422
    r = await api.put(f"/users/{uid}/personnel-code", "boss", json={"personnel_code": "78", "reason": "OTHER"})
    assert r.status_code == 422                                                  # OTHER needs a note
    r = await api.put(f"/users/{uid}/personnel-code", "boss",
                      json={"personnel_code": "78", "reason": "OTHER", "note": "  unit  moved "})
    assert r.status_code == 200 and r.json()["personnel_code"] == 78
    meta = (await audit(db, "user.personnel_code_change"))[-1].metadata_json
    assert meta == {"from": 77, "to": 78, "reason": "OTHER", "note": "unit moved"}
    r = await api.put(f"/users/{uid}/personnel-code", "boss", json={"personnel_code": "79", "reason": "TYPO"})
    assert (await audit(db, "user.personnel_code_change"))[-1].metadata_json["reason"] == "TYPO" and r.status_code == 200


async def test_personnel_code_same_value_is_a_noop_and_cannot_be_cleared_or_duplicated(api, world, db):
    await api.put(f"/users/{world.ali.id}/personnel-code", "boss", json={"personnel_code": "10"})
    await api.put(f"/users/{world.omid.id}/personnel-code", "boss", json={"personnel_code": "11"})
    n = len(await audit(db, "user.personnel_code_change"))
    r = await api.put(f"/users/{world.ali.id}/personnel-code", "boss", json={"personnel_code": "10"})
    assert r.status_code == 200 and len(await audit(db, "user.personnel_code_change")) == n
    for bad in ({"personnel_code": ""}, {"personnel_code": None}, {}):
        assert (await api.put(f"/users/{world.ali.id}/personnel-code", "boss", json=bad)).status_code == 422
    r = await api.put(f"/users/{world.ali.id}/personnel-code", "boss", json={"personnel_code": "11", "reason": "TYPO"})
    assert r.status_code == 409
    assert (await api.get(f"/users/{world.ali.id}", "boss")).json()["personnel_code"] == 10


# ---------------------------------------------------------------- mobile

async def test_mobile_change_is_unique_normalised_and_never_audited(api, world, db):
    a = (await person(api)).json()["id"]
    b = (await person(api, personnel_code="2", mobile="09120000000")).json()["id"]
    r = await api.put(f"/users/{b}/mobile", "boss", json={"mobile": "۰۹۱۲۱۱۱۱۱۱۱"})
    assert r.status_code == 200 and r.json()["mobile"] == "09121111111"
    assert (await api.put(f"/users/{b}/mobile", "boss", json={"mobile": "09123456789"})).status_code == 409
    assert (await api.put(f"/users/{b}/mobile", "boss", json={"mobile": "123"})).status_code == 422
    assert (await api.put(f"/users/{b}/mobile", "boss", json={"mobile": ""})).status_code == 422   # cannot be cleared
    blob = json.dumps([r.metadata_json for r in await audit(db, "user.mobile_change")])
    assert "0912" not in blob and "912" not in blob and (await audit(db, "user.mobile_change"))[-1].entity_id == b
    assert a != b
    assert (await api.get(f"/users/{b}", "aud")).json()["mobile"] == "09121111111"     # AUDITOR may read it


# ---------------------------------------------------------------- username

async def test_username_change(api, world, db):
    token = await api.token("ali")
    r = await api.put(f"/users/{world.ali.id}/username", "boss", json={"username": "Ali.New", "reason": "NAME_CHANGE"})
    assert r.status_code == 200 and r.json()["username"] == "ali.new"
    meta = (await audit(db, "user.username_change"))[-1].metadata_json
    assert meta == {"from": "ali", "to": "ali.new", "reason": "NAME_CHANGE", "note": None}
    assert (await api._client.get("/reports", headers={"Authorization": f"Bearer {token}"})).status_code == 200  # session survives
    assert (await api.post("/auth/login", json={"username": "ali", "password": f.PASSWORD})).status_code == 401
    assert (await api.post("/auth/login", json={"username": "ali.new", "password": f.PASSWORD})).status_code == 200


async def test_username_change_guards(api, world, db):
    uid = world.ali.id
    put = lambda **b: api.put(f"/users/{uid}/username", "boss", json=b)  # noqa: E731
    assert (await put(username="omid", reason="TYPO")).status_code == 409
    assert (await put(username="bad name!", reason="TYPO")).status_code == 422
    assert (await put(username="alix")).status_code == 422                          # reason is mandatory
    assert (await put(username="alix", reason="OTHER")).status_code == 422          # OTHER needs a note
    assert (await put(username="alix", reason="REHIRE")).status_code == 422         # not a username reason
    n = len(await audit(db, "user.username_change"))
    assert (await put(username="ALI", reason="TYPO")).status_code == 200 and len(await audit(db, "user.username_change")) == n
    pid = (await person(api)).json()["id"]
    r = await api.put(f"/users/{pid}/username", "boss", json={"username": "zed", "reason": "TYPO"})
    assert r.status_code == 409                                                     # no profile: use the profile endpoint


# ---------------------------------------------------------------- login on/off

async def test_disabling_a_profile_ends_sessions_and_enabling_restores(api, world, db):
    token = await api.token("ali")
    login = await api.post("/auth/login", json={"username": "ali", "password": f.PASSWORD})
    assert login.status_code == 200
    r = await api.post(f"/users/{world.ali.id}/login/disable", "boss")
    assert r.status_code == 200 and r.json()["login_enabled"] is False and r.json()["is_active"] is True
    assert (await api._client.get("/reports", headers={"Authorization": f"Bearer {token}"})).status_code == 401
    assert (await api.post("/auth/login", json={"username": "ali", "password": f.PASSWORD})).status_code == 401
    live = (await db.execute(select(m.RefreshToken).where(m.RefreshToken.user_id == world.ali.id,
                                                          m.RefreshToken.revoked_at.is_(None)))).scalars().all()
    assert live == []
    assert [a.action for a in await audit(db, "user.login_disable")] == ["user.login_disable"]
    assert (await api.post(f"/users/{world.ali.id}/login/enable", "boss")).json()["login_enabled"] is True
    assert (await api.post("/auth/login", json={"username": "ali", "password": f.PASSWORD})).status_code == 200


async def test_login_toggle_guards(api, world, db):
    assert (await api.post(f"/users/{world.boss.id}/login/disable", "boss")).status_code == 409   # not oneself
    pid = (await person(api)).json()["id"]
    for verb in ("enable", "disable"):
        assert (await api.post(f"/users/{pid}/login/{verb}", "boss")).status_code == 409           # no profile
    await api.post(f"/users/{world.omid.id}/login/disable", "boss")
    await api.post(f"/users/{world.omid.id}/deactivate", "boss")
    assert (await api.post(f"/users/{world.omid.id}/login/enable", "boss")).status_code == 409    # inactive person
    assert (await api.post("/users/9999/login/disable", "boss")).status_code == 404
    await api.post(f"/users/{world.boss2.id}/login/disable", "boss")
    assert await auth_service.load_principal(db, world.boss2.id) is None


# ---------------------------------------------------------------- «users without a group» alert

async def test_no_group_alert_counts_only_active_non_organisation_wide_people_without_a_group(api, world, db):
    r = await api.get("/users/no-group-alert", "boss")
    assert r.json() == {"count": 0, "show": False}                        # managers/auditor have no group: excluded
    await f.person(db, "A", "One", code=1)
    await f.person(db, "B", "Two", code=2, active=False)                  # inactive: excluded
    await f.person(db, "C", "Three", code=3, groups=[world.elv])          # has a group: excluded
    await f.user(db, "nogroup", "USER")                                   # a profile holder without a group counts
    await db.commit()
    assert (await api.get("/users/no-group-alert", "boss")).json() == {"count": 2, "show": True}


async def test_no_group_alert_dismissal_is_per_manager_and_returns_when_the_count_grows(api, world, db):
    await f.person(db, "A", "One", code=1)
    await f.person(db, "B", "Two", code=2)
    await db.commit()
    assert (await api.post("/users/no-group-alert/dismiss", "boss")).json() == {"count": 2, "show": False}
    assert (await api.get("/users/no-group-alert", "boss")).json() == {"count": 2, "show": False}
    assert (await api.get("/users/no-group-alert", "boss2")).json() == {"count": 2, "show": True}   # another manager
    await f.person(db, "C", "Three", code=3)
    await db.commit()
    assert (await api.get("/users/no-group-alert", "boss")).json() == {"count": 3, "show": True}    # grew: returns
    await api.post("/users/no-group-alert/dismiss", "boss")
    # two get a group: the count falls to 1 and the dismissal follows it down, so one NEW group-less person shows again
    for p in (await db.execute(select(m.User).where(m.User.personnel_code.in_([1, 2])))).scalars():
        await api.put(f"/users/{p.id}/groups", "boss", json={"group_ids": [world.elv.id]})
    assert (await api.get("/users/no-group-alert", "boss")).json() == {"count": 1, "show": False}
    await f.person(db, "D", "Four", code=4)
    await db.commit()
    assert (await api.get("/users/no-group-alert", "boss")).json() == {"count": 2, "show": True}


async def test_no_group_alert_does_not_count_a_person_promoted_to_an_organisation_wide_role(api, world, db):
    p = await f.user(db, "wasuser", "USER")
    await db.commit()
    assert (await api.get("/users/no-group-alert", "boss")).json()["count"] == 1
    await api.patch(f"/users/{p.id}", "boss", json={"role_code": "AUDITOR"})
    assert (await api.get("/users/no-group-alert", "boss")).json()["count"] == 0


async def test_note_limit_is_the_same_in_schema_and_service(api, world):
    uid = world.ali.id
    ok = await api.put(f"/users/{uid}/username", "boss", json={"username": "ali2", "reason": "OTHER", "note": "n" * 200})
    assert ok.status_code == 200
    for note in ("n" * 201, "n" * 300):
        r = await api.put(f"/users/{uid}/username", "boss", json={"username": "ali3", "reason": "OTHER", "note": note})
        assert r.status_code == 422 and "invalid_reason_note" not in r.text  # refused by the schema, not the service
    await api.put(f"/users/{uid}/personnel-code", "boss", json={"personnel_code": "5"})
    r = await api.put(f"/users/{uid}/personnel-code", "boss", json={"personnel_code": "6", "reason": "OTHER", "note": "n" * 201})
    assert r.status_code == 422


async def test_enabling_a_login_revokes_any_token_that_survived_the_disable(api, world, db):
    from datetime import timedelta
    from app.core.security import utcnow
    await api.post(f"/users/{world.ali.id}/login/disable", "boss")
    # a token created by a sign-in that raced with the disable (inserted directly)
    db.add(m.RefreshToken(user_id=world.ali.id, family_id="f" * 32, token_hash="h" * 64,
                          expires_at=utcnow() + timedelta(days=1)))
    await db.commit()
    await api.post(f"/users/{world.ali.id}/login/enable", "boss")
    rows = (await db.execute(select(m.RefreshToken).where(m.RefreshToken.user_id == world.ali.id))).scalars().all()
    assert rows and all(r.revoked_at is not None for r in rows)


async def test_report_type_help_text_keeps_its_300_character_limit(api, world):
    """Regression: the personnel note limit (200) must not leak into the report-type `help_fa` schemas (300)."""
    base = {"code": "help_limit_type", "name_fa": "نوع آزمایشی"}
    ok = await api.post("/report-types", "boss", json={**base, "help_fa": "x" * 300})
    assert ok.status_code == 201, ok.text
    assert (await api.post("/report-types", "boss", json={**base, "code": "help_limit_2", "help_fa": "x" * 301})).status_code == 422
    tid = ok.json()["id"]
    assert (await api.patch(f"/report-types/{tid}", "boss", json={"help_fa": "y" * 250})).status_code == 200
    assert (await api.patch(f"/report-types/{tid}", "boss", json={"help_fa": "y" * 301})).status_code == 422
