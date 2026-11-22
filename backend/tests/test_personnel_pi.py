"""Sub-phase Pi — personnel import: Persian header names, names beside the codes in the preview and the CSV problem
report, the non-blocking same-name notice, the Excel template. SQLite; real routers and login for the HTTP parts."""
import csv
import io
import json
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook

from app.core.errors import DomainError
from app.core.normalize import fold_text
from app.services import personnel_import, personnel_same_names
from app.services.import_parser import EQUIPMENT_COLUMNS, PERSONNEL_COLUMNS, parse_upload
from app.services.personnel_import import analyse_personnel, preview_import
from tests import factories as f
from tests.test_personnel_import import HEADER, make_xlsx
from tests.test_personnel_import_api import commit, preview
from tests.test_personnel_import_history import csv_of

FA = ["نام", "نام خانوادگی", "کد پرسنلی", "گروه‌های عضو", "شماره موبایل"]
ROW = ["علی", "رضایی", 12, "ELV", "09121234567"]


def fa_csv(header, rows, delimiter=","):
    buf = io.StringIO(newline="")
    w = csv.writer(buf, delimiter=delimiter)
    w.writerow(header)
    w.writerows(rows)
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


@pytest.fixture
async def groups(db):
    elv, esc = await f.group(db, "ELV"), await f.group(db, "ESC")
    await db.commit()
    return elv, esc


# ---------------------------------------------------------------- header aliases
async def test_persian_headers_import_like_the_english_ones(db, groups):
    report, rows = await analyse_personnel(db, "p.xlsx", make_xlsx([ROW], header=FA))
    assert report["valid_count"] == 1 and report["ignored_columns"] == [] and report["error_count"] == 0
    assert (rows[0].first_name, rows[0].personnel_code, rows[0].mobile, rows[0].group_codes) == ("علی", 12, "09121234567", ["ELV"])


# the file layout is: first name, last name, code, groups, mobile (columns may come in any order)
ALIASES = [
    ("first_name", ["نام", "اسم", "نام کوچک"]),
    ("last_name", ["نام خانوادگی", "فامیلی", "فامیل"]),
    ("personnel_code", ["کد پرسنلی", "کد پرسنل", "شماره پرسنلی"]),
    ("groups", ["گروه‌های عضو", "گروه‌ها", "گروه"]),
    ("mobile", ["شماره موبایل", "موبایل", "شماره همراه", "همراه", "شماره تلفن همراه", "شماره تلفن"]),
]


@pytest.mark.parametrize("standard,names", ALIASES)
def test_every_alias_maps_to_its_standard_column(standard, names):
    for alias in names:
        header = [alias if h == standard else h for h in HEADER]
        parsed = parse_upload("p.xlsx", make_xlsx([["A", "B", 1, "09120000001", "ELV"]], header=header), PERSONNEL_COLUMNS)
        assert parsed.ignored_columns == [] and set(parsed.rows[0].cells) == set(HEADER), alias


@pytest.mark.parametrize("typed", [
    "گروه های عضو", "گروه‌‌های‌عضو", " گروه‌های   عضو ", "گروههای عضو",   # half-space, spaces, no separator
])
def test_header_folding_ignores_spaces_and_half_spaces(typed):
    parsed = parse_upload("p.xlsx", make_xlsx([["A", "B", 1, "09120000001", "ELV"]],
                                              header=["first_name", "last_name", "personnel_code", "mobile", typed]), PERSONNEL_COLUMNS)
    assert "groups" in parsed.rows[0].cells and parsed.ignored_columns == []


def test_header_folding_unifies_arabic_letters_and_diacritics():
    header = ["نام", "نام خانوادگي", "كد پرسنلي", "گروه‌های عضو", "شمارهٔ موبایل"]  # Arabic ي and ك; hamza mark on «شماره»
    parsed = parse_upload("p.xlsx", make_xlsx([ROW], header=header), PERSONNEL_COLUMNS)
    assert set(parsed.rows[0].cells) == set(HEADER) and parsed.ignored_columns == []
    assert fold_text("كـَدِ پرسنلى") == fold_text("کد پرسنلی")   # tatweel, diacritics, Arabic yeh/alef maksura
    assert fold_text("۱۲۳ Ab") == "123ab"


def test_english_names_stay_valid_and_mixed_files_work():
    header = ["first_name", "نام خانوادگی", "Personnel_Code", "موبایل", "groups"]
    parsed = parse_upload("p.xlsx", make_xlsx([["A", "B", 1, "09120000001", "ELV"]], header=header), PERSONNEL_COLUMNS)
    assert set(parsed.rows[0].cells) == set(HEADER)


def test_english_and_persian_name_of_one_column_is_a_duplicate():
    header = ["first_name", "نام", "last_name", "personnel_code", "mobile"]
    with pytest.raises(DomainError) as err:
        parse_upload("p.xlsx", make_xlsx([["A", "A", "B", 1, "09120000001"]], header=header), PERSONNEL_COLUMNS)
    assert err.value.code == "duplicate_columns" and err.value.extra["column"] == "first_name"


def test_unknown_titled_columns_are_reported_and_blank_titles_ignored():
    header = FA + ["توضیحات", None]
    parsed = parse_upload("p.xlsx", make_xlsx([ROW + ["x", "y"]], header=header), PERSONNEL_COLUMNS)
    assert parsed.ignored_columns == ["توضیحات"]


def test_equipment_import_does_not_get_the_persian_names():
    with pytest.raises(DomainError) as err:
        parse_upload("e.xlsx", make_xlsx([["E-1", "ELV"]], header=["کد تجهیز", "کد گروه"]), EQUIPMENT_COLUMNS)
    assert err.value.code == "missing_columns"
    header = ["نام", "equipment_code", "group_code"]
    assert parse_upload("e.xlsx", make_xlsx([["x", "E-1", "ELV"]], header=header), EQUIPMENT_COLUMNS).ignored_columns == ["نام"]


@pytest.mark.parametrize("delimiter", [",", ";", "\t"])
async def test_csv_with_persian_header_finds_its_delimiter(db, groups, delimiter):
    data = fa_csv(FA, [["علی", "رضایی", 12, "ELV;ESC", "09121234567"], ["سارا", "احمدی", 13, "", "09127654321"]], delimiter)
    report, rows = await analyse_personnel(db, "p.csv", data)
    assert report["valid_count"] == 2 and report["ignored_columns"] == [], delimiter
    assert rows[0].group_codes == ["ELV", "ESC"]


async def test_csv_delimiter_is_chosen_by_the_persian_names_not_by_the_field_count(db, groups):
    """The first record has commas inside a long ignored title: only the recognised Persian names tell «;» from «,»."""
    header = ["نام", "نام خانوادگی", "کد پرسنلی", "شماره موبایل", "توضیحات: الف,ب,ج,د,ه,و"]
    data = fa_csv(header, [["علی", "رضایی", 12, "09121234567", "x"]], delimiter=";")
    report, _ = await analyse_personnel(db, "p.csv", data)
    assert report["valid_count"] == 1 and report["ignored_columns"] == ["توضیحات: الف,ب,ج,د,ه,و"]


# ---------------------------------------------------------------- names in errors and group issues
async def test_errors_and_group_issues_carry_names_but_never_the_mobile(db, groups):
    await f.person(db, "Old", "Timer", code=50, mobile="09125550000")
    await db.commit()
    long = "x" * 64
    report, _ = await analyse_personnel(db, "p.xlsx", make_xlsx([
        ["Sara", "One", None, "09120000001", None],                    # 2 missing code: names shown
        ["Sara", "Two", 61, "bad", None],                              # 3 invalid mobile
        ["Sara", "Three", 50, "09120000003", None],                    # 4 code taken
        ["Sara", "Four", 62, "09125550000", None],                     # 5 mobile taken
        ["Sara", "Five", 63, "09120000005", None],                     # 6 valid
        ["Sara", "Six", 63, "09120000006", None],                      # 7 same code as row 6 (cluster)
        ["Sara", "Seven", 64, "09120000005", None],                    # 8 same mobile as row 6 (cluster)
        ["Sara", "Eight", "-5", "09120000008", None],                  # 9 invalid code
        [None, "Nine", 65, "09120000009", None],                       # 10 missing first name: no names
        [long, long, 66, "09120000010", None],                         # 11 full name too long: no names
        ["=1+1", "Twelve", 67, "09120000012", None],                   # 12 formula in a name cell: no names
        ["Sara", "Thirteen", 68, "09120000013", "NOPE"],               # 13 valid with a group issue
    ]))
    by_row = {e["row"]: e for e in report["errors"]}
    for row, last in {2: "One", 3: "Two", 4: "Three", 5: "Four", 9: "Eight"}.items():
        assert (by_row[row]["first_name"], by_row[row]["last_name"]) == ("Sara", last), row
    cluster = report["file_conflicts"][0]["rows"]           # the cluster rows carry names too, never a mobile
    assert [(r["row"], r["last_name"]) for r in cluster] == [(6, "Five"), (7, "Six"), (8, "Seven")] and "mobile" not in cluster[0]
    for row, code in {10: "missing_first_name", 11: "invalid_full_name", 12: "formula_not_allowed"}.items():
        assert by_row[row]["code"] == code and by_row[row]["first_name"] is None and by_row[row]["last_name"] is None, row
    assert report["group_issues"] == [{"row": 13, "first_name": "Sara", "last_name": "Thirteen", "personnel_code": 68,
                                       "invalid_groups": [{"token": "NOPE", "reason": "unknown"}]}]
    text = json.dumps(report, ensure_ascii=False)
    for secret in ("09120000", "9125550000", "Old", "Timer"):
        assert secret not in text


async def test_names_are_cleaned_and_a_date_cell_keeps_the_names(db, groups):
    import datetime
    report, _ = await analyse_personnel(db, "p.xlsx", make_xlsx([["  Sara   Jan ", " Ahmadi ", 5, datetime.date(2024, 1, 1), None]]))
    e = report["errors"][0]
    assert e["code"] == "date_cell" and (e["first_name"], e["last_name"]) == ("Sara Jan", "Ahmadi")


# ---------------------------------------------------------------- same-name notice
async def preview_of(db, rows, corrections=()):
    from app.schemas.personnel_import import PersonnelCorrection
    return await preview_import(db, filename="p.xlsx", data=make_xlsx(rows),
                                corrections=[PersonnelCorrection(**c) for c in corrections])


async def test_same_name_matches_ignore_spaces_half_spaces_and_arabic_letters(db, groups):
    elv, esc = groups
    await f.person(db, "علیرضا", "نظري", code=1321, mobile="09125550001", groups=[elv, esc])   # Arabic yeh in the DB
    await db.commit()
    report = await preview_of(db, [["علی‌رضا", "نظری", 1231, "09120000001", None], ["علی", "رضایی", 12, "09120000002", None]])
    assert report["same_name_count"] == 1
    row = report["same_names"][0]
    assert (row["row"], row["first_name"], row["last_name"], row["personnel_code"], row["matches_total"]) == (2, "علی‌رضا", "نظری", 1231, 1)
    assert row["matches"] == [{"full_name": "علیرضا نظري", "personnel_code": 1321, "group_codes": ["ELV", "ESC"],
                               "is_active": True, "has_profile": False}]


async def test_same_name_is_exact_not_fuzzy(db, groups):
    await f.person(db, "Ali", "Rezaei", code=1)
    await db.commit()
    report = await preview_of(db, [["Ali", "Rezai", 2, "09120000001", None], ["Alireza", "Rezaei", 3, "09120000002", None]])
    assert report["same_name_count"] == 0 and report["same_names"] == []


async def test_matches_are_sorted_by_code_with_codeless_last_and_cover_old_users_and_inactive(db, groups):
    await f.person(db, "Ali", "Rezaei", code=500, mobile="09125550001")
    await f.person(db, "Ali", "Rezaei", code=20, mobile="09125550002", active=False)
    old = await f.user(db, "old1", "USER")            # an old user: only full_name, no parts, no code
    old.full_name = "Ali Rezaei"
    await db.commit()
    report = await preview_of(db, [["Ali", "Rezaei", 3000, "09120000001", None]])
    matches = report["same_names"][0]["matches"]
    assert [(m["personnel_code"], m["is_active"], m["has_profile"]) for m in matches] == [(20, False, False), (500, True, False), (None, True, True)]


async def test_matches_are_capped_but_counted_and_privacy_holds(db, groups, monkeypatch):
    assert personnel_same_names.MAX_MATCHES == 5 and personnel_same_names.MAX_SAME_NAME_ROWS == 200
    for i in range(7):
        await f.person(db, "Ali", "Rezaei", code=10 + i, mobile=f"0912555000{i}")
    await db.commit()
    report = await preview_of(db, [["Ali", "Rezaei", 3000, "09120000001", None]])
    row = report["same_names"][0]
    assert row["matches_total"] == 7 and [m["personnel_code"] for m in row["matches"]] == [10, 11, 12, 13, 14]
    text = json.dumps(report)
    assert "0912555" not in text and "username" not in text and "role" not in text and "09120000001" not in text


async def test_row_list_is_capped_in_file_order_but_the_count_is_complete(db, groups, monkeypatch):
    monkeypatch.setattr(personnel_same_names, "MAX_SAME_NAME_ROWS", 2)
    for n in ("A", "B", "C"):
        await f.person(db, n, "Same", code=None)
    await db.commit()
    report = await preview_of(db, [[n, "Same", 100 + i, f"0912000000{i}", None] for i, n in enumerate("CAB")])
    assert report["same_name_count"] == 3 and [r["row"] for r in report["same_names"]] == [2, 3]


async def test_rows_with_errors_and_rows_of_the_file_itself_are_not_flagged(db, groups):
    await f.person(db, "Ali", "Rezaei", code=1, mobile="09125550001")
    await db.commit()
    report = await preview_of(db, [
        ["Ali", "Rezaei", 1, "09120000001", None],          # code taken: an error, not a notice
        ["Sara", "Same", 2, "09120000002", None],           # same name twice IN the file: no notice
        ["Sara", "Same", 3, "09120000003", None],
        ["Ali", "Rezaei", 4, "bad", None],                  # invalid mobile: an error
    ])
    assert report["same_name_count"] == 0 and report["error_count"] == 2 and report["valid_count"] == 2


async def test_dropped_rows_leave_the_notice_and_rows_with_group_issues_stay(db, groups):
    await f.person(db, "Ali", "Rezaei", code=1)
    await f.person(db, "Sara", "Karimi", code=2)
    await db.commit()
    rows = [["Ali", "Rezaei", 11, "09120000001", None], ["Sara", "Karimi", 12, "09120000002", "NOPE"]]
    assert (await preview_of(db, rows))["same_name_count"] == 2
    report = await preview_of(db, rows, [{"row": 2, "op": "drop"}])
    assert report["same_name_count"] == 1 and report["same_names"][0]["row"] == 3   # the group-issue row still counts


async def test_no_same_name_keys_on_commit_but_on_preview_over_http(api, world, db):
    await f.person(db, "Ali", "Rezaei", code=1)
    await db.commit()
    data = make_xlsx([["Ali", "Rezaei", 11, "09120000001", None]])
    body = (await preview(api, "boss", data)).json()
    assert body["same_name_count"] == 1 and body["same_names"][0]["matches"][0]["personnel_code"] == 1
    r = await commit(api, "boss", data)               # a same name never blocks and needs no confirmation
    assert r.status_code == 201 and "same_name_count" not in r.json() and "same_names" not in r.json()
    assert (await preview(api, "boss", make_xlsx([["Zed", "Zed", 99, "09120000009", None]]))).json()["same_names"] == []


async def test_a_match_without_a_code_omits_the_key_over_http(api, world, db):
    old = await f.person(db, "Ali", "Rezaei", code=None)
    await db.commit()
    body = (await preview(api, "boss", make_xlsx([["Ali", "Rezaei", 11, "09120000001", None]]))).json()
    assert "personnel_code" not in body["same_names"][0]["matches"][0] and old.id


async def test_same_name_notice_is_for_management_only(api, world, db):
    data = make_xlsx([ROW])
    assert (await preview(api, "aud", data)).status_code == 403 and (await preview(api, "ali", data)).status_code == 403


# ---------------------------------------------------------------- CSV problem report with names
async def test_problem_csv_has_names_and_makes_them_spreadsheet_safe(api, world, db):
    data = make_xlsx([["-Sara", "@Ahmadi", None, "09120000001", None], [None, "Nine", 65, "09120000009", None],
                      ["Ok", "Name", 66, "09120000010", "NOPE"]])
    text = (await csv_of(api, "boss", data)).content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0] == ["row", "first_name", "last_name", "personnel_code", "problem_code", "description_fa"]
    assert rows[1][:5] == ["2", "'-Sara", "'@Ahmadi", "", "missing_personnel_code"]
    assert rows[2][:5] == ["3", "", "", "65", "missing_first_name"]   # the name itself is the problem: empty cells
    assert rows[3][:5] == ["4", "Ok", "Name", "66", "group_unknown"]


# ---------------------------------------------------------------- Excel template
TEMPLATE = Path(__file__).resolve().parents[2] / "frontend" / "public" / "personnel-import-template.xlsx"


@pytest.mark.skipif(not TEMPLATE.exists(), reason="template file not in this checkout")
async def test_template_is_read_by_the_real_parser_with_its_five_persian_headers(db, groups):
    wb = load_workbook(TEMPLATE)
    ws = wb.active
    assert [c.value for c in ws[1]][:5] == FA and ws.freeze_panes == "A2"
    for col, v in zip("ABCDE", ["علی", "رضایی", 12, "ELV;ESC", "09121234567"]):
        ws[f"{col}2"] = v
    buf = io.BytesIO()
    wb.save(buf)
    report, rows = await analyse_personnel(db, "t.xlsx", buf.getvalue())
    assert report["ignored_columns"] == [] and report["valid_count"] == 1 and report["error_count"] == 0
    assert rows[0].group_codes == ["ELV", "ESC"] and rows[0].mobile == "09121234567"


@pytest.mark.skipif(not TEMPLATE.exists(), reason="template file not in this checkout")
def test_template_protection_and_limits():
    ws = load_workbook(TEMPLATE).active
    assert not ws.protection.sheet and ws.sheet_view.rightToLeft            # rows must be insertable and deletable
    assert ws.sheet_format.zeroHeight and ws.column_dimensions["F"].hidden      # rows after 201 and columns after E are hidden
    assert ws["A1"].comment and "۲۰۰" in ws["A1"].comment.text and "۱۰۰۰" not in ws["A1"].comment.text and ws["D1"].comment and ";" in ws["D1"].comment.text
    kinds = sorted((v.type, str(v.sqref)) for v in ws.data_validations.dataValidation)
    assert len(kinds) == 4 and all("201" in s for _, s in kinds)
    assert ws["E2"].number_format.replace("\\", "") == "[<=9999999]###-####;0### ### ####"   # Excel escapes - and space


# ---------------------------------------------------------------- mobile numbers in the same-name notice
async def test_same_name_notice_shows_both_mobiles_only_with_the_capability(db, groups):
    await f.person(db, "Ali", "Rezaei", code=1, mobile="09123214587")
    await f.person(db, "Old", "Codeless", code=None)          # an old person without a mobile
    await db.commit()
    rows = [["Ali", "Rezaei", 11, "09143214587", None], ["Old", "Codeless", 12, "09120000002", None]]
    from app.schemas.personnel_import import PersonnelCorrection  # noqa: F401
    data = make_xlsx(rows)
    shown = await preview_import(db, filename="p.xlsx", data=data, corrections=[], include_mobile=True)
    first, second = shown["same_names"]
    assert first["mobile"] == "09143214587" and first["matches"][0]["mobile"] == "09123214587"
    assert second["matches"][0]["mobile"] is None
    hidden = json.dumps(await preview_import(db, filename="p.xlsx", data=data, corrections=[]))
    assert "0912321" not in hidden and "0914321" not in hidden and "mobile" not in hidden.replace("mobile_taken", "")


async def test_mobiles_travel_over_http_for_management_but_never_on_commit_or_in_the_csv(api, world, db):
    await f.person(db, "Ali", "Rezaei", code=1, mobile="09123214587")
    await db.commit()
    data = make_xlsx([["Ali", "Rezaei", 11, "09143214587", None]])
    body = (await preview(api, "boss", data)).json()
    assert body["same_names"][0]["mobile"] == "09143214587" and body["same_names"][0]["matches"][0]["mobile"] == "09123214587"
    done = (await commit(api, "boss", data)).json()
    assert "09143214587" not in json.dumps(done)
    assert "0914321" not in (await csv_of(api, "boss", data)).content.decode("utf-8-sig")


# ---------------------------------------------------------------- one person, two identifiers in the file
QODRAT = [["قدرت", "شیخی", 5, "09121111111", None], ["قدرت", "شیخی", 6, "09121111111", None]]


async def test_cluster_is_flagged_as_probably_one_person_only_when_every_row_has_the_same_name(db, groups):
    rows = QODRAT + [["Sara", "A", 7, "09122222222", None], ["Sara", "B", 7, "09123333333", None]]
    report, _ = await analyse_personnel(db, "p.xlsx", make_xlsx(rows))
    first, second = report["file_conflicts"]
    assert (first["same_name"], first["shared"]) == (True, ["mobile"])
    assert (second["same_name"], second["shared"]) == (False, ["personnel_code"])
    assert report["error_count"] == 0 and report["valid_count"] == 0
    mixed = [["Ali", "X", 1, "09121111111", None], ["Ali", "X", 2, "09121111111", None], ["Bob", "Y", 2, "09122222222", None]]
    report, _ = await analyse_personnel(db, "p.xlsx", make_xlsx(mixed))     # one cluster; one different name = not "one person"
    assert len(report["file_conflicts"]) == 1 and report["file_conflicts"][0]["same_name"] is False


async def test_preview_lists_every_cluster_row_with_mobiles_only_when_allowed(db, groups):
    rows = [["قدرت", "شیخی", 5, "09121111111", "ELV"], ["قدرت", "شیخی", 6, "09121111111", "ESC"],
            ["Ali", "A", 9, "09123333333", None], ["Bob", "B", 9, "09124444444", None]]
    full = await preview_import(db, filename="p.xlsx", data=make_xlsx(rows), corrections=[], include_mobile=True)
    mobile_cluster, code_cluster = full["file_conflicts"]
    assert mobile_cluster == {"shared": ["mobile"], "same_name": True, "rows": [
        {"row": 2, "first_name": "قدرت", "last_name": "شیخی", "personnel_code": 5, "group_codes": ["ELV"], "mobile": "09121111111"},
        {"row": 3, "first_name": "قدرت", "last_name": "شیخی", "personnel_code": 6, "group_codes": ["ESC"], "mobile": "09121111111"}]}
    assert code_cluster["shared"] == ["personnel_code"] and code_cluster["same_name"] is False
    hidden = await preview_import(db, filename="p.xlsx", data=make_xlsx(rows), corrections=[])
    assert len(hidden["file_conflicts"]) == 2 and '"mobile":' not in json.dumps(hidden["file_conflicts"])


async def test_keeping_one_row_of_a_cluster_means_dropping_the_others_in_one_step(db, groups):
    rows = [["A", "Same", 1, "09121111111", None], ["A", "Same", 2, "09121111111", None], ["A", "Same", 3, "09121111111", None]]
    first = await preview_of(db, rows)
    assert first["file_conflict_count"] == 1 and first["valid_count"] == 0 and len(first["file_conflicts"][0]["rows"]) == 3
    kept = await preview_of(db, rows, [{"row": 2, "op": "drop"}, {"row": 4, "op": "drop"}])     # keep row 3
    assert kept["file_conflict_count"] == 0 and kept["valid_count"] == 1 and kept["sample"][0]["row"] == 3
    assert kept["dropped_count"] == 2 and kept["error_count"] == 0
    partial = await preview_of(db, rows, [{"row": 2, "op": "drop"}])    # two rows still clash: still undecided
    assert partial["file_conflict_count"] == 1 and [r["row"] for r in partial["file_conflicts"][0]["rows"]] == [3, 4]


async def test_dropping_all_rows_of_a_cluster_leaves_nothing_to_decide(db, groups):
    both = await preview_of(db, QODRAT, [{"row": 2, "op": "drop"}, {"row": 3, "op": "drop"}])
    assert both["valid_count"] == 0 and both["dropped_count"] == 2 and both["file_conflict_count"] == 0


async def test_same_name_rows_without_a_conflict_are_only_a_warning(db, groups):
    rows = [["Ali", "Rezaei", 1, "09121111111", None], ["Ali", "Rezaei", 2, "09122222222", None], ["Sara", "X", 3, "09123333333", None]]
    report = await preview_import(db, filename="p.xlsx", data=make_xlsx(rows), corrections=[], include_mobile=True)
    assert report["file_conflict_count"] == 0 and report["valid_count"] == 3
    assert [[(r["row"], r["mobile"]) for r in g["rows"]] for g in report["same_name_in_file"]] == [[(2, "09121111111"), (3, "09122222222")]]
    plain = await preview_import(db, filename="p.xlsx", data=make_xlsx(rows), corrections=[])
    assert '"mobile":' not in json.dumps(plain["same_name_in_file"])
    dropped = await preview_of(db, rows, [{"row": 3, "op": "drop"}])
    assert dropped["same_name_in_file"] == []                   # one row left: nothing to warn about


async def test_a_valid_row_without_any_problem_can_be_dropped(db, groups):
    report = await preview_of(db, [["A", "One", 1, "09121111111", None], ["B", "Two", 2, "09122222222", None]], [{"row": 2, "op": "drop"}])
    assert report["valid_count"] == 1 and report["dropped_count"] == 1 and report["sample"][0]["row"] == 3


async def test_a_row_rejected_for_another_reason_cannot_be_dropped_and_wins_nothing(db, groups):
    from fastapi import HTTPException  # noqa: F401
    await f.person(db, "Old", "Timer", code=5, mobile="09125550000")
    await db.commit()
    rows = [["A", "One", 5, "09121111111", None], ["A", "Two", 6, "09121111111", None]]   # row 2: code taken (error)
    with pytest.raises(DomainError) as err:
        await preview_of(db, rows, [{"row": 2, "op": "drop"}])
    assert err.value.code == "correction_row_not_found"
    report = await preview_of(db, rows)               # the rejected row claimed nothing: no cluster, row 3 is valid
    assert report["valid_count"] == 1 and report["sample"][0]["row"] == 3 and report["file_conflict_count"] == 0


async def test_commit_with_a_drop_imports_the_other_row_and_counts_the_drop(api, world, db):
    data = make_xlsx(QODRAT)
    r = await commit(api, "boss", data, json.dumps([{"row": 2, "op": "drop"}]))
    body = r.json()
    assert r.status_code == 201 and body["created_count"] == 1 and body["error_count"] == 0 and body["dropped_count"] == 1
    from sqlalchemy import select
    from app.models.user import User
    people = (await db.execute(select(User.personnel_code).where(User.personnel_code.in_([5, 6])))).scalars().all()
    assert people == [6]
    assert "file_duplicates" not in body and "same_names" not in body


# ---------------------------------------------------------------- the commit waits for the manager's decision
async def test_commit_is_refused_while_a_cluster_is_undecided_and_works_after_the_choice(api, world, db):
    from tests.test_personnel_import_api import fix
    rows = QODRAT + [["Sara", "Ok", 9, "09129999999", None]]
    data = make_xlsx(rows)
    refused = await commit(api, "boss", data)
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "file_conflicts_unresolved"
    assert refused.json()["detail"]["file_conflict_count"] == 1
    from sqlalchemy import func, select
    from app.models.user import User
    assert (await db.execute(select(func.count()).select_from(User).where(User.import_batch_id.is_not(None)))).scalar() == 0
    done = await commit(api, "boss", data, fix({"row": 2, "op": "drop"}))             # keep row 3
    assert done.status_code == 201 and done.json()["created_count"] == 2
    assert (await db.execute(select(User.personnel_code).where(User.import_batch_id.is_not(None)).order_by(User.personnel_code))).scalars().all() == [6, 9]


async def test_problem_csv_lists_cluster_rows_without_mobiles(api, world, db):
    text = (await csv_of(api, "boss", make_xlsx(QODRAT))).content.decode("utf-8-sig")
    lines = list(csv.reader(io.StringIO(text)))
    assert [(l[0], l[4]) for l in lines[1:]] == [("2", "file_conflict"), ("3", "file_conflict")]
    assert "0912111" not in text and lines[1][1:3] == ["قدرت", "شیخی"]
