"""Sub-phase Pd — personnel import: preview with corrections, transactional commit, audit. Real routers and the
real login flow on SQLite (PostgreSQL concurrency is in tests/postgres/test_personnel_import_pg.py)."""
import hashlib
import io
import json

import pytest
from openpyxl import Workbook
from sqlalchemy import func, select

import app.models as m
from app.core.errors import DomainError
from app.services import auth_service, personnel_import
from app.services.personnel_admin import create_person
from tests import factories as f

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
HEADER = ["first_name", "last_name", "personnel_code", "mobile", "groups"]
GOOD = [["علی", "رضایی", 12, "09121234567", "ELV"], ["Sara", "Ahmadi", 13, "09127654321", None]]


def make_xlsx(rows, header=HEADER):
    wb = Workbook()
    ws = wb.active
    ws.append(header)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fix(*ops):
    return json.dumps(list(ops))


async def preview(api, who, data, corrections=None):
    form = {"corrections": corrections} if corrections is not None else {}
    return await api.post("/personnel/import/preview", who, data=form, files={"file": ("p.xlsx", data, XLSX)})


async def commit(api, who, data, corrections=None, digest=None):
    form = {"preview_sha256": digest or sha(data), **({"corrections": corrections} if corrections is not None else {})}
    return await api.post("/personnel/import/commit", who, data=form, files={"file": ("p.xlsx", data, XLSX)})


def code_of(r):
    d = r.json()["detail"]
    return d if isinstance(d, str) else d["code"]


async def count(db, model):
    return (await db.execute(select(func.count()).select_from(model))).scalar_one()


async def people(db):
    return (await db.execute(select(m.User).where(m.User.import_batch_id.is_not(None)).order_by(m.User.personnel_code))).scalars().all()


async def group_codes(db, user_id):
    return set((await db.execute(select(m.Group.code).join(m.UserGroup, m.UserGroup.group_id == m.Group.id)
                                 .where(m.UserGroup.user_id == user_id))).scalars().all())


BAD = [["Reza", "Karimi", 20, "09120000001", "ELEV;ESC"],   # ELEV unknown, ESC valid
       ["Mina", "Nouri", 21, "09120000002", "OLD"]]         # inactive group


@pytest.fixture
async def esc_old(db, world):
    esc, old = await f.group(db, "ESC"), await f.group(db, "OLD")
    old.is_active = False
    await db.commit()
    return esc, old


# ---------------------------------------------------------------- preview
async def test_preview_writes_nothing_and_never_shows_a_mobile(api, world, db):
    data = make_xlsx(GOOD)
    r = await preview(api, "boss", data)
    assert r.status_code == 200
    body = r.json()
    assert body["valid_count"] == 2 and body["group_issue_count"] == 0 and body["dropped_count"] == 0
    assert body["file_sha256"] == sha(data)
    assert await count(db, m.PersonnelImportBatch) == 0 and not await people(db)
    assert "9121234567" not in r.text and "9127654321" not in r.text


async def test_preview_applies_corrections_and_recomputes_the_summary(api, world, db, esc_old):
    data = make_xlsx(BAD)
    body = (await preview(api, "boss", data)).json()
    assert body["group_issue_count"] == 2
    ops = fix({"row": 2, "op": "replace", "token": "ELEV", "to": "elv"}, {"row": 3, "op": "drop"})
    body = (await preview(api, "boss", data, ops)).json()
    assert body["group_issue_count"] == 0 and body["dropped_count"] == 1 and body["valid_count"] == 1
    assert body["sample"] == [{"row": 2, "personnel_code": 20, "full_name": "Reza Karimi", "group_codes": ["ESC", "ELV"]}]
    body = (await preview(api, "boss", data, fix({"row": 2, "op": "remove", "token": "ELEV"}))).json()
    assert body["group_issue_count"] == 1 and body["group_issues"][0]["row"] == 3  # row 2 fixed, row 3 left


# ---------------------------------------------------------------- commit
async def test_commit_creates_people_without_profile_and_audits_without_mobile(api, world, db):
    data = make_xlsx(GOOD + [["", "NoName", 14, "09120000009", None]])  # one rejected row
    r = await commit(api, "boss", data)
    assert r.status_code == 201
    body = r.json()
    assert body["created_count"] == 2 and body["error_count"] == 1 and body["batch_id"]
    a, b = await people(db)
    assert (a.personnel_code, a.mobile, a.first_name, a.last_name, a.full_name) == (12, "09121234567", "علی", "رضایی", "علی رضایی")
    assert await group_codes(db, a.id) == {"ELV"} and await group_codes(db, b.id) == set()
    for u in (a, b):
        assert u.username is None and u.hashed_password is None and u.role_id is None and u.login_enabled is False
        assert u.is_active and u.import_batch_id == body["batch_id"]
        assert await auth_service.load_principal(db, u.id) is None
    batch = await db.get(m.PersonnelImportBatch, body["batch_id"])
    assert (batch.created_count, batch.rejected_count, batch.created_by, batch.undone_at) == (2, 1, world.boss.id, None)
    audit = (await db.execute(select(m.AuditLog).where(m.AuditLog.action == "personnel.import"))).scalars().one()
    assert audit.actor_id == world.boss.id and audit.entity_id == batch.id
    assert audit.metadata_json["created"] == 2 and audit.metadata_json["rejected"] == 1
    assert "912" not in json.dumps(audit.metadata_json)


async def test_import_creates_the_same_person_as_create_person(api, world, db):
    await commit(api, "boss", make_xlsx([["Sara", "Ahmadi", 13, "09127654321", "ELV"]]))
    imported = (await people(db))[0]
    made = await create_person(db, actor=await auth_service.load_principal(db, world.boss.id), first_name="Sara",
                               last_name="Ahmadi", personnel_code=14, mobile="09127654322", group_ids=[world.elv.id])
    other = await db.get(m.User, made["id"])
    for attr in ("full_name", "first_name", "last_name", "username", "hashed_password", "role_id", "login_enabled",
                 "is_active", "must_change_password"):
        assert getattr(imported, attr) == getattr(other, attr), attr
    assert await group_codes(db, imported.id) == await group_codes(db, other.id)
    assert other.import_batch_id is None  # only imports carry a batch


async def test_commit_is_refused_while_a_group_code_is_invalid(api, world, db, esc_old):
    r = await commit(api, "boss", make_xlsx(BAD))
    assert r.status_code == 422 and code_of(r) == "group_issues_unresolved"
    assert await count(db, m.PersonnelImportBatch) == 0 and not await people(db)
    r = await commit(api, "boss", make_xlsx(BAD), fix({"row": 2, "op": "remove", "token": "ELEV"}))
    assert code_of(r) == "group_issues_unresolved"  # row 3 still has its inactive group


async def test_commit_applies_replace_remove_and_drop(api, world, db, esc_old):
    rows = BAD + [["Omid", "Tavakoli", 22, "09120000003", "XX;ELV"], ["Hamed", "Zarei", 23, "09120000004", "ELV"]]
    ops = fix({"row": 2, "op": "replace", "token": "ELEV", "to": "ELV"}, {"row": 3, "op": "drop"},
              {"row": 4, "op": "remove", "token": "XX"})
    r = await commit(api, "boss", make_xlsx(rows), ops)
    assert r.status_code == 201 and r.json()["created_count"] == 3
    by_code = {u.personnel_code: u for u in await people(db)}
    assert set(by_code) == {20, 22, 23}  # row 3 (code 21) dropped
    assert await group_codes(db, by_code[20].id) == {"ESC", "ELV"}
    assert await group_codes(db, by_code[22].id) == {"ELV"}
    batch = await db.get(m.PersonnelImportBatch, r.json()["batch_id"])
    assert batch.rejected_count == 1 and r.json()["dropped_count"] == 1


async def test_commit_refuses_another_file_than_the_previewed_one(api, world, db):
    r = await commit(api, "boss", make_xlsx(GOOD), digest=sha(make_xlsx(GOOD[:1])))
    assert r.status_code == 409 and code_of(r) == "file_changed"
    assert not await people(db)


async def test_nothing_to_import(api, world, db):
    r = await commit(api, "boss", make_xlsx([["", "x", 1, "09120000001", None]]))
    assert r.status_code == 422 and code_of(r) == "nothing_to_import"
    assert await count(db, m.PersonnelImportBatch) == 0


async def test_existing_codes_are_rejected_not_updated(api, world, db):
    await commit(api, "boss", make_xlsx(GOOD))
    r = await commit(api, "boss", make_xlsx([GOOD[0], ["New", "Person", 15, "09125550000", None]]))
    assert r.json()["created_count"] == 1 and r.json()["errors"][0]["code"] == "personnel_code_taken"
    assert {u.personnel_code for u in await people(db)} == {12, 13, 15}


async def test_a_clash_found_at_insert_time_rolls_everything_back(api, world, db, monkeypatch):
    async def blind(db_, column, values):  # the pre-check misses the existing code (a concurrent import)
        return set()
    await f.user(db, "dup", "USER", [world.elv])
    dup = (await db.execute(select(m.User).where(m.User.username == "dup"))).scalar_one()
    dup.personnel_code = 12
    await db.commit()
    monkeypatch.setattr(personnel_import, "_existing", blind)
    r = await commit(api, "boss", make_xlsx(GOOD))
    assert r.status_code == 409 and code_of(r) == "import_conflict"
    assert await count(db, m.PersonnelImportBatch) == 0 and not await people(db)


# ---------------------------------------------------------------- corrections are re-validated by the server
@pytest.mark.parametrize("ops,code", [
    ([{"row": 2, "op": "replace", "token": "ELEV", "to": "NOPE"}], "correction_group_invalid"),
    ([{"row": 2, "op": "replace", "token": "ELEV", "to": "OLD"}], "correction_group_invalid"),   # inactive
    ([{"row": 2, "op": "replace", "token": "ELEV", "to": "bad code!"}], "correction_group_invalid"),
    ([{"row": 9, "op": "drop"}], "correction_row_not_found"),
    ([{"row": 2, "op": "remove", "token": "ZZZ"}], "correction_token_not_found"),
    ([{"row": 2, "op": "remove", "token": "ESC"}], "correction_token_not_found"),                # valid code: nothing to fix
    ([{"row": 2, "op": "drop"}, {"row": 2, "op": "drop"}], "duplicate_correction"),
])
async def test_bad_corrections_are_422_and_change_nothing(api, world, db, esc_old, ops, code):
    for call in (preview, commit):
        r = await call(api, "boss", make_xlsx(BAD), json.dumps(ops))
        assert r.status_code == 422 and code_of(r) == code, (call.__name__, r.text)
    assert not await people(db)


@pytest.mark.parametrize("text", ["not json", '{"row": 2}', '[{"row": 2, "op": "replace", "token": "A"}]',
                                  '[{"row": 2, "op": "drop", "token": "A"}]', '[{"row": 1, "op": "drop"}]',
                                  '[{"row": 2, "op": "explode"}]'])
async def test_malformed_corrections(api, world, text):
    r = await preview(api, "boss", make_xlsx(GOOD), text)
    assert r.status_code == 422 and code_of(r) == "invalid_corrections"


# ---------------------------------------------------------------- permissions and upload limits
@pytest.mark.parametrize("who", ["aud", "exp", "ali"])
async def test_only_management_may_import(api, world, db, who):
    data = make_xlsx(GOOD)
    assert (await preview(api, who, data)).status_code == 403
    assert (await commit(api, who, data)).status_code == 403
    assert not await people(db)


async def test_anonymous_is_401(api, world):
    assert (await preview(api, None, make_xlsx(GOOD))).status_code == 401
    assert (await commit(api, None, make_xlsx(GOOD))).status_code == 401


async def test_an_oversized_upload_is_refused(api, world, monkeypatch):
    from app.core.config import get_settings
    monkeypatch.setattr(get_settings(), "import_max_bytes", 100)
    r = await preview(api, "boss", make_xlsx(GOOD * 50))
    assert r.status_code == 413
