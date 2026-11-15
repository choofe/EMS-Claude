"""Sub-phase Pc — personnel import parsing and validation (no endpoint yet; the service is called directly).
Runs on SQLite; the real equipment parser tests (test_equipment_import.py) guard the shared parser."""
import io
import json

import pytest
from openpyxl import Workbook

from app.core.errors import DomainError
from app.services.personnel_import import analyse_personnel
from tests import factories as f

HEADER = ["first_name", "last_name", "personnel_code", "mobile", "groups"]


def make_xlsx(rows, header=HEADER):
    wb = Workbook()
    ws = wb.active
    if header is not None:
        ws.append(header)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def run(db, rows, header=HEADER, name="p.xlsx"):
    return await analyse_personnel(db, name, make_xlsx(rows, header))


def codes(report):
    return {e["row"]: e["code"] for e in report["errors"]}


@pytest.fixture
async def groups(db):
    elv, esc = await f.group(db, "ELV"), await f.group(db, "ESC")
    old = await f.group(db, "OLD")
    old.is_active = False
    await db.commit()
    return elv, esc, old


# ---------------------------------------------------------------- happy path and canonical forms
async def test_valid_rows_are_canonicalised_and_never_expose_the_mobile(db, groups):
    report, rows = await run(db, [
        ["علی", "رضایی", 12, "09121234567", "ELV;ESC"],          # numeric code, text mobile
        ["Sara", "Ahmadi", "۲۰۳", "+98 912 111 2233", "elv"],     # Persian digits, +98, lower-case group
        ["Reza", "Karimi", 7, 9123334455, None],                   # Excel dropped the leading 0; no groups
    ])
    assert report["valid_count"] == 3 and report["error_count"] == 0 and report["group_issue_count"] == 0
    assert [(r.personnel_code, r.mobile, r.group_codes) for r in rows] == [
        (12, "09121234567", ["ELV", "ESC"]), (203, "09121112233", ["ELV"]), (7, "09123334455", [])]
    text = json.dumps(report, ensure_ascii=False)
    for digits in ("9121234567", "9121112233", "9123334455"):
        assert digits not in text
    assert report["sample"][0]["full_name"] == "علی رضایی"


async def test_group_cell_separators_blanks_and_duplicates(db, groups):
    _, rows = await run(db, [["A", "B", 1, "09120000001", " ELV ; ;ESC؛ELV\nESC "]])
    assert rows[0].group_codes == ["ELV", "ESC"] and rows[0].invalid_groups == []


async def test_groups_column_is_optional(db, groups):
    report, rows = await run(db, [["A", "B", 1, "09120000001"]], header=HEADER[:4])
    assert report["valid_count"] == 1 and rows[0].group_codes == []


# ---------------------------------------------------------------- group codes
async def test_bad_group_codes_are_reported_but_never_reject_the_row(db, groups):
    report, rows = await run(db, [
        ["A", "B", 1, "09120000001", "ELV;ELEV;OLD;E L;ESC"],
        ["C", "D", 2, "09120000002", "NOPE"],
    ])
    assert report["valid_count"] == 2 and report["error_count"] == 0
    assert rows[0].group_codes == ["ELV", "ESC"]
    assert rows[1].group_codes == []
    assert report["group_issue_count"] == 2
    first = report["group_issues"][0]["invalid_groups"]
    assert first == [{"token": "ELEV", "reason": "unknown"}, {"token": "OLD", "reason": "inactive"},
                     {"token": "E L", "reason": "malformed"}]


async def test_too_many_group_tokens_rejects_the_row(db, groups):
    cell = ";".join(["ELV"] * 21)
    report, _ = await run(db, [["A", "B", 1, "09120000001", cell]])
    assert codes(report) == {2: "too_many_groups"}


# ---------------------------------------------------------------- row errors
@pytest.mark.parametrize("row,expected", [
    ([None, "B", 1, "09120000001", ""], "missing_first_name"),
    (["A", " ", 1, "09120000001", ""], "missing_last_name"),
    (["A", "B", None, "09120000001", ""], "missing_personnel_code"),
    (["A", "B", 1, None, ""], "missing_mobile"),
    (["A" * 65, "B", 1, "09120000001", ""], "invalid_first_name"),
    (["A", "B" * 65, 1, "09120000001", ""], "invalid_last_name"),
    (["A" * 64, "B" * 64, 1, "09120000001", ""], "invalid_full_name"),
    (["A", "B", "0123", "09120000001", ""], "invalid_personnel_code"),
    (["A", "B", 10000, "09120000001", ""], "invalid_personnel_code"),
    (["A", "B", "12a", "09120000001", ""], "invalid_personnel_code"),
    (["A", "B", 1.5, "09120000001", ""], "invalid_personnel_code"),
    (["A", "B", 1, "0912", ""], "invalid_mobile"),
    (["A", "B", 1, "09x20000001", ""], "invalid_mobile"),
    (["A", "B", "=1+1", "09120000001", ""], "formula_not_allowed"),
    (["=cmd()", "B", 1, "09120000001", ""], "formula_not_allowed"),
    (["A", "B", 1, "09120000001", "=ELV"], "formula_not_allowed"),
])
async def test_row_rules(db, groups, row, expected):
    report, rows = await run(db, [row])
    assert codes(report) == {2: expected} and rows == [] and report["valid_count"] == 0


async def test_date_cell_is_rejected_with_its_column(db, groups):
    from datetime import date
    report, _ = await run(db, [["A", "B", date(2026, 1, 10), "09120000001", ""]])
    assert report["errors"][0]["code"] == "date_cell" and report["errors"][0]["column"] == "personnel_code"


async def test_mobile_is_not_echoed_in_errors(db, groups):
    report, _ = await run(db, [["A", "B", 1, "0912", ""], ["C", "D", 2, "09125550000", "x"]])
    assert "0912" not in json.dumps(report["errors"]) and "5550000" not in json.dumps(report)


# ---------------------------------------------------------------- duplicates
async def test_duplicates_in_file_first_row_wins_and_rejected_rows_claim_nothing(db, groups):
    report, rows = await run(db, [
        ["A", "B", 1, "09120000001", ""],      # row 2: wins
        ["C", "D", 1, "09120000002", ""],      # row 3: same code
        ["E", "F", 2, "09120000001", ""],      # row 4: same mobile as row 2
        ["G", "H", 3, "0912", ""],             # row 5: invalid mobile, must not claim code 3
        ["I", "J", 3, "09120000003", ""],      # row 6: fine
    ])
    assert codes(report) == {3: "duplicate_personnel_code_in_file", 4: "duplicate_mobile_in_file", 5: "invalid_mobile"}
    assert report["errors"][0]["first_row"] == 2 and report["errors"][1]["first_row"] == 2
    assert [r.row for r in rows] == [2, 6]


async def test_existing_people_block_code_and_mobile_without_naming_them(db, groups):
    await f.person(db, "Old", "Owner", code=5, mobile="09127777777")
    await f.person(db, "No", "Code")                         # old-style person: no code, no mobile
    await db.commit()
    report, rows = await run(db, [
        ["A", "B", 5, "09120000001", ""], ["C", "D", 6, "09127777777", ""], ["E", "F", 7, "09120000002", ""]])
    assert codes(report) == {2: "personnel_code_taken", 3: "mobile_taken"} and [r.row for r in rows] == [4]
    assert "Owner" not in json.dumps(report)


async def test_database_lookup_works_across_chunks(db, groups):
    for n in range(1, 601):
        db.add(f.m.User(full_name=f"P{n}", first_name="P", last_name=str(n), personnel_code=n,
                        mobile=f"0912{n:07d}", login_enabled=False))
    await db.commit()
    report, rows = await run(db, [["A", "B", n, f"0913{n:07d}", ""] for n in range(1, 801)])
    assert report["error_count"] == 600 and report["valid_count"] == 200
    assert {e["code"] for e in report["errors"]} == {"personnel_code_taken"}


# ---------------------------------------------------------------- file level
async def test_file_level_errors(db, groups):
    with pytest.raises(DomainError) as exc:
        await run(db, [["A", "B", 1]], header=["first_name", "last_name"])
    assert exc.value.code == "missing_columns" and set(exc.value.extra["columns"]) == {"personnel_code", "mobile"}
    with pytest.raises(DomainError) as exc:   # an equipment file is not a personnel file
        await run(db, [["ELV-1", "ELV"]], header=["equipment_code", "group_code"])
    assert exc.value.code == "missing_columns"
    with pytest.raises(DomainError) as exc:
        await run(db, [["A", "B", 1, "09120000001", "", ""]], header=HEADER + ["groups"])
    assert exc.value.code == "duplicate_columns"
    report, _ = await run(db, [["A", "B", 1, "09120000001", "", "x"]], header=HEADER + ["notes"])
    assert report["ignored_columns"] == ["notes"]


async def test_row_limit_applies(db, groups):
    rows = [["A", "B", 1 + n % 9000, f"0912{n:07d}", ""] for n in range(1001)]
    with pytest.raises(DomainError) as exc:
        await run(db, rows)
    assert exc.value.code == "too_many_rows"


# ---------------------------------------------------------------- csv: ";" inside a cell must not change the delimiter
async def test_csv_with_comma_delimiter_and_semicolons_inside_the_groups_cell(db, groups):
    data = "first_name,last_name,personnel_code,mobile,groups\nA,B,1,09120000001,ELV;ESC\nC,D,2,09120000002,ELV;ESC\n"
    report, rows = await analyse_personnel(db, "p.csv", data.encode("utf-8-sig"))
    assert report["valid_count"] == 2 and rows[0].group_codes == ["ELV", "ESC"]


async def test_csv_with_semicolon_delimiter(db, groups):
    data = 'first_name;last_name;personnel_code;mobile;groups\nA;B;1;09120000001;"ELV;ESC"\n'
    report, rows = await analyse_personnel(db, "p.csv", data.encode())
    assert report["valid_count"] == 1 and rows[0].group_codes == ["ELV", "ESC"]
