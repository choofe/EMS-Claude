# Equipment import (Phase 5)

Excel/CSV import of equipment, **one group per import**, preview → confirm. MANAGEMENT only (`EXCEL_IMPORT`;
AUDITOR has no write capability). Nothing is ever updated or overwritten.

## Standard file format
One sheet (a workbook with more than one sheet is refused). Row 1 = header; headers are case-insensitive:

| Column | Required | Rule |
|---|---|---|
| `equipment_code` | yes | Latin letters, digits, `- . _ /`, no spaces, ≤ 64. Stored UPPER-case. Leading/trailing spaces **and NBSP (U+00A0)** are trimmed (common in copied Excel data). |
| `group_code` | yes | Must equal the group chosen in the screen (case-insensitive). A different value rejects the row. Groups are **never** created by an import. |
| `description` | no | ≤ 2000 chars, whitespace collapsed. |

Other non-empty columns are ignored and listed in the preview (`ignored_columns`); empty-header columns are ignored silently.
`.xlsx` and `.csv` only (CSV: UTF-8 with or without BOM; `,` `;` or tab). `.xls`/`.xlsm` are refused.
A header-only template: `GET /equipment/import/template?format=xlsx|csv` (columns pre-formatted as Text so Excel does not
turn codes such as `1-10` into dates).

## Limits (`Settings`, env-overridable)
`IMPORT_MAX_BYTES` 2 MB · `IMPORT_MAX_ROWS` 1000 non-empty data rows · `IMPORT_MAX_UNCOMPRESSED_BYTES` 20 MB (xlsx zip-bomb guard).

## Endpoints
| Endpoint | Purpose |
|---|---|
| `POST /equipment/import/preview` (multipart: `group_id`, `file`) | Validate; **writes nothing**. Returns `group`, `file_sha256`, `rows_total`, `valid_count`, `error_count`, `errors[]`, `sample[]`, `ignored_columns`. |
| `POST /equipment/import/commit` (multipart: `group_id`, `file`, `preview_sha256`) | Re-validates everything server-side, then imports the **valid rows only** in ONE transaction with ONE audit row (`equipment.import`). `409 file_changed` if the file differs from the previewed one; `422 nothing_to_import` if no row is valid. Returns the preview fields + `batch_id`, `created_count`. |
| `GET /equipment/import/batches` | Import history (`can_undo`, `remaining_count`, `report_count`, …). |
| `POST /equipment/import/batches/{id}/undo` | Undo a whole import (see below). |
| `GET /equipment/import/template` | Header-only template. |

Row errors (`errors[]`, sorted by row; `row` is the Excel row number, header = 1): `{row, equipment_code, code, …}` with `code` one of
`missing_equipment_code`, `missing_group_code`, `invalid_equipment_code` (+`bad_chars`, invisible characters are named, e.g. `U+200C`),
`group_mismatch` (+`found`, `expected`), `duplicate_in_file` (+`first_row`), `already_exists` (+`existing_group_code`,
`existing_is_active`; any letter case, any group), `formula_not_allowed` (any of the three cells starts with `=`),
`date_cell` (Excel converted the code to a date), `invalid_description`.

File-level errors (nothing is imported): `unsupported_file_type`, `file_too_large` (413), `length_required` (411), `file_corrupt`,
`file_unsafe`, `file_encoding`, `empty_file`, `no_data_rows`, `multiple_sheets`, `missing_columns` (+`columns`), `duplicate_columns`,
`too_many_rows` (+`max_rows`), `group_not_found` (404), `group_inactive` (409).

## Mistake recovery: undo
Every import is a batch (`equipment_import_batches`; `equipment.import_batch_id`). `undo` **hard-deletes** the batch's equipment — the
single, deliberate exception to "never hard-delete history" — and only when ALL hold:
* no report exists for any of its equipment (soft-deleted reports count too) → else `409 batch_has_reports`;
* none of its equipment was moved to another group → else `409 batch_equipment_moved`;
* the batch was not already undone (`409 batch_already_undone`).
The batch row stays (`undone_at`, `undone_by`) and an audit row `equipment.import_undo` lists the deleted codes. The FK
`reports.equipment_id … ON DELETE RESTRICT` is the last line of defence against a report appearing concurrently.
A single wrongly-typed code can therefore be fixed by: undo the batch → correct the file → import again.

## Security notes
* Content-Length is checked **before** the multipart body is parsed (`411` without it, `413` over the limit); the read is bounded again.
* xlsx is opened as a zip first: macros/binary members, > 200 members, compression ratio > 200:1 on large members and > 20 MB uncompressed are refused
  before `openpyxl` sees it. `defusedxml` is a hard dependency (XML entity bombs / XXE); formulas are never evaluated.
* Concurrent identical imports: the unique constraint decides; the loser gets `import_conflict` / `nothing_to_import` and nothing is persisted.
* A reverse proxy in front of the API should also cap request bodies (Phase 12).
* xlsx members refused as macros/active content: `vbaProject*`, `xl/activeX/`, `xl/embeddings/`. Other binary members are
  allowed: Excel itself writes `xl/printerSettings/printerSettings1.bin` into ordinary workbooks.
* Parsing (CPU-bound) runs in a worker thread, off the event loop.

## Accepted limitations (independent review, 2026-10-17)
* **No rate limit on the import endpoints.** They need an authenticated MANAGEMENT user and every request is bounded
  (size, rows, uncompressed size), so the risk is accepted for the MVP; abuse limiting belongs to Phase 12 (reverse proxy).
  Login brute-force protection already exists (Phase 3).
* `import_conflict` (409) is a normal, fail-closed answer when two imports create the same code at the same moment; the
  unique constraint decides, nothing is persisted.
* The group dropdown loads the first 100 active groups (API page limit). Fine for the expected number of groups; revisit
  if an organisation ever has more.
* Undo is allowed while the group is inactive (it removes equipment, not the group).
* An import file with more than 50 000 physical rows (even blank ones) is refused as `too_many_rows`.

## Frontend
`/equipment/import` (MANAGEMENT only; nav item "ورود گروهی تجهیزات"): choose group → choose file → "بررسی فایل" → preview with Persian
reasons per row (+ CSV of the errors) → confirm → result + history with undo.

## Notes for later phases
* Phase 6 report creation must lock the equipment row (`FOR SHARE`) and answer `404` if it vanished: `undo_batch` hard-deletes
  never-used equipment under `FOR UPDATE`, and the FK `RESTRICT` makes a report that slipped in fail the undo instead of orphaning it.
* The audit viewer (future) should render `equipment.import` / `equipment.import_undo` (`entity_type = equipment_import_batch`).
