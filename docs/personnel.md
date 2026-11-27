# Personnel phase — data foundation (sub-phase Pa)

Decision `P1`: ONE `users` table holds every person; a login profile is optional. Migration `e1c7b2d9f640`
(run `alembic upgrade head`). No API creates login-less people yet (management API = `Pb`, import = `Pc`–`Pe`,
users-panel UI = `Pf`); `Pa` prepares the schema, the sign-in guards and the read side.

## Columns (`users`)
| Column | Rule |
|---|---|
| `username`, `hashed_password`, `role_id` | NULLable, but `CHECK login_all_or_none`: all three set or all three NULL. A person without a profile has no role, hence NO capability (`scope_for` fails closed), and can never authenticate. |
| `login_enabled` | "the profile may sign in" (existing rows: true). `CHECK`: it cannot be true without a username. |
| `is_active` | keeps meaning "the person is active". |
| `first_name`, `last_name` | optional (old users keep only `full_name`). `full_name` is composed from them (`compose_full_name`, at most 128 characters in total = the column size). |
| `personnel_code` | integer 1–9999 (`CHECK`), unique among non-NULL values (partial unique index `uq_users_personnel_code`). |
| `mobile` | normalised `09xxxxxxxxx` (`canonical_mobile` accepts `+98`, `0098`, `98`, missing leading 0, Persian digits), unique among non-NULL values (`uq_users_mobile`). The `CHECK mobile_format` demands 11 characters, prefix `09` and ASCII digits only (spelled with `substr` + `IN`, so it means the same on SQLite and PostgreSQL). |

## Sign-in guard
Login, `load_principal` (every request) and `change_password` require credentials AND `login_enabled` AND `is_active`.
A refused attempt gives the same `InvalidCredentials` answer as a wrong password. A token of a user whose
`login_enabled` is switched off stops working at once (the principal is rebuilt per request).

## Review of every `User.is_active` site (all kept, reasons)
- `auth_service` (3 sites): sign-in guards above.
- `report_creation.participant_filter` / `participant_filter_any_group`: UNCHANGED on purpose — a person without a
  profile is an eligible participant under the existing eligibility rules (group membership for USER, any active person
  for EXPERT/MANAGEMENT).
- `dashboard.summary` and `group_admin` member counts: count active PEOPLE (including people without a profile).
  Whether the dashboard should separate "people" from "profiles" is decided in `Pf`.
- `user_admin`: list filter and `set_active` act on the person. The "last active MANAGEMENT" guards also require
  `login_enabled`, so a manager who cannot sign in never counts as the remaining one. `force_password_change_all` counts
  only profile holders.

## Users views
`GET /users`, `GET /users/{id}` and the mutating user endpoints use outer joins on `roles`: people without a profile
are listed with `username = null`, `role_code = null`, `has_login = false`. New fields: `first_name`, `last_name`,
`personnel_code`, `login_enabled`, `has_login`, `mobile`.

## Mobile number visibility
Capability `personnel.mobile.view` (MANAGEMENT ONLY since sub-phase `Pf`, decided 2026-11-23; AUDITOR gets no number from any endpoint; pinned in `tests/test_permissions.py`). Without it the
view returns `mobile: null`. The number is never put in audit metadata or exports. Granting the capability to other
users or groups is a future item.

## Profile operations on a login-less person
Role change, password reset and forced password change answer `409 user_has_no_profile` (profiles are created in `Pb`).

## Name contract (`PATCH /users/{id}`)
- A person who has `first_name`/`last_name`: they are authoritative. The request must send BOTH (`both_name_parts_required`), `full_name` is composed by the server and, if also sent, must equal the composition (`full_name_conflicts_with_parts`). Sending `full_name` alone answers `422 name_parts_required`. A name is never split from free text.
- An old user without parts: still edited through `full_name`; his parts stay empty.
- The audit entry carries the before/after of `full_name` and, when parts were sent, of both parts.

## Frontend contract (minimal, until `Pf`)
`User` in `frontend/src/api/types.ts` has nullable `username` / `role_code` / `role_label_fa` plus `has_login`. The
existing users page edits a person who has first/last name through those two fields (and an old user through the full name), shows «بدون پروفایل» for a person without a profile, offers only name edit, groups and
activate/deactivate for them, and never sends `role_code` in their edit. The full panel (group tags, no-group
warning, profile creation) is `Pf`.

# Management API for people (sub-phase Pb)

Migration `f2d8c3a1b750` (adds `users.no_group_alert_dismissed_count`; run `alembic upgrade head`). Backend only; the users
panel UI is `Pf`. All endpoints below need capability `users.manage` (MANAGEMENT); AUDITOR, EXPERT and USER get `403`.
Code: `app/services/personnel_admin.py`. The legacy `POST /users` is unchanged and is replaced in `Pf`.

| Endpoint | Purpose |
|---|---|
| `POST /users/people` | New person. `first_name`, `last_name`, `personnel_code`, `mobile` are mandatory (normalised by the `Pa` normalisers; `group_ids` optional). An optional `profile` object (`username`, `password`, `role_code`, `must_change_password`) creates the login profile in the same transaction. |
| `POST /users/{id}/profile` | Login profile for an existing person without one. `role_code` is `USER` or `EXPERT` only (`422 invalid_profile_role`). `409 user_has_profile`, `409 person_inactive`, `409 username_taken`. |
| `PUT /users/{id}/personnel-code` | Set/change the code. The FIRST assignment (old users) needs no reason; CHANGING an existing code needs `reason` = `TYPO`, `UNIT_CHANGE`, `REHIRE`, `ORG_WIDE_CHANGE` or `OTHER` (`OTHER` needs `note`). A code cannot be cleared. Audit: before/after, reason, note. `409 personnel_code_taken`. |
| `PUT /users/{id}/mobile` | Set/change the mobile number (cannot be cleared; `409 mobile_taken`). The audit records only that a number was changed, never the number. |
| `PUT /users/{id}/username` | Rename a profile. `reason` = `TYPO`, `NAME_CHANGE` or `OTHER` (`OTHER` needs `note`) is mandatory; `409 user_has_no_profile` for a person without a profile. Reports and sessions are untouched (tokens carry the user id). Audit: before/after, reason, note. |
| `POST /users/{id}/login/disable`, `/login/enable` | Switch the profile off (all refresh tokens are revoked at once; the person and history stay) or back on (enabling also revokes every refresh token). Known limit: an ACCESS token issued before a disable becomes valid again if the profile is enabled again within the access-token lifetime (`ACCESS_TOKEN_EXPIRE_MINUTES`, 15 by default); the same holds for deactivate/reactivate since Phase 4a. A per-user revocation cutoff is planned together with the token-version mechanism of `7c`. Not on oneself; the last active, sign-in-enabled MANAGEMENT is protected (`409 last_management`); enabling an inactive person is `409 person_inactive`. |
| `GET /users/no-group-alert`, `POST /users/no-group-alert/dismiss` | The «users without a group» alert of the calling manager: `{count, show}`. The count is active people with no group; MANAGEMENT and AUDITOR are excluded (organisation-wide scope needs no group). «Dismiss» stores the current count on the manager's own row; the alert shows again when the count is larger. If the count later falls below the stored value, the next `GET` lowers the stored value with it (so a new group-less person is never hidden). Each manager has his own state. The `GET` answers `Cache-Control: no-store`; it writes only in that one lowering case. |

Concurrency: unique personnel code / mobile / username are enforced by the database; two simultaneous writers get one
success and one clean `409` (PostgreSQL tests). Audit actions: `user.create_person`, `user.profile_create`,
`user.personnel_code_change`, `user.mobile_change`, `user.username_change`, `user.login_disable`, `user.login_enable`.
Mobile numbers and passwords never appear in audit metadata.

Note: the legacy `POST /users` (and the CLI that creates the first administrator) still accepts any role; `PATCH /users/{id}` can also change a role. Which roles the future panel (`Pf`) may create is a decision for `Pf`.

## Personnel import — parsing and validation (sub-phase Pc)

Service `app/services/personnel_import.py` (`analyse_personnel(db, filename, data) -> (report, rows)`); there is NO endpoint
yet (preview / confirm / undo, the inline fixing of group codes and the CSV problem report are `Pd`). The file parser
`app/services/import_parser.py` is shared with the equipment import: `parse_upload(filename, data, spec)` takes a
`ColumnSpec` (`EQUIPMENT_COLUMNS` is the default, `PERSONNEL_COLUMNS` is new). CSV delimiter detection now looks at the
HEADER line only (the `groups` cell contains `;`, which fooled data-row sniffing in principle); the equipment import
behaves as before (its tests pass unchanged).

Format (header in row 1, English column names): `first_name`, `last_name`, `personnel_code`, `mobile` (all required) and
`groups` (optional column). Same limits as the equipment import (2 MB, `.xlsx` / `.csv`; 200 rows for people). The import creates
NEW persons only; no profile data is ever read from the file.

| Rule | Row code (or report field) |
|---|---|
| Formula cell / date-typed cell | `formula_not_allowed` / `date_cell` (with `column`) |
| Required cell empty | `missing_first_name`, `missing_last_name`, `missing_personnel_code`, `missing_mobile` |
| Names (cleaned, 64 each, 128 composed) | `invalid_first_name`, `invalid_last_name`, `invalid_full_name` |
| Code 1–9999, no leading zero (Persian digits accepted) | `invalid_personnel_code` |
| Mobile (stored `09xxxxxxxxx`; `+98`, `98`, missing leading 0 accepted) | `invalid_mobile` |
| More than 20 group codes in one cell | `too_many_groups` |
| Same code / mobile in several rows of the file | not an error: a conflict cluster (see below), commit refused with `file_conflicts_unresolved` |
| Code / mobile already in the database (the owner is never named) | `personnel_code_taken`, `mobile_taken` |

Groups: codes separated by `;` (also `؛` and line breaks); every code must name an existing ACTIVE group. A bad code is
never stored and does NOT reject the row: the row stays valid with its good codes and appears in `group_issues`
(`invalid_groups`: `token` and `reason` = `unknown` / `inactive` / `malformed`), counted in `group_issue_count`; `Pd` will
refuse confirmation while any issue is unresolved. A row without any group is valid. Repeated codes collapse to one.

Report: `file_name`, `file_sha256`, `rows_total`, `valid_count` (rows that passed the row rules, including those with
group issues), `error_count`, `group_issue_count`, `ignored_columns`, `errors`, `group_issues`, `sample`. The mobile number
is never in the report (errors show the row number and the personnel code only). Errors and `rows` are sorted by file row.

## Personnel import — preview, corrections and commit (sub-phase Pd)

Endpoints (capability `equipment.import` = MANAGEMENT only; multipart with the same size/`Content-Length` rules as the
equipment import, shared in `app/api/upload_utils.py`):

- `POST /personnel/import/preview` — `file`, optional `corrections` (JSON text). Writes nothing. Returns the `Pc` report with
  the corrections applied: `group_issues`, `group_issue_count`, `valid_count` and `sample` are recomputed, and
  `dropped_count` is added.
- `POST /personnel/import/commit` — `file`, `preview_sha256` (the `file_sha256` of the preview; another file is
  `409 file_changed`), optional `corrections`. Answers `201` with the report plus `batch_id` and `created_count`.

The preview is stateless: every call re-reads the file, re-runs the `Pc` analysis and then applies `corrections`, a list of
`{row, op, token?, to?}`: `replace` (change one invalid group code `token`, as the preview showed it, to the active group
`to`), `remove` (drop that invalid code; the person stays) and `drop` (leave the whole row out). The server re-validates
all of it: unknown row `correction_row_not_found`, unknown token `correction_token_not_found`, replacement that is not an
ACTIVE group `correction_group_invalid`, a repeated correction `duplicate_correction` (all `422`); a malformed list is
`422 invalid_corrections` (at most 2,000 items). Only rows that passed the row rules can be corrected or dropped.

Commit: refused with `422 group_issues_unresolved` while any invalid group code is left, `422 nothing_to_import` when no
row remains. Otherwise ONE transaction creates a `personnel_import_batches` row and the people (`users.import_batch_id` set;
no username, password or role; `login_enabled = false`; active) with their groups, using the same canonical fields as
`create_person` (a test compares both). A code or mobile that was taken since the analysis (a concurrent import) rolls
everything back as `409 import_conflict`. Audit `personnel.import` on the batch: file name and hash, row counts, created,
rejected, dropped; never a mobile number. Rows with errors are simply not imported (`rejected_count` = errors + dropped).

Migration `a3e9d5b7c481`: table `personnel_import_batches` and `users.import_batch_id`. Not in `Pd`: the cancel of a batch, the
batch list and the `CSV` problem report (sub-phase `Pg`, below), the import page (`Pe`).

## Personnel import history, cancel and CSV problem report (sub-phase Pg)

There is NO separate undo button. A manager opens the import history, looks at a batch and cancels it from there.

Endpoints (router `app/api/personnel_import_history.py`, service `app/services/personnel_import_history.py`):

- `GET /personnel/import/batches` (`limit` 1-100, `offset`): newest first; per batch `id`, `kind` (always `PERSONNEL` for now), `file_name`,
  `created_at`, `created_by_name`, `created_count`, `rejected_count`, `removed_count`, `remaining_count` (counted live from
  `users.import_batch_id`), `status` (`complete` = nobody removed yet, `partial`, `cancelled` = nobody left), `undone_at` (the LAST cancel).
- `GET /personnel/import/batches/{id}/people`: the people of the batch who still exist with their CURRENT data (not the data of the import
  day); `mobile` only for holders of `personnel.mobile.view`. Both reads need `audit.view`: MANAGEMENT and AUDITOR.
- `POST /personnel/import/batches/{id}/cancel-preview` (writes nothing) -> `remaining_count`, `removable_count`, `exempt_count`,
  `exempt_reasons` (`profile`, `reports`, `participation`, `stars`; one person may count under several) and a `fingerprint` (SHA-256 of the batch id
  and the sorted ids that would be removed).
- `POST /personnel/import/batches/{id}/cancel` with `{fingerprint}`: recomputes under a `FOR UPDATE` lock on the batch row and on the batch's
  people (id order); a different fingerprint is `409 batch_changed` (+ the new counts) and nothing is deleted or re-run on its own;
  nothing removable is `409 nothing_to_cancel`; unknown batch `404 import_batch_not_found`. Both cancel endpoints need `equipment.import`: MANAGEMENT
  only, any manager for any batch; AUDITOR `403`.
- `POST /personnel/import/problems.csv` (multipart `file`, optional `corrections`, `equipment.import`): the file is analysed again (the preview keeps
  nothing) and the problem rows are returned as `text/csv` (`UTF-8` with `BOM`, `CRLF`, `no-store`): `row`, `first_name`, `last_name` (since `Pi`), `personnel_code` (as typed, at most 16
  characters), `problem_code`, `description_fa`; row errors plus the invalid group codes still left after the corrections. Never a mobile number,
  never the owner of a duplicate. A cell that begins with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`.

Cancel rules: a cancel hard-deletes (with their group memberships) every person of the batch who is still unused, and keeps everybody who has a
reference: a login profile, a report he created, a labor row (participation) or a star given or received. This is the Master Prompt's
«import-undo» exception to «never hard-delete history»: only rows created by that batch and referred to by nothing are deleted. The cancel can be
repeated later for the people who were kept; there is no time limit. The batch row is never deleted: `removed_count` adds up, `undone_at` and
`undone_by` mean the last cancel. Audit `personnel.import_cancel` on the batch with counts only (`removed`, `kept`, `remaining_before`), never names,
codes or mobile numbers. A reference that appears at the last moment ends in the foreign key (`RESTRICT`) and the same `409 batch_changed`.

Migration `b4f0e6c8d592`: `personnel_import_batches.kind` (default `PERSONNEL`, so the equipment import can share the history later; not scheduled)
and `removed_count` (default 0). Known limits: the list of people shows the current state, so removed people are only counted; the Persian texts of the
CSV live in the service (`PROBLEM_FA`) and must be extended with every new import problem code (a test compares them with the codes of the parser).

## Personnel import — Persian headers, names, same-name notice, template (sub-phase Pi)

Backend only, no migration. The frontend part is `Pj`.

- **Header names.** `ColumnSpec` takes an optional `aliases` map (standard name → other spellings); only `PERSONNEL_COLUMNS`
  has one, the equipment import is unchanged. Standard (English) names still match exactly as before. An alias matches in
  FOLDED form (`app.core.normalize.fold_text`: all spaces, ZWNJ/ZWJ and direction marks, tatweel and Arabic diacritics
  (including the hamza mark) removed; Arabic `ي`/`ى`/`ك` → `ی`/`ک`; Persian/Arabic digits → Latin; lower case). Aliases:
  first name `نام`, `اسم`, `نام کوچک`; last name `نام خانوادگی`, `فامیلی`, `فامیل`; code `کد پرسنلی`, `کد پرسنل`,
  `شماره پرسنلی`; groups `گروه‌های عضو`, `گروه‌ها`, `گروه`; mobile `شماره موبایل`, `موبایل`, `شماره همراه`, `همراه`,
  `شماره تلفن همراه`, `شماره تلفن`. English and Persian names may be mixed in one file, but both names of ONE column in the
  same file give `422 duplicate_columns`. Unknown titled columns are still listed in `ignored_columns`; blank titles are
  ignored. The `CSV` delimiter detection (`_header_delimiter`) counts recognised names through the same lookup.
- **Names in the preview.** Every element of `errors` and `group_issues` carries `first_name` and `last_name` (cleaned, at most
  64 characters) beside `personnel_code`. In `errors` they are ABSENT (the route uses `exclude_none`, so `null` is not sent)
  when the name itself is the problem (`missing_*_name`, `invalid_*_name`, `invalid_full_name`) or a name cell is a formula or
  date. Never the mobile number.
- **Same-name notice (preview only, non-blocking).** `same_name_count` = importable rows (after the corrections; rows with
  a group issue included, rows with errors and dropped rows excluded) whose folded full name equals the folded `full_name` of
  at least one EXISTING person (active or not, with or without a profile, old users included); `same_names` = at most 200 of
  those rows in file order: `row`, `first_name`, `last_name`, `personnel_code` (the file's), `matches_total`, `matches`
  (at most 5, ascending personnel code, people without a code last: `full_name`, `personnel_code` (absent if none),
  `group_codes`, `is_active`, `has_profile`, and `mobile` (absent for an old person without one)); each row also carries the
  file row's own `mobile`. Mobile numbers are present ONLY when the caller holds `personnel.mobile.view` (the route passes
  `include_mobile`; the service default is off): a new person can only reach this list when BOTH his code and mobile differ
  from the existing one's, so seeing the two numbers side by side (for example `09123214587` and `09143214587`) shows whether
  one person was typed twice. Exact match only; rows of the file are not compared with each other. The commit answer has none
  of these keys and a same name never blocks or needs a confirmation. Usernames and roles are never returned; a mobile number
  is never in the commit answer, the `CSV` or the audit.
- **Conflict clusters in the file (changed in `Pj`, Amin 2026-11-21).** Rows that share a personnel code or a mobile form a
  cluster (connected components, so a chain of rows is one cluster). NOBODY wins by default: no row of a cluster is
  importable, none is an error, and they are counted in `file_conflict_count` / listed in `file_conflicts` (`shared`,
  `same_name` = every row has the same name, `rows` with row, names, code, valid `group_codes`; `mobile` only in the preview
  and only with the capability). The manager keeps ONE row (the page sends a `drop` for every other row) or drops them all;
  dropped rows are known BEFORE the analysis and claim nothing, so one preview re-run shows the result. The commit is refused
  with `422 file_conflicts_unresolved` while a cluster is left. Any row that passed the row rules may be dropped; a row
  rejected for another reason (code or mobile already in the database, invalid) still cannot (`correction_row_not_found`).
  The codes `duplicate_personnel_code_in_file` and `duplicate_mobile_in_file` no longer exist.
- **Same name twice in the file** (different code AND mobile, so no cluster): the preview lists them in `same_name_in_file`
  (`rows`; mobile only with the capability) as a plain warning; nothing is decided or blocked.
- **Row limit.** A personnel file holds at most 200 data rows (`PERSONNEL_IMPORT_MAX_ROWS`, default 200; `422 too_many_rows` with
  `max_rows`); the equipment import keeps 1000. Every row can therefore be listed and decided.
- **`CSV` problem report** columns: `row`, `first_name`, `last_name`, `personnel_code`, `problem_code`, `description_fa`
  (name cells empty when the name is the problem; the spreadsheet-safe prefix applies to names too).
- **Template.** `frontend/public/personnel-import-template.xlsx` (served at the site root by Vite): Persian headers
  `نام`، `نام خانوادگی`، `کد پرسنلی`، `گروه‌های عضو`، `شماره موبایل`; right-to-left; header frozen at `A2`; NO sheet protection
  (rows can be inserted and deleted); columns after `F` hidden; data validations on `A2:E201`; two header notes (the first
  names the 200-row limit); the mobile column keeps its display format. A backend test reads a copy of it (with one sample row) through the
  real parser. Opening it in real Excel is NOT TESTED.

## Users list — backend part (sub-phase Pf)

- `GET /users` orders people who need a group FIRST on every page (server-side; then `full_name`, `id`), so paging
  cannot scatter them. New filter `has_login` (`true` = has a username, `false` = person without an account). `q` also
  matches a personnel code EXACTLY (Persian digits accepted; no prefix match on codes).
- `needs_group` on every user view: an ACTIVE person with no group who is not MANAGEMENT or AUDITOR. One definition
  (`user_admin.needs_group_condition`, SQL) serves the banner count, the list order and the flag (its Python twin in
  `_view`; `tests/test_personnel_pf.py` keeps them equal).
- Migration `c5a1f7d3e902` (data only): `roles.label_fa` of `USER` becomes «تکنسین کاربر». The role code and every
  permission are unchanged; no role is added.
- AUDITOR reads the list and the people but never receives a mobile number (users views, import-history people list);
  `GET /users/no-group-alert` stays MANAGEMENT-only (`403` for the others).
