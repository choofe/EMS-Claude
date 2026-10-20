# Report creation (Phase 6)

Create a maintenance report, with server-side drafts. Capability `REPORT_CREATE`: USER/EXPERT within their groups,
MANAGEMENT everywhere, **AUDITOR none (403)**. Report detail/history/editing = Phase 7.

## Endpoints (`/reports`)
| Endpoint | Purpose |
|---|---|
| `POST /reports` | Create. Body: `report_type_id`, `event_datetime` (ISO **with offset**; naive = 422), `description`, `participants[{user_id, minutes}]` (rules by the type's `labor_mode`), `equipment_id` and/or `group_id` (see *General reports*), optional `draft_id`. `201` returns the report (`report_number`, snapshot `group_id`/`group_code`, participants). Unknown body fields (e.g. `created_by`, `group_id`) → 422: they can never be client-supplied. |
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

## Report types: labor mode and general reports (2026-10-16)
`report_types` has two management-editable settings (editable even when reports use the type; they only steer validation of NEW reports):

| `labor_mode` | Server rule | Entry form (frontend) |
|---|---|---|
| `REQUIRED` (default; the 4 seeded types) | ≥1 participant, else `422 labor_required` | labor section shown, **pre-filled with the author and `default_labor_minutes`**; removing the author → warning; submitting with nobody → blocking error "no hours entered" |
| `OPTIONAL` | 0..30 participants | labor section shown, may stay empty |
| `ON_REQUEST` | same as `OPTIONAL` | section hidden behind the button «اضافه کردن ساعات افراد - اختیاری» |
| `NONE` | participants must be empty, else `422 labor_not_allowed` | no labor section |

The default 30 minutes is a **form pre-fill, never a silent server insert**: the author sees it and can change it, and an empty list is rejected rather than papered over.

`equipment_required = false` makes a type a **general report** type (letter-like: spare-part request, failure warning, detailed analysis). Then `equipment_id` may be omitted and `group_id` is **required** and checked against the caller's scope (outside it = `404 group_not_found`, same as missing; inactive = `409 group_inactive`; the group row is read `FOR SHARE`). If both are sent they must agree (`422 group_mismatch`). A normal type without equipment → `422 equipment_required`. The report gets the next number of its group like any other, and `reports.is_general` (snapshot of `NOT type.equipment_required`, frozen like `group_id`) marks it for future list filters/tags. DB rule: `CHECK (equipment_id IS NOT NULL OR is_general)`. Equipment-less reports never appear in equipment history or the quick-pick; group-scoped visibility works unchanged because it uses `reports.group_id`.
No general type is seeded; MANAGEMENT creates them under Report Types (`labor_mode`, `equipment_required` in `POST/PATCH /report-types`).

## Numbering and concurrency
One transaction, fixed lock order: equipment (`FOR SHARE`) → report type (`FOR SHARE`, so a concurrent `is_failure` freeze serialises with us) → group (`FOR SHARE`, general reports only) → draft (`FOR UPDATE`) → `report_sequences` (`INSERT … ON CONFLICT DO NOTHING`, then `UPDATE … SET last_number = last_number+1 RETURNING`) → inserts → audit → commit.
The sequence row lock is taken last and released at commit, so concurrent creators queue on it, numbers are unique, and a failed creation rolls the counter back (**no gaps from failures**). `UNIQUE(report_number)` is the last line of defence. Format `YY-GROUPCODE-NNN`, YY = Jalali year of `created_at` (Asia/Tehran), frozen in `report_jalali_year`.
`created_at` is set once by the service at INSERT; no endpoint can change it.

## Drafts
Server-side table `report_drafts` (`user_id`, JSON `payload`, `version`). A draft is **not** a report: no number, never in analytics/export, visible to its owner only (another user's id → 404, same as missing). It is hard-deleted when the report is created from it (same transaction, row locked → a double submit or two tabs yield exactly one report, the loser gets `404 draft_not_found`) or when discarded.
- **Limit** per user = setting `MAX_DRAFTS_PER_USER` (default 1, 1–20; MANAGEMENT-editable). It is a setting, not a constraint: raising it needs no migration. `409 draft_limit_reached` (+`limit`). Creation locks the user row (`FOR NO KEY UPDATE`) so parallel creates cannot exceed it.
- **Autosave** = `PUT` with the `version` last seen; stale version → `409 draft_version_conflict` (+`current_version`), nothing overwritten. Payload fields are all optional and untrusted; ids in a draft are validated only at submit. Each draft participant may carry a display `name` (≤128 chars) so a restored draft can show it when the person cannot be looked up; it is cosmetic and never used for authorization.
- Not done (future): per-role draft limits (the setting is global today; a per-role value fits the same registry), stale-draft cleanup job, offline copy on the phone (Phase 11).

## Tests
`tests/test_report_creation.py` (43, SQLite) and `tests/postgres/test_report_creation_pg.py` (10, real concurrency: 40 parallel creates → numbers 1..40 exactly; failures burn no number; 8 parallel submits of one draft → 1 report; parallel draft creates respect the limit; stale saves never overwrite; creation waits for an in-flight equipment move). Mutation-checked: removing equipment scope, participant filter, draft ownership (read and submit), future check, duplicate check, draft consumption, limit, version check, sequence row lock, equipment `FOR SHARE`, draft row lock, user-row lock, and the labor-mode / equipment-required / group-scope / group-mismatch / inactive-group / `is_general` rules each makes a test fail.

## Future (not built)
- Report types restricted per group (needs a `report_type_groups` mapping + admin UI); today all active types are offered to everyone.
- Phase 7 must handle `equipment_id IS NULL` in report detail/lists and add the "general" tag/filter (`is_general`).
- Idempotency key for API clients that submit without a draft (the web UI always submits from a draft, creating one first if needed).
