# Report creation (Phase 6)

Create a maintenance report, with server-side drafts. Capability `REPORT_CREATE`: USER/EXPERT within their groups,
MANAGEMENT everywhere, **AUDITOR none (403)**. Report detail/history/editing = Phase 7.

## Endpoints (`/reports`)
| Endpoint | Purpose |
|---|---|
| `POST /reports` | Create. Body: `report_type_id`, `event_datetime` (ISO **with offset**; naive = 422), `description`, `participants[{user_id, minutes}]` (rules by the type's `labor_mode`), `equipment_id` and/or `group_id` (see *General reports*), optional `draft_id`, optional `client_request_id` (idempotency key, below). `201` returns the report (`report_number`, snapshot `group_id`/`group_code`, participants). Unknown body fields (e.g. `created_by`, `group_id`) → 422: they can never be client-supplied. |
| `GET /reports/entry-config` | Form constants: `default_labor_minutes` (setting `DEFAULT_LABOR_MINUTES`, default 30), limits, and the groups the caller may file general reports in. |
| `GET /reports/participant-candidates?equipment_id=` **or** `?group_id=` (exactly one) `&q=&limit=` | Users the caller may list as participants for that equipment's group. Returns only `{id, full_name}`. |
| `GET /reports/equipment-quick-pick?limit=` | The caller's **own** recent / most-used equipment (active, still in scope). |
| `POST /reports/heartbeat` | Session liveness ping (401/403 if the session is gone) + server time. Writes nothing. Idle timeout = Phase 9b. |
| `GET/POST /reports/drafts`, `GET/PUT/DELETE /reports/drafts/{id}` | Private drafts (below). |

## Rules enforced on the server (whatever the client or a draft says)
- **Equipment** must be in the caller's scope and active. Missing and not-yours both answer `404 equipment_not_found` (no existence oracle); inactive → `409 equipment_inactive`.
- **Report type** active (`409 report_type_inactive`; unknown `404`). Types are organisation-wide (per-group types: future, see below).
- **Group snapshot**: `reports.group_id` = `equipment.group_id` at creation, frozen. The equipment row is read `FOR SHARE`, so a concurrent equipment move either finishes first (new group is used) or waits for the report to commit.
- **Participants**: count by `labor_mode` (below), ≤30, active users, each at most once (`422 participant_duplicate`), `minutes` integer 1–1440 (`422`). Eligibility (one function, `participant_filter`, used by both the candidate list and the create check → `422 participant_not_allowed` + `user_ids`):
  USER → members of the report's group (default), or any active user when `REPORT_USER_PARTICIPANTS_ALL_USERS`=1 (e.g. a helper from another group; default 0) · EXPERT → any active user (`REPORT_EXPERT_PARTICIPANTS_ALL_USERS`=1, default) or group members (=0) · MANAGEMENT → any active user. The two settings are independent (per role) and MANAGEMENT-editable.
- **`event_datetime`**: converted to UTC; more than 5 minutes in the future → `422 event_in_future`.
- **`description`**: trimmed, line breaks kept, 1–5000 chars (`422 invalid_description`).
- **DB integrity** (migration `f6c3d9a7b104`): `UNIQUE(report_id, user_id)` and `CHECK 0 < minutes ≤ 1440` on `report_participants`.
- **Audit**: one `report.create` row: `report_number, equipment_id, group_id, report_type_id, event_datetime, participant_count, total_minutes, from_draft`. No description text, no participant ids, no secrets.

## Report types: labor and equipment modes, general reports (2026-10-22)
`report_types` has two management-editable rule sets that share ONE vocabulary (they only steer validation of NEW reports, so they may change even when reports use the type):

| mode | meaning | server rule | entry form |
|---|---|---|---|
| `REQUIRED` (default; the 4 seeded types) | mandatory | labor: ≥1 participant (`422 labor_required`); equipment: must be given (`422 equipment_required`) | always shown; labor is **pre-filled with the author and `DEFAULT_LABOR_MINUTES`**; removing the author asks for confirmation then warns; submitting with nobody listed is blocked with «ساعت کاری وارد نشده است» |
| `OPTIONAL` | added on the author's request | may be omitted | hidden behind «اضافه کردن ساعات افراد - اختیاری» / «افزودن تجهیز - اختیاری» |
| `NONE` | cannot be added | participants → `422 labor_not_allowed`; equipment → `422 equipment_not_allowed` | not shown |

- Fields: `labor_mode`, `equipment_mode` (`POST/PATCH /report-types`), plus `help_fa` (≤300 chars, optional guide shown behind the «؟» of the type picker; explicit `null` clears it). The old `ON_REQUEST` was merged into `OPTIONAL`; `equipment_required` became `equipment_mode` (migration `b8e5f2a9c326`).
- A type whose `equipment_mode` is not `REQUIRED` makes a **general report** (letter-like: spare-part request, failure warning, detailed analysis). Without equipment, `group_id` is **required** and checked against the caller's scope (outside it = `404 group_not_found`, same as missing; inactive = `409 group_inactive`; the group row is read `FOR SHARE`). If both equipment and group are sent they must agree (`422 group_mismatch`). The report gets the next number of its group like any other, and `reports.is_general` (snapshot of `equipment_mode != REQUIRED`, frozen like `group_id`) marks it for future list filters/tags. DB rule: `CHECK (equipment_id IS NOT NULL OR is_general)`. Equipment-less reports never appear in equipment history or the quick-pick; group-scoped visibility works unchanged because it uses `reports.group_id`.
- The default 30 minutes is a **form pre-fill, never a silent server insert**: the author sees it and can change it, and an empty list is rejected rather than papered over.
No general type is seeded; MANAGEMENT creates them under Report Types.

## Numbering and concurrency
One transaction, fixed lock order: equipment (`FOR SHARE`) → report type (`FOR SHARE`, so a concurrent `is_failure` freeze serialises with us) → group (`FOR SHARE`, general reports only) → draft (`FOR UPDATE`) → `report_sequences` (`INSERT … ON CONFLICT DO NOTHING`, then `UPDATE … SET last_number = last_number+1 RETURNING`) → inserts → audit → commit.
The sequence row lock is taken last and released at commit, so concurrent creators queue on it, numbers are unique, and a failed creation rolls the counter back (**no gaps from failures**). `UNIQUE(report_number)` is the last line of defence. Format `YY-GROUPCODE-NNN`, YY = Jalali year of `created_at` (Asia/Tehran), frozen in `report_jalali_year`.
`created_at` is set once by the service at INSERT; no endpoint can change it.

## One submission = one report (idempotency key, 2026-10-24)
The form makes one random `client_request_id` (8-64 chars `[A-Za-z0-9_-]`) per submission attempt chain and sends the SAME key on every retry. `reports` stores it with `UNIQUE(created_by, client_request_id)` (migration `c9f6a3b0d437`; NULLs never collide, so API clients without a key are unaffected).
- The first request creates the report (`201`). Any later request with the same key by the same author — e.g. a retry after the response was lost on flaky Wi-Fi — returns **that report** (`200`, `already_created: true`) and creates nothing: no second number, no doubled labor hours. The key lookup happens before the draft check, so a retry still succeeds although the first attempt already consumed the draft.
- A retry that carries both the key and the (already consumed) `draft_id` — including a parallel one that was waiting on the draft's row lock while the winner committed — is answered with the report, never with `draft_not_found`: when the draft is missing the key is looked up once more before the 404.
- Two attempts racing on one key: the loser's transaction (including its sequence increment) is rolled back and it receives the winner's report. A failed attempt (validation, scope, ...) does not use the key up. Keys are per author.
- Separately, the draft still protects against a SECOND device/tab that holds the same draft: its submit gets `404 draft_not_found`, and the web form then refuses a plain retry — it asks the author to confirm explicitly («ثبت به‌عنوان گزارش جدید», which uses a new key).

## Drafts (one per user)
Server-side table `report_drafts` (`user_id`, JSON `payload`, `version`). A draft is **not** a report: no number, never in analytics/export, visible to its owner only (another user's id → 404, same as missing).
- **One draft per user** (decided 2026-10-22; fixed in code, no setting — lifting it later needs no migration). Creating a second one → `409 draft_limit_reached`: the client treats it as "another tab/device already has a draft". Creation locks the user row (`FOR NO KEY UPDATE`) so parallel creates cannot exceed it.
- **Submitting any report consumes the author's drafts**: the named `draft_id` is locked (`FOR UPDATE`; missing → `404 draft_not_found` unless the idempotency key already matches), and **all** drafts of the author are deleted in the same transaction. The web UI always submits from a draft (creating one first if needed).
- **Saves** = `PUT` with the `version` last seen; stale → `409 draft_version_conflict` (+`current_version`), nothing overwritten. `404` on a save means the draft was submitted/deleted elsewhere: the client stops and must NOT recreate it. Payload fields are all optional and untrusted; ids in a draft are validated only at submit. Each draft participant may carry a display `name` (≤128 chars) so a restored draft can show it when the person cannot be looked up; it is cosmetic and never used for authorization.
- *When* the client pushes a draft to the server is a UI policy (large texts only; see `docs/frontend.md`), not a server rule.
- Not done (future): stale-draft cleanup job, offline queue beyond the device-local copy (Phase 11).

## Tests
`tests/test_report_creation.py` (SQLite) and `tests/postgres/test_report_creation_pg.py` (10, real concurrency: 40 parallel creates → numbers 1..40 exactly; failures burn no number; 8 parallel submits of one draft → 1 report; parallel draft creates respect the limit; stale saves never overwrite; creation waits for an in-flight equipment move). Mutation-checked: removing equipment scope, participant filter, draft ownership (read and submit), future check, duplicate check, draft consumption, limit, version check, sequence row lock, equipment `FOR SHARE`, draft row lock, user-row lock, and the labor-mode / equipment-required / group-scope / group-mismatch / inactive-group / `is_general` rules each makes a test fail.

## Future (not built)
- Report types restricted per group (needs a `report_type_groups` mapping + admin UI); today all active types are offered to everyone.
- Phase 7 must handle `equipment_id IS NULL` in report detail/lists and add the "general" tag/filter (`is_general`).
- Idempotency key for API clients that submit without a draft (the web UI always submits from a draft, creating one first if needed).
