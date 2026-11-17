"""Sub-phase Pg — personnel import history, two-step cancel, CSV problem report. Real routers, real login, SQLite
(PostgreSQL races are in tests/postgres/test_personnel_import_history_pg.py)."""
import json

import pytest
from sqlalchemy import func, select

import app.models as m
from app.services import personnel_import_history as history
from tests import factories as f
from tests.test_personnel_import_api import code_of, commit, make_xlsx, preview

ROWS = [[f"Name{i}", f"Family{i}", 100 + i, f"0912000010{i}", "ELV" if i % 2 else None] for i in range(5)]
BASE = "/personnel/import"


async def batch_of(api, db, rows=ROWS):
    r = await commit(api, "boss", make_xlsx(rows))
    assert r.status_code == 201, r.text
    people = (await db.execute(select(m.User).where(m.User.import_batch_id == r.json()["batch_id"])
                               .order_by(m.User.personnel_code))).scalars().all()
    return r.json()["batch_id"], people


async def cancel_preview(api, who, batch_id):
    return await api.post(f"{BASE}/batches/{batch_id}/cancel-preview", who)


async def cancel(api, who, batch_id, fingerprint):
    return await api.post(f"{BASE}/batches/{batch_id}/cancel", who, json={"fingerprint": fingerprint})


async def exists_count(db, ids):
    return (await db.execute(select(func.count(m.User.id)).where(m.User.id.in_(ids)))).scalar_one()


# ---------------------------------------------------------------- history list and people
async def test_history_lists_batches_newest_first_with_live_counts(api, world, db):
    first, _ = await batch_of(api, db, ROWS[:2])
    second, _ = await batch_of(api, db, [["Z", "Z", 900, "09129999999", None]])
    body = (await api.get(f"{BASE}/batches", "boss")).json()
    assert body["total"] == 2 and [i["id"] for i in body["items"]] == [second, first]
    item = body["items"][1]
    assert (item["kind"], item["created_count"], item["removed_count"], item["remaining_count"], item["status"]) == \
           ("PERSONNEL", 2, 0, 2, "complete")
    assert item["created_by_name"] == world.boss.full_name and item["undone_at"] is None


async def test_history_is_for_management_and_auditor_only(api, world, db):
    bid, _ = await batch_of(api, db)
    assert (await api.get(f"{BASE}/batches", "aud")).status_code == 200
    assert (await api.get(f"{BASE}/batches/{bid}/people", "aud")).status_code == 200
    for who in ("exp", "ali"):
        assert (await api.get(f"{BASE}/batches", who)).status_code == 403
        assert (await api.get(f"{BASE}/batches/{bid}/people", who)).status_code == 403
        assert (await cancel_preview(api, who, bid)).status_code == 403
    assert (await api.get(f"{BASE}/batches")).status_code == 401


async def test_batch_people_show_current_data_and_mobile_only_with_the_capability(api, world, db):
    bid, people = await batch_of(api, db)
    people[0].first_name, people[0].last_name, people[0].full_name = "Renamed", "Person", "Renamed Person"
    await db.commit()
    body = (await api.get(f"{BASE}/batches/{bid}/people", "aud")).json()
    assert body["total"] == 5
    first = body["items"][0]
    assert first["full_name"] == "Renamed Person" and first["personnel_code"] == 100 and first["has_profile"] is False
    assert first["mobile"] == "09120000100" and body["items"][1]["group_codes"] == ["ELV"]
    assert (await api.get(f"{BASE}/batches/999/people", "boss")).status_code == 404


# ---------------------------------------------------------------- cancel preview
async def use_some(db, world, people):
    """people[0] participates in a report, [1] created one, [2] is starred, [3] got a profile, [4] stays free."""
    await f.report(db, "26-ELV-001", world.e1, world.elv, world.ali, participants=[(people[0], 30)])
    await f.report(db, "26-ELV-002", world.e1, world.elv, people[1])
    db.add(m.FavoritePerson(owner_id=world.ali.id, favorite_user_id=people[2].id))
    admin = await f.role(db, "USER")
    people[3].username, people[3].hashed_password, people[3].role_id, people[3].login_enabled = "p3", "x", admin.id, True
    await db.commit()


async def test_preview_counts_what_would_go_and_what_is_kept_and_writes_nothing(api, world, db):
    bid, people = await batch_of(api, db)
    await use_some(db, world, people)
    r = await cancel_preview(api, "boss", bid)
    assert r.status_code == 200
    body = r.json()
    assert (body["remaining_count"], body["removable_count"], body["exempt_count"]) == (5, 1, 4)
    assert body["exempt_reasons"] == {"profile": 1, "reports": 1, "participation": 1, "stars": 1}
    assert len(body["fingerprint"]) == 64 and await exists_count(db, [p.id for p in people]) == 5
    assert "names" not in r.text and "Name" not in r.text and "0912" not in r.text


async def test_a_star_on_either_side_keeps_the_person(api, world, db):
    bid, people = await batch_of(api, db, ROWS[:2])
    db.add(m.FavoritePerson(owner_id=people[0].id, favorite_user_id=world.ali.id))  # he is the star OWNER
    await db.commit()
    body = (await cancel_preview(api, "boss", bid)).json()
    assert (body["removable_count"], body["exempt_reasons"]["stars"]) == (1, 1)


# ---------------------------------------------------------------- cancel confirm
async def test_cancel_removes_only_unused_people_and_keeps_the_batch(api, world, db):
    bid, people = await batch_of(api, db)
    await use_some(db, world, people)
    free_id, free_code, kept_ids = people[4].id, people[4].personnel_code, [p.id for p in people[:4]]
    boss_id = world.boss.id
    fp = (await cancel_preview(api, "boss", bid)).json()["fingerprint"]
    r = await cancel(api, "boss", bid, fp)
    assert r.status_code == 200 and r.json() == {"batch_id": bid, "removed_count": 1, "kept_count": 4}
    assert await exists_count(db, [free_id]) == 0 and await exists_count(db, kept_ids) == 4
    db.expire_all()
    batch = await db.get(m.PersonnelImportBatch, bid)
    assert (batch.removed_count, batch.undone_by) == (1, boss_id) and batch.undone_at is not None
    item = (await api.get(f"{BASE}/batches", "boss")).json()["items"][0]
    assert (item["status"], item["remaining_count"], item["removed_count"], item["created_count"]) == ("partial", 4, 1, 5)
    audit = (await db.execute(select(m.AuditLog).where(m.AuditLog.action == "personnel.import_cancel"))).scalars().one()
    assert audit.actor_id == boss_id and audit.entity_id == bid
    assert audit.metadata_json == {"removed": 1, "kept": 4, "remaining_before": 5}
    assert str(free_code) not in json.dumps(audit.metadata_json) and "912" not in json.dumps(audit.metadata_json)


async def test_group_memberships_of_removed_people_go_with_them(api, world, db):
    bid, people = await batch_of(api, db, [["A", "A", 10, "09120000001", "ELV;DOOR"]])
    pid = people[0].id
    fp = (await cancel_preview(api, "boss", bid)).json()["fingerprint"]
    assert (await cancel(api, "boss", bid, fp)).status_code == 200
    assert (await db.execute(select(func.count()).select_from(m.UserGroup).where(m.UserGroup.user_id == pid))).scalar_one() == 0
    assert (await api.get(f"{BASE}/batches", "boss")).json()["items"][0]["status"] == "cancelled"


async def test_a_second_cancel_can_remove_the_people_who_became_unused(api, world, db):
    bid, people = await batch_of(api, db, ROWS[:3])
    star = m.FavoritePerson(owner_id=world.ali.id, favorite_user_id=people[0].id)
    db.add(star)
    await db.commit()
    assert (await cancel(api, "boss", bid, (await cancel_preview(api, "boss", bid)).json()["fingerprint"])).json()["removed_count"] == 2
    await db.delete(star)
    await db.commit()
    again = await cancel(api, "boss2", bid, (await cancel_preview(api, "boss2", bid)).json()["fingerprint"])
    assert again.status_code == 200 and again.json()["removed_count"] == 1  # any manager, for any batch
    db.expire_all()
    assert (await db.get(m.PersonnelImportBatch, bid)).removed_count == 3
    r = await cancel_preview(api, "boss", bid)
    assert r.json()["remaining_count"] == 0
    r = await cancel(api, "boss", bid, r.json()["fingerprint"])
    assert r.status_code == 409 and code_of(r) == "nothing_to_cancel"


async def test_a_changed_batch_is_refused_with_the_new_counts_and_nothing_is_deleted(api, world, db):
    bid, people = await batch_of(api, db, ROWS[:3])
    fp = (await cancel_preview(api, "boss", bid)).json()["fingerprint"]
    await f.report(db, "26-ELV-009", world.e1, world.elv, world.ali, participants=[(people[1], 20)])  # used since the preview
    await db.commit()
    r = await cancel(api, "boss", bid, fp)
    assert r.status_code == 409 and code_of(r) == "batch_changed"
    assert r.json()["detail"]["removable_count"] == 2 and r.json()["detail"]["exempt_count"] == 1
    assert await exists_count(db, [p.id for p in people]) == 3
    fresh = (await cancel_preview(api, "boss", bid)).json()["fingerprint"]
    assert (await cancel(api, "boss", bid, fresh)).json()["removed_count"] == 2  # the new preview is the new basis


async def test_a_fingerprint_of_another_batch_or_a_wrong_one_is_refused(api, world, db):
    first, _ = await batch_of(api, db, ROWS[:1])
    second, _ = await batch_of(api, db, [["Q", "Q", 700, "09127000000", None]])
    fp_first = (await cancel_preview(api, "boss", first)).json()["fingerprint"]
    assert code_of(await cancel(api, "boss", second, fp_first)) == "batch_changed"
    assert (await cancel(api, "boss", second, "0" * 64)).status_code == 409
    assert (await cancel(api, "boss", second, "short")).status_code == 422


async def test_auditor_cannot_cancel_and_an_unknown_batch_is_404(api, world, db):
    bid, people = await batch_of(api, db, ROWS[:1])
    assert (await cancel(api, "aud", bid, "0" * 64)).status_code == 403
    assert (await cancel_preview(api, "aud", bid)).status_code == 403
    assert (await cancel_preview(api, "boss", 999)).status_code == 404
    assert (await cancel(api, "boss", 999, "0" * 64)).status_code == 404
    assert await exists_count(db, [people[0].id]) == 1


async def test_cancelled_codes_and_mobiles_can_be_imported_again(api, world, db):
    bid, _ = await batch_of(api, db, ROWS[:2])
    await cancel(api, "boss", bid, (await cancel_preview(api, "boss", bid)).json()["fingerprint"])
    r = await commit(api, "boss", make_xlsx(ROWS[:2]))
    assert r.status_code == 201 and r.json()["created_count"] == 2


# ---------------------------------------------------------------- CSV problem report
async def csv_of(api, who, data, corrections=None):
    form = {"corrections": corrections} if corrections is not None else {}
    return await api.post(f"{BASE}/problems.csv", who, data=form,
                          files={"file": ("p.xlsx", data, "application/octet-stream")})


async def test_problem_csv_lists_problem_rows_without_mobile_or_owner(api, world, db):
    await f.person(db, "Old", "Timer", code=50, mobile="09125550000")
    await db.commit()
    data = make_xlsx([["Good", "One", 60, "09120000060", "ELV"], ["Bad", "Code", 50, "09120000061", None],
                      ["Bad", "Mobile", 61, "09125550000", None], ["Bad", "Group", 62, "09120000062", "NOPE"]])
    r = await csv_of(api, "boss", data)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"] and r.headers["cache-control"] == "no-store"
    assert r.content.startswith("\ufeff".encode())
    lines = r.content.decode("utf-8-sig").strip().split("\r\n")
    assert lines[0] == "row,personnel_code,problem_code,description_fa"
    assert lines[1].startswith("3,50,personnel_code_taken,") and lines[2].startswith("4,61,mobile_taken,")
    assert lines[3].startswith("5,62,group_unknown,") and "NOPE" in lines[3] and len(lines) == 4
    for secret in ("0912", "09125550000", "Old", "Timer"):
        assert secret not in r.content.decode("utf-8-sig")


async def test_problem_csv_follows_the_corrections_and_neutralises_formulas(api, world, db):
    data = make_xlsx([["A", "A", 70, "09120000070", "NOPE"], ["B", "B", "-5", "09120000071", None]])
    lines = (await csv_of(api, "boss", data)).content.decode("utf-8-sig").strip().split("\r\n")
    assert any(l.startswith("3,'-5,invalid_personnel_code") for l in lines)  # typed «-5» cannot become a formula
    ops = json.dumps([{"row": 2, "op": "drop"}])
    lines = (await csv_of(api, "boss", data, ops)).content.decode("utf-8-sig").strip().split("\r\n")
    assert len(lines) == 2 and lines[1].startswith("3,")


async def test_problem_csv_is_management_only_and_validates_its_input(api, world, db):
    data = make_xlsx(ROWS[:1])
    assert (await csv_of(api, "aud", data)).status_code == 403
    assert (await csv_of(api, "ali", data)).status_code == 403
    assert (await csv_of(api, "boss", data, "not json")).status_code == 422
    r = await csv_of(api, "boss", data)
    assert r.content.decode("utf-8-sig").strip() == "row,personnel_code,problem_code,description_fa"


def test_csv_cell_prefixes_everything_a_spreadsheet_could_run():
    for bad in ("=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"):
        assert history.csv_cell(bad) == "'" + bad
    assert history.csv_cell("12") == "12" and history.csv_cell("ELV") == "ELV" and history.csv_cell(7) == "7"


def test_every_problem_code_has_a_persian_text():
    """The CSV maps codes itself; a code added to the import without a text here would show up as a raw code."""
    import inspect
    import re
    from app.services import personnel_import
    src = inspect.getsource(personnel_import)
    literal = set(re.findall(r'_error\([^\n]*?"((?:[a-z]+_)+[a-z]+)"', src)) | set(re.findall(r'code="((?:[a-z]+_)+[a-z]+)"', src))
    literal |= {f"missing_{n}" for n in ("first_name", "last_name", "personnel_code", "mobile")}
    literal |= {"formula_not_allowed", "date_cell"}
    assert len(literal) >= 12
    assert not [c for c in literal if c not in history.PROBLEM_FA], literal - set(history.PROBLEM_FA)


async def test_service_hides_the_mobile_when_the_viewer_lacks_the_capability(api, world, db):
    """Both roles that can open the history hold the capability today, so the HTTP layer cannot show this branch."""
    bid, _ = await batch_of(api, db, ROWS[:1])
    items, _total = await history.batch_people(db, batch_id=bid, limit=10, offset=0, with_mobile=False)
    assert items[0]["mobile"] is None
    items, _total = await history.batch_people(db, batch_id=bid, limit=10, offset=0, with_mobile=True)
    assert items[0]["mobile"] == "09120000100"
