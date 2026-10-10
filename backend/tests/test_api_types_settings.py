import pytest
from sqlalchemy import select, update

import app.models as m
from app.services.runtime_settings import get_auth_policy, get_report_edit_window_hours
from tests import factories as f

NEW_PW = "a-good-temporary-pass-1"


async def audit(db, action):
    return (await db.execute(select(m.AuditLog).where(m.AuditLog.action == action).order_by(m.AuditLog.id))).scalars().all()


# ======================= report types =======================

async def test_report_type_lifecycle(api, world, db):
    r = await api.post("/report-types", "boss", json={"code": " minor_failure ", "name_fa": "  تعمیر   خرابی جزئی ", "is_failure": True})
    assert r.status_code == 201
    t = r.json()
    assert t["code"] == "MINOR_FAILURE" and t["name_fa"] == "تعمیر خرابی جزئی" and t["is_failure"] and t["is_active"]
    dup = await api.post("/report-types", "boss", json={"code": "minor_FAILURE", "name_fa": "x"})
    assert dup.status_code == 409 and dup.json() == {"detail": "report_type_code_taken"}
    for bad in ("1X", "A B", "A-B", "A"):
        assert (await api.post("/report-types", "boss", json={"code": bad, "name_fa": "n"})).status_code == 422, bad
    tid = t["id"]
    assert (await api.patch(f"/report-types/{tid}", "boss", json={"code": "OTHER"})).status_code == 422  # immutable
    ren = await api.patch(f"/report-types/{tid}", "boss", json={"name_fa": "جزئی"})
    assert ren.json()["name_fa"] == "جزئی"
    assert (await audit(db, "report_type.update"))[-1].metadata_json["changes"]["name_fa"] == ["تعمیر خرابی جزئی", "جزئی"]
    assert (await api.post(f"/report-types/{tid}/deactivate", "boss")).json()["is_active"] is False
    assert (await api.post(f"/report-types/{tid}/activate", "boss")).json()["is_active"] is True
    assert (await api.patch("/report-types/9999", "boss", json={"name_fa": "x"})).status_code == 404


async def test_is_failure_is_frozen_once_a_report_uses_the_type(api, world, db):
    created = await api.post("/report-types", "boss", json={"code": "INSPECTION_VISIT", "name_fa": "بازدید", "is_failure": False})
    tid = created.json()["id"]
    flipped = await api.patch(f"/report-types/{tid}", "boss", json={"is_failure": True})
    assert flipped.status_code == 200 and flipped.json()["is_failure"] is True  # unused -> may change
    await f.report(db, "05-ELV-001", world.e1, world.elv, world.ali)  # uses INSPECTION_VISIT
    await db.commit()
    blocked = await api.patch(f"/report-types/{tid}", "boss", json={"is_failure": False})
    assert blocked.status_code == 409 and blocked.json() == {"detail": "report_type_in_use"}
    assert (await api.get("/report-types?include_inactive=true", "boss")).json()[0]["is_failure"] is True
    same = await api.patch(f"/report-types/{tid}", "boss", json={"is_failure": True, "name_fa": "بازدید ۲"})
    assert same.status_code == 200  # unchanged flag is fine, name still editable


async def test_report_type_reads_and_permissions(api, world):
    a = (await api.post("/report-types", "boss", json={"code": "AAA", "name_fa": "الف"})).json()
    await api.post("/report-types", "boss", json={"code": "BBB", "name_fa": "ب"})
    await api.post(f"/report-types/{a['id']}/deactivate", "boss")
    for who in ("ali", "exp", "aud", "omid"):
        assert [t["code"] for t in (await api.get("/report-types", who)).json()] == ["BBB"]
        assert [t["code"] for t in (await api.get("/report-types?include_inactive=true", who)).json()] == ["BBB"]
        assert (await api.post("/report-types", who, json={"code": "ZZZ", "name_fa": "z"})).status_code == 403
        assert (await api.patch(f"/report-types/{a['id']}", who, json={"name_fa": "z"})).status_code == 403
        assert (await api.post(f"/report-types/{a['id']}/activate", who)).status_code == 403
    assert [t["code"] for t in (await api.get("/report-types?include_inactive=true", "boss")).json()] == ["AAA", "BBB"]


# ======================= settings =======================

async def test_settings_list_defaults_and_permissions(api, world):
    r = await api.get("/settings", "boss")
    assert r.status_code == 200
    by_key = {s["key"]: s for s in r.json()}
    assert set(by_key) == {"REPORT_EDIT_WINDOW_HOURS", "PASSWORD_MIN_LENGTH", "LOGIN_MAX_ATTEMPTS",
                           "LOGIN_LOCKOUT_MINUTES", "LOGIN_MAX_ATTEMPTS_PER_IP"}
    w = by_key["REPORT_EDIT_WINDOW_HOURS"]
    assert (w["value"], w["default"], w["minimum"], w["maximum"], w["special_values"], w["is_default"]) == (24, 24, 0, 720, [-1], True)
    assert by_key["PASSWORD_MIN_LENGTH"]["minimum"] == 8 and all(s["label_fa"] for s in by_key.values())
    for who in ("ali", "exp", "aud"):  # AUDITOR has no settings access
        assert (await api.get("/settings", who)).status_code == 403
        assert (await api.put("/settings/PASSWORD_MIN_LENGTH", who, json={"value": 12})).status_code == 403


async def test_update_setting_validates_persists_audits_and_takes_effect(api, world, db):
    r = await api.put("/settings/PASSWORD_MIN_LENGTH", "boss", json={"value": 10})
    assert r.status_code == 200 and r.json()["value"] == 10 and r.json()["is_default"] is False
    assert r.json()["updated_by"] == world.boss.id
    assert (await audit(db, "setting.update"))[-1].metadata_json == {"key": "PASSWORD_MIN_LENGTH", "old": 8, "new": 10}
    assert (await get_auth_policy(db)).password_min_length == 10
    nine = await api.post("/users", "boss", json={"username": "x1y", "full_name": "X", "role_code": "USER", "password": "abcdefg-9"})
    assert nine.status_code == 422 and "too_short" in nine.json()["detail"]["errors"]  # the new minimum is enforced
    assert (await api.put("/settings/PASSWORD_MIN_LENGTH", "boss", json={"value": 12})).json()["value"] == 12
    assert (await audit(db, "setting.update"))[-1].metadata_json["old"] == 10


@pytest.mark.parametrize("key,value", [("PASSWORD_MIN_LENGTH", 7), ("PASSWORD_MIN_LENGTH", 65), ("LOGIN_MAX_ATTEMPTS", 2),
                                       ("LOGIN_MAX_ATTEMPTS", 21), ("LOGIN_LOCKOUT_MINUTES", 0), ("REPORT_EDIT_WINDOW_HOURS", 721),
                                       ("REPORT_EDIT_WINDOW_HOURS", -2), ("LOGIN_MAX_ATTEMPTS_PER_IP", -1)])
async def test_out_of_range_values_are_rejected_not_clamped(api, world, db, key, value):
    r = await api.put(f"/settings/{key}", "boss", json={"value": value})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "setting_out_of_range"
    assert r.json()["detail"]["key"] == key
    assert (await audit(db, "setting.update")) == []
    assert (await db.get(m.SystemSetting, key)) is None or (await db.get(m.SystemSetting, key)).value != str(value)


async def test_unknown_key_and_bad_body(api, world):
    assert (await api.put("/settings/EVIL_KEY", "boss", json={"value": 1})).status_code == 404
    assert (await api.put("/settings/PASSWORD_MIN_LENGTH", "boss", json={"value": "abc"})).status_code == 422
    assert (await api.put("/settings/PASSWORD_MIN_LENGTH", "boss", json={"value": 9, "extra": 1})).status_code == 422
    assert (await api.put("/settings/PASSWORD_MIN_LENGTH", "boss", json={})).status_code == 422


async def test_edit_window_supports_none_zero_hours_and_unlimited(api, world, db):
    assert await get_report_edit_window_hours(db) == 24  # default (no row yet)
    for value, expected in ((-1, None), (0, 0), (720, 720), (48, 48)):
        r = await api.put("/settings/REPORT_EDIT_WINDOW_HOURS", "boss", json={"value": value})
        assert r.status_code == 200 and r.json()["value"] == value
        assert await get_report_edit_window_hours(db) == expected
    assert (await audit(db, "setting.update"))[-1].metadata_json == {"key": "REPORT_EDIT_WINDOW_HOURS", "old": 720, "new": 48}


async def test_garbage_rows_never_weaken_policy(db):
    for key, raw in (("PASSWORD_MIN_LENGTH", "2"), ("LOGIN_MAX_ATTEMPTS", "abc"), ("LOGIN_LOCKOUT_MINUTES", "99999999"),
                     ("REPORT_EDIT_WINDOW_HOURS", "-7")):
        db.add(m.SystemSetting(key=key, value=raw))
    await db.commit()
    p = await get_auth_policy(db)
    assert (p.password_min_length, p.login_max_attempts, p.login_lockout_minutes) == (8, 5, 1440)
    assert await get_report_edit_window_hours(db) == 0  # clamped to the minimum, not unlimited


async def test_report_type_null_fields_are_422_not_500(api, world):
    tid = (await api.post("/report-types", "boss", json={"code": "AAA", "name_fa": "الف"})).json()["id"]
    r = await api.patch(f"/report-types/{tid}", "boss", json={"name_fa": None})
    assert r.status_code == 422 and r.json() == {"detail": "invalid_name"}
    r = await api.patch(f"/report-types/{tid}", "boss", json={"is_failure": None})
    assert r.status_code == 422 and r.json() == {"detail": "invalid_is_failure"}


async def test_writing_an_unchanged_setting_is_not_a_change(api, world, db):
    await api.put("/settings/PASSWORD_MIN_LENGTH", "boss", json={"value": 8})          # equals the default: no row, no audit
    assert (await db.get(m.SystemSetting, "PASSWORD_MIN_LENGTH")) is None
    assert await audit(db, "setting.update") == []
    await api.put("/settings/PASSWORD_MIN_LENGTH", "boss", json={"value": 12})
    again = await api.put("/settings/PASSWORD_MIN_LENGTH", "boss2", json={"value": 12})  # same value by someone else
    assert again.status_code == 200 and again.json()["value"] == 12
    assert len(await audit(db, "setting.update")) == 1
    assert again.json()["updated_by"] == world.boss.id                                    # not re-attributed
