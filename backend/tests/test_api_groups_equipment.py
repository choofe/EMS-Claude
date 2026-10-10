import pytest
from sqlalchemy import select

import app.models as m
from tests import factories as f


async def audit(db, action):
    return (await db.execute(select(m.AuditLog).where(m.AuditLog.action == action).order_by(m.AuditLog.id))).scalars().all()


def codes(resp, key="code"):
    return [i[key] for i in resp.json()["items"]]


# ======================= groups =======================

async def test_create_group_canonicalises_and_rejects_bad_or_duplicate_codes(api, world, db):
    r = await api.post("/groups", "boss", json={"code": " esc ", "name": "  Escalator   Team ", "description": "  x  y "})
    assert r.status_code == 201
    g = r.json()
    assert g["code"] == "ESC" and g["name"] == "Escalator Team" and g["description"] == "x y"
    assert g["equipment_count"] == 0 and g["member_count"] == 0 and g["is_active"] is True
    assert (await audit(db, "group.create"))[-1].metadata_json == {"code": "ESC", "name": "Escalator Team"}
    dup = await api.post("/groups", "boss", json={"code": "elv", "name": "Again"})
    assert dup.status_code == 409 and dup.json() == {"detail": "group_code_taken"}
    for bad in ("A", "1AB", "A-B", "A B", "x" * 17):
        assert (await api.post("/groups", "boss", json={"code": bad, "name": "N"})).status_code == 422, bad
    assert (await api.post("/groups", "boss", json={"code": "OK1", "name": "   "})).status_code == 422


async def test_group_code_is_immutable_name_and_description_editable(api, world, db):
    gid = world.elv.id
    assert (await api.patch(f"/groups/{gid}", "boss", json={"code": "NEW"})).status_code == 422  # field does not exist
    r = await api.patch(f"/groups/{gid}", "boss", json={"name": "Lifts", "description": "all lifts"})
    assert r.status_code == 200 and r.json()["name"] == "Lifts" and r.json()["code"] == "ELV"
    assert (await audit(db, "group.update"))[-1].metadata_json["changes"]["name"] == ["Elevator", "Lifts"]
    n = len(await audit(db, "group.update"))
    await api.patch(f"/groups/{gid}", "boss", json={"name": "Lifts"})  # no change -> no audit row
    assert len(await audit(db, "group.update")) == n
    cleared = await api.patch(f"/groups/{gid}", "boss", json={"description": None})
    assert cleared.json()["description"] is None
    assert (await api.patch("/groups/9999", "boss", json={"name": "x"})).status_code == 404


async def test_group_with_active_equipment_cannot_be_deactivated(api, world, db):
    r = await api.post(f"/groups/{world.elv.id}/deactivate", "boss")
    assert r.status_code == 409 and r.json()["detail"] == {"code": "group_has_active_equipment", "count": 1}
    assert (await api.post(f"/equipment/{world.e1.id}/deactivate", "boss")).status_code == 200
    ok = await api.post(f"/groups/{world.elv.id}/deactivate", "boss")
    assert ok.status_code == 200 and ok.json()["is_active"] is False
    assert (await api.post(f"/groups/{world.elv.id}/activate", "boss")).json()["is_active"] is True
    assert [a.action for a in await audit(db, "group.deactivate")] == ["group.deactivate"]


async def test_group_reads_are_scoped_and_hide_other_groups(api, world):
    assert codes(await api.get("/groups", "ali")) == ["ELV"]
    assert codes(await api.get("/groups", "omid")) == ["DOOR"]
    assert codes(await api.get("/groups", "exp")) == ["ELV"]
    for who in ("aud", "boss"):
        assert codes(await api.get("/groups", who)) == ["DOOR", "ELV"]
    other, missing = await api.get(f"/groups/{world.door.id}", "ali"), await api.get("/groups/999999", "ali")
    assert other.status_code == missing.status_code == 404 and other.json() == missing.json()  # no existence oracle
    assert (await api.get(f"/groups/{world.elv.id}", "ali")).json()["code"] == "ELV"


async def test_inactive_groups_visible_only_to_all_scope_on_request(api, world, db):
    await api.post(f"/equipment/{world.d1.id}/deactivate", "boss")
    await api.post(f"/groups/{world.door.id}/deactivate", "boss")
    assert codes(await api.get("/groups", "boss")) == ["ELV"]
    assert codes(await api.get("/groups?include_inactive=true", "boss")) == ["DOOR", "ELV"]
    assert codes(await api.get("/groups?include_inactive=true", "aud")) == ["DOOR", "ELV"]
    assert codes(await api.get("/groups?include_inactive=true", "omid")) == []  # members never see inactive groups
    assert (await api.get(f"/groups/{world.door.id}", "omid")).status_code == 404
    assert (await api.get(f"/groups/{world.door.id}", "boss")).status_code == 200


async def test_group_counts_and_write_permissions(api, world):
    g = (await api.get(f"/groups/{world.elv.id}", "boss")).json()
    assert g["equipment_count"] == 1 and g["member_count"] == 2  # ELV-1; exp + ali
    for who in ("ali", "exp", "aud"):
        assert (await api.post("/groups", who, json={"code": "ZZ", "name": "n"})).status_code == 403
        assert (await api.patch(f"/groups/{world.elv.id}", who, json={"name": "n"})).status_code == 403
        assert (await api.post(f"/groups/{world.elv.id}/deactivate", who)).status_code == 403
        assert (await api.post(f"/groups/{world.elv.id}/activate", who)).status_code == 403


# ======================= equipment =======================

async def test_create_equipment_is_canonical_and_case_insensitively_unique(api, world, db):
    r = await api.post("/equipment", "boss", json={"equipment_code": " elv-002.a/1 ", "group_id": world.elv.id, "description": " main  lift "})
    assert r.status_code == 201
    e = r.json()
    assert e["equipment_code"] == "ELV-002.A/1" and e["group_code"] == "ELV" and e["description"] == "main lift"
    assert (await audit(db, "equipment.create"))[-1].metadata_json == {"equipment_code": "ELV-002.A/1", "group_id": world.elv.id}
    for variant in ("ELV-1", "elv-1", "Elv-1"):
        d = await api.post("/equipment", "boss", json={"equipment_code": variant, "group_id": world.elv.id})
        assert d.status_code == 409 and d.json() == {"detail": "equipment_code_taken"}, variant
    for bad in ("has space", "ELV 001", "فارسی", "-X", "A#1", "x" * 65):
        assert (await api.post("/equipment", "boss", json={"equipment_code": bad, "group_id": world.elv.id})).status_code == 422, bad
    assert (await api.post("/equipment", "boss", json={"equipment_code": "OK-1", "group_id": 9999})).status_code == 404


async def test_equipment_cannot_be_created_in_inactive_group(api, world):
    await api.post(f"/equipment/{world.d1.id}/deactivate", "boss")
    await api.post(f"/groups/{world.door.id}/deactivate", "boss")
    r = await api.post("/equipment", "boss", json={"equipment_code": "DOOR-9", "group_id": world.door.id})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "group_inactive"
    back = await api.post(f"/equipment/{world.d1.id}/activate", "boss")  # cannot reactivate into a deactivated group
    assert back.status_code == 409 and back.json()["detail"]["code"] == "group_inactive"


async def test_equipment_code_immutable_description_editable(api, world, db):
    eid = world.e1.id
    assert (await api.patch(f"/equipment/{eid}", "boss", json={"equipment_code": "X-9"})).status_code == 422
    assert (await api.patch(f"/equipment/{eid}", "boss", json={"group_id": world.door.id})).status_code == 422  # move has its own endpoint
    r = await api.patch(f"/equipment/{eid}", "boss", json={"description": "cabin 4"})
    assert r.json()["description"] == "cabin 4" and r.json()["equipment_code"] == "ELV-1"
    assert (await audit(db, "equipment.update"))[-1].metadata_json["changes"]["description"] == [None, "cabin 4"]


async def test_move_equipment_is_audited_and_never_rewrites_report_history(api, world, db):
    report = await f.report(db, "05-ELV-001", world.e1, world.elv, world.ali)
    await db.commit()
    report_id, elv_id, e1_id, door_id = report.id, world.elv.id, world.e1.id, world.door.id
    r = await api.post(f"/equipment/{world.e1.id}/move", "boss", json={"group_id": world.door.id})
    assert r.status_code == 200 and r.json()["group_code"] == "DOOR"
    assert (await audit(db, "equipment.move"))[-1].metadata_json == {
        "equipment_code": "ELV-1", "from_group_id": world.elv.id, "to_group_id": world.door.id}
    db.expire_all()
    assert (await db.get(m.Report, report_id)).group_id == elv_id  # reports keep their frozen group
    same = await api.post(f"/equipment/{e1_id}/move", "boss", json={"group_id": door_id})
    assert same.status_code == 409 and same.json() == {"detail": "same_group"}
    assert (await api.post(f"/equipment/{e1_id}/move", "boss", json={"group_id": 9999})).status_code == 404
    assert (await api.post("/equipment/9999/move", "boss", json={"group_id": elv_id})).status_code == 404


async def test_move_into_inactive_group_rejected(api, world):
    await api.post(f"/equipment/{world.d1.id}/deactivate", "boss")
    await api.post(f"/groups/{world.door.id}/deactivate", "boss")
    r = await api.post(f"/equipment/{world.e1.id}/move", "boss", json={"group_id": world.door.id})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "group_inactive"


async def test_equipment_listing_is_group_scoped_and_follows_moves(api, world):
    assert codes(await api.get("/equipment", "ali"), "equipment_code") == ["ELV-1"]
    assert codes(await api.get("/equipment", "omid"), "equipment_code") == ["DOOR-1"]
    assert codes(await api.get(f"/equipment?group_id={world.door.id}", "ali"), "equipment_code") == []  # other group: nothing
    await api.post(f"/equipment/{world.e1.id}/move", "boss", json={"group_id": world.door.id})
    assert codes(await api.get("/equipment", "ali"), "equipment_code") == []
    assert codes(await api.get("/equipment", "omid"), "equipment_code") == ["DOOR-1", "ELV-1"]
    for who in ("boss", "aud"):
        assert codes(await api.get("/equipment", who), "equipment_code") == ["DOOR-1", "ELV-1"]


async def test_inactive_equipment_hidden_from_non_all_scopes(api, world):
    await api.post(f"/equipment/{world.e1.id}/deactivate", "boss")
    assert codes(await api.get("/equipment", "ali"), "equipment_code") == []
    assert codes(await api.get("/equipment?is_active=false", "ali"), "equipment_code") == []  # filter cannot widen scope
    assert (await api.get(f"/equipment/{world.e1.id}", "ali")).status_code == 404
    assert codes(await api.get("/equipment?is_active=false", "boss"), "equipment_code") == ["ELV-1"]
    assert codes(await api.get("/equipment?is_active=true", "boss"), "equipment_code") == ["DOOR-1"]
    assert (await api.get(f"/equipment/{world.e1.id}", "boss")).json()["is_active"] is False
    assert (await api.post(f"/equipment/{world.e1.id}/activate", "boss")).json()["is_active"] is True


async def test_equipment_search_is_partial_case_insensitive_and_literal(api, world):
    await api.post("/equipment", "boss", json={"equipment_code": "ELV-100", "group_id": world.elv.id})
    assert codes(await api.get("/equipment?q=elv", "boss"), "equipment_code") == ["ELV-1", "ELV-100"]
    assert codes(await api.get("/equipment?q=-10", "boss"), "equipment_code") == ["ELV-100"]
    assert codes(await api.get("/equipment?q=%25", "boss"), "equipment_code") == []  # literal '%', not a wildcard
    assert codes(await api.get("/equipment?q=_", "boss"), "equipment_code") == []
    page = (await api.get("/equipment?limit=1&offset=1", "boss")).json()
    assert page["total"] == 3 and len(page["items"]) == 1


async def test_equipment_get_out_of_scope_looks_like_missing(api, world):
    other, missing = await api.get(f"/equipment/{world.d1.id}", "ali"), await api.get("/equipment/999999", "ali")
    assert other.status_code == missing.status_code == 404 and other.json() == missing.json()
    assert (await api.get(f"/equipment/{world.e1.id}", "ali")).status_code == 200


@pytest.mark.parametrize("who", ["ali", "exp", "aud"])
async def test_only_management_writes_equipment(api, world, who):
    eid = world.e1.id
    calls = [("POST", "/equipment", dict(json={"equipment_code": "Z-1", "group_id": world.elv.id})),
             ("PATCH", f"/equipment/{eid}", dict(json={"description": "x"})),
             ("POST", f"/equipment/{eid}/move", dict(json={"group_id": world.door.id})),
             ("POST", f"/equipment/{eid}/deactivate", {}), ("POST", f"/equipment/{eid}/activate", {})]
    for method, path, kw in calls:
        assert (await api.call(method, path, who, **kw)).status_code == 403, (who, method, path)


async def test_explicit_null_for_non_nullable_fields_is_a_422_not_a_500(api, world):
    r = await api.patch(f"/groups/{world.elv.id}", "boss", json={"name": None})
    assert r.status_code == 422 and r.json() == {"detail": "invalid_name"}
    assert (await api.patch(f"/groups/{world.elv.id}", "boss", json={"description": None})).status_code == 200  # nullable: clears it


@pytest.mark.parametrize("path", ["/users", "/groups", "/equipment"])
async def test_offset_is_bounded(api, world, path):
    assert (await api.get(f"{path}?offset=100000", "boss")).status_code == 200
    assert (await api.get(f"{path}?offset=100001", "boss")).status_code == 422
    assert (await api.get(f"{path}?offset=2147483647&limit=100", "boss")).status_code == 422
