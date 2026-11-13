"""Phase 7a — reports list / detail / equipment history: visibility and labor-row rules (SQLite, real routers + login)."""
import base64
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from tests import factories as f

pytestmark = pytest.mark.asyncio
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


async def make(db, number, equip, grp, creator, parts=(), day=0, **over):
    r = await f.report(db, number, equip, grp, creator, parts)
    r.event_datetime = T0 + timedelta(days=day)
    for k, v in over.items():
        setattr(r, k, v)
    await db.flush()
    return r


@pytest_asyncio.fixture
async def data(db, world):
    """ELV reports: a1 by ali (ali 60 + exp 30), x1 by exp (exp 45 + ali 20 + omid 10). DOOR report: d1 by omid (omid 15)."""
    w = world
    w.a1 = await make(db, "05-ELV-001", w.e1, w.elv, w.ali, [(w.ali, 60), (w.exp, 30)], day=1)
    w.x1 = await make(db, "05-ELV-002", w.e1, w.elv, w.exp, [(w.exp, 45), (w.ali, 20), (w.omid, 10)], day=2)
    w.d1r = await make(db, "05-DOOR-001", w.d1, w.door, w.omid, [(w.omid, 15)], day=3)
    await db.commit()
    return w


def numbers(resp):
    assert resp.status_code == 200, resp.text
    return [i["report_number"] for i in resp.json()["items"]]


async def test_unauthenticated_is_401(api, data):
    assert (await api.get("/reports")).status_code == 401
    assert (await api.get(f"/reports/{data.a1.id}")).status_code == 401


async def test_visibility_by_role(api, data):
    assert numbers(await api.get("/reports", "ali")) == ["05-ELV-002", "05-ELV-001"]  # newest event first, own group only
    assert numbers(await api.get("/reports", "omid")) == ["05-DOOR-001"]
    assert numbers(await api.get("/reports", "exp")) == ["05-ELV-002", "05-ELV-001"]
    for who in ("boss", "aud"):
        assert numbers(await api.get("/reports", who)) == ["05-DOOR-001", "05-ELV-002", "05-ELV-001"]


async def test_detail_of_another_group_is_404_for_user_and_expert(api, data):
    for who in ("ali", "exp"):
        assert (await api.get(f"/reports/{data.d1r.id}", who)).status_code == 404
    assert (await api.get("/reports/999999", "ali")).status_code == 404  # same answer as not-yours
    assert (await api.get(f"/reports/{data.d1r.id}", "aud")).status_code == 200


async def test_participating_in_another_group_report_grants_no_access(api, data):
    # omid is a participant of x1 (ELV) but belongs to DOOR only
    assert "05-ELV-002" not in numbers(await api.get("/reports", "omid"))
    assert (await api.get(f"/reports/{data.x1.id}", "omid")).status_code == 404


async def test_user_sees_only_his_own_row_on_a_colleagues_report(api, data):
    r = await api.get(f"/reports/{data.x1.id}", "ali")  # created by exp; ali participates with 20
    body = r.json()
    assert [(p["user_id"], p["minutes"], p["is_me"]) for p in body["participants"]] == [(data.ali.id, 20, True)]
    assert body["participants_complete"] is False
    assert body["total_minutes"] is None and body["people_count"] is None and body["my_minutes"] == 20
    row = next(i for i in (await api.get("/reports", "ali")).json()["items"] if i["id"] == data.x1.id)
    assert row["total_minutes"] is None and row["people_count"] is None and row["my_minutes"] == 20


async def test_user_sees_no_participants_when_he_is_not_in_a_colleagues_report(db, api, world):
    r = await make(db, "05-ELV-009", world.e1, world.elv, world.exp, [(world.exp, 40)])
    await db.commit()
    body = (await api.get(f"/reports/{r.id}", "ali")).json()
    assert body["participants"] == [] and body["my_minutes"] is None and body["participants_complete"] is False


async def test_user_sees_all_rows_of_reports_he_created(api, data):
    body = (await api.get(f"/reports/{data.a1.id}", "ali")).json()
    assert {(p["user_id"], p["minutes"]) for p in body["participants"]} == {(data.ali.id, 60), (data.exp.id, 30)}
    assert body["participants_complete"] is True and body["total_minutes"] == 90 and body["people_count"] == 2


async def test_expert_sees_all_rows_in_own_groups(api, data):
    body = (await api.get(f"/reports/{data.x1.id}", "exp")).json()
    assert len(body["participants"]) == 3 and body["total_minutes"] == 75 and body["participants_complete"] is True


async def test_management_and_auditor_see_all_rows_everywhere(api, data):
    for who in ("boss", "aud"):
        body = (await api.get(f"/reports/{data.x1.id}", who)).json()
        assert len(body["participants"]) == 3 and body["participants_complete"] is True


async def test_soft_deleted_reports_are_hidden_from_everyone(db, api, data):
    data.a1.is_active = False
    await db.commit()
    for who in ("ali", "exp", "boss", "aud"):
        assert "05-ELV-001" not in numbers(await api.get("/reports", who))
        assert (await api.get(f"/reports/{data.a1.id}", who)).status_code == 404


async def test_general_report_marker_and_filter(db, api, data):
    rt = await f.report_type(db, "GENERAL")
    g = await make(db, "05-ELV-003", data.e1, data.elv, data.exp, [(data.exp, 10)], day=4, is_general=True,
                   equipment_id=None, report_type_id=rt.id)
    await db.commit()
    item = next(i for i in (await api.get("/reports", "ali")).json()["items"] if i["id"] == g.id)
    assert item["equipment"] is None and item["is_general"] is True
    assert numbers(await api.get("/reports?general_only=true", "ali")) == ["05-ELV-003"]
    assert (await api.get(f"/reports/{g.id}", "ali")).json()["equipment"] is None


async def test_filters(db, api, data):
    rt = await f.report_type(db, "BREAKDOWN")
    data.x1.report_type_id = rt.id
    await db.commit()
    assert numbers(await api.get(f"/reports?report_type_id={rt.id}", "boss")) == ["05-ELV-002"]
    assert numbers(await api.get("/reports?equipment_code=door", "boss")) == ["05-DOOR-001"]  # partial, case-insensitive
    assert numbers(await api.get("/reports?report_number=elv-001", "boss")) == ["05-ELV-001"]
    assert numbers(await api.get(f"/reports?created_by={data.exp.id}", "boss")) == ["05-ELV-002"]
    assert numbers(await api.get(f"/reports?group_id={data.door.id}", "boss")) == ["05-DOOR-001"]
    assert numbers(await api.get(f"/reports?group_id={data.door.id}", "ali")) == []  # a filter never widens the scope
    assert numbers(await api.get("/reports?q=%25", "boss")) == []  # LIKE wildcards are literal
    assert numbers(await api.get("/reports?q=t", "boss")) == ["05-DOOR-001", "05-ELV-002", "05-ELV-001"]
    cut = (T0 + timedelta(days=1, hours=12)).isoformat()
    assert numbers(await api.get("/reports", "boss", params={"date_from": cut})) == ["05-DOOR-001", "05-ELV-002"]
    assert numbers(await api.get("/reports", "boss", params={"date_to": cut})) == ["05-ELV-001"]


async def test_my_participation_filter(api, data):
    assert numbers(await api.get("/reports?mine=true", "ali")) == ["05-ELV-002", "05-ELV-001"]
    assert numbers(await api.get("/reports?mine=true", "exp")) == ["05-ELV-002", "05-ELV-001"]
    assert numbers(await api.get("/reports?mine=true", "omid")) == ["05-DOOR-001"]  # x1 is not visible to him
    assert numbers(await api.get("/reports?mine=true", "boss")) == []


async def test_cursor_pagination_has_no_gaps_or_repeats_with_equal_times(db, api, world):
    for i in range(7):
        await make(db, f"05-ELV-{i:03d}", world.e1, world.elv, world.exp, [(world.exp, 5)], day=i // 3)  # equal event times
    await db.commit()
    seen, cursor = [], None
    while True:
        r = (await api.get("/reports", "exp", params={"limit": 3, **({"cursor": cursor} if cursor else {})})).json()
        seen += [i["report_number"] for i in r["items"]]
        cursor = r["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 7 and len(set(seen)) == 7
    assert seen == [i["report_number"] for i in (await api.get("/reports?limit=100", "exp")).json()["items"]]
    asc = [i["report_number"] for i in (await api.get("/reports?order=asc&limit=100", "exp")).json()["items"]]
    assert asc == list(reversed(seen))


async def test_sort_and_cursor_validation(api, data):
    assert (await api.get("/reports?sort_by=created_at", "ali")).status_code == 200
    assert (await api.get("/reports?sort_by=description", "ali")).status_code == 422
    assert (await api.get("/reports?cursor=not-a-cursor", "ali")).status_code == 422
    assert (await api.get("/reports?limit=0", "ali")).status_code == 422
    for forged in ('{"v": "2026-01-01T00:00:00+00:00", "i": 1e999}', '{"v": "2026-01-01T00:00:00+00:00", "i": 1000000000000000000000000000000}',
                   '{"v": "2026-01-01T00:00:00+00:00", "i": true}', '{"v": "x", "i": 1}', '[1]'):
        c = base64.urlsafe_b64encode(forged.encode()).decode()
        assert (await api.get("/reports", "ali", params={"cursor": c})).status_code == 422, forged


async def test_naive_date_filters_are_rejected(api, data):
    for name in ("date_from", "date_to"):
        assert (await api.get("/reports", "ali", params={name: "2026-01-01T00:00:00"})).status_code == 422


async def test_equipment_history_flag_for_moved_equipment(db, api, world):
    await make(db, "05-DOOR-005", world.e1, world.door, world.omid, [(world.omid, 5)], day=1)  # e1 once belonged to DOOR
    await make(db, "05-ELV-005", world.e1, world.elv, world.exp, [(world.exp, 5)], day=2)
    await db.commit()
    r = (await api.get(f"/reports?equipment_id={world.e1.id}", "ali")).json()
    assert [i["report_number"] for i in r["items"]] == ["05-ELV-005"] and r["other_group_reports_may_exist"] is True
    r = (await api.get(f"/reports?equipment_id={world.e1.id}", "boss")).json()
    assert len(r["items"]) == 2 and r["other_group_reports_may_exist"] is False
    assert (await api.get("/reports", "ali")).json()["other_group_reports_may_exist"] is False  # only with the filter
    # probing: ali has no visible report of d1 and is not in DOOR, although DOOR has reports of it
    await make(db, "05-DOOR-007", world.d1, world.door, world.omid, [(world.omid, 5)], day=1)
    await db.commit()
    assert (await api.get(f"/reports?equipment_id={world.d1.id}", "ali")).json()["other_group_reports_may_exist"] is False
    e3 = await f.equipment(db, "ELV-3", world.elv)  # moved INTO ELV: only DOOR reports exist, none visible to ali
    await make(db, "05-DOOR-008", e3, world.door, world.omid, [(world.omid, 5)], day=1)
    await db.commit()
    assert (await api.get(f"/reports?equipment_id={e3.id}", "ali")).json()["other_group_reports_may_exist"] is True
    e2 = await f.equipment(db, "ELV-2", world.elv)
    await make(db, "05-ELV-006", e2, world.elv, world.exp, [(world.exp, 5)], day=3)
    await db.commit()
    assert (await api.get(f"/reports?equipment_id={e2.id}", "ali")).json()["other_group_reports_may_exist"] is False


async def test_columns_registry_by_role(api, data):
    user_cols = {c["key"] for c in (await api.get("/reports/columns", "ali")).json()}
    assert {"report_number", "event_datetime", "description_summary", "my_minutes"} <= user_cols
    assert {c["key"] for c in (await api.get("/reports/columns", "aud")).json()} >= {"total_minutes", "people_count"}
    sortable = {c["key"] for c in (await api.get("/reports/columns", "boss")).json() if c["sortable"]}
    assert sortable == {"event_datetime", "created_at"}


async def test_list_never_carries_other_peoples_minutes_for_a_user(api, data):
    for item in (await api.get("/reports?limit=100", "ali")).json()["items"]:
        if item["id"] != data.a1.id:  # ali created only a1
            assert item["total_minutes"] is None and item["people_count"] is None
