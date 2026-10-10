# Management API (Phase 4a)

All endpoints need `Authorization: Bearer <access token>` and a completed password change. Errors are
`{"detail": "<code>"}` or `{"detail": {"code": "<code>", ...}}` (stable codes for the frontend). Lists are
`{items, total, limit, offset}` with `limit` 1-100 (default 50), `offset` 0-100000. Nothing is ever hard-deleted:
"delete" = deactivate (soft delete). Every write is audited with old/new values; passwords never appear in audit rows.

## Who can do what
| Area | Read | Write |
|---|---|---|
| Users | MANAGEMENT, AUDITOR | MANAGEMENT |
| Groups | everyone: own ACTIVE groups; MANAGEMENT/AUDITOR: all (+`include_inactive`) | MANAGEMENT |
| Equipment | everyone: ACTIVE equipment of own groups; MANAGEMENT/AUDITOR: all | MANAGEMENT |
| Report types | every role (active only); MANAGEMENT also `include_inactive` | MANAGEMENT |
| Settings | MANAGEMENT | MANAGEMENT (AUDITOR has no settings access) |

Out-of-scope objects answer exactly like missing ones (`404`, same body) — no existence oracle.

## Endpoints
**Users** — `GET /users` (`q`, `role_code`, `is_active`, `group_id`) · `POST /users` · `GET|PATCH /users/{id}` (full_name, role_code)
· `POST /users/{id}/deactivate|activate` · `PUT /users/{id}/groups` (replaces the set) · `POST /users/{id}/reset-password`
· `POST /users/{id}/force-password-change` · `POST /users/force-password-change-all` (every active user, ends all sessions).
**Groups** — `GET|POST /groups` · `GET|PATCH /groups/{id}` (name, description) · `POST /groups/{id}/deactivate|activate`.
**Equipment** — `GET|POST /equipment` (`q`, `group_id`, `is_active`) · `GET|PATCH /equipment/{id}` (description)
· `POST /equipment/{id}/move` · `POST /equipment/{id}/deactivate|activate`.
**Report types** — `GET|POST /report-types` · `PATCH /report-types/{id}` (name_fa, is_failure) · `POST /report-types/{id}/deactivate|activate`.
**Settings** — `GET /settings` · `PUT /settings/{key}` `{"value": <int>}`.

## Rules (all enforced server-side and tested)
* **Canonical identifiers** (`app/core/normalize.py`, plus DB `CHECK` constraints): usernames lower-case `a-z 0-9 . _ -` (3-64);
  equipment codes UPPER-case `A-Z 0-9 . _ / -` (1-64, no spaces); group codes `A-Z0-9` starting with a letter (2-16);
  report-type codes `A-Z0-9_`. Uniqueness is therefore case-insensitive. Login lower-cases the typed username.
* **Immutable**: group `code`, equipment `equipment_code`, report-type `code` (unknown/immutable fields in a body -> `422`).
* **Users**: you cannot deactivate yourself, change your own role, or reset your own password through the admin API
  (`use_change_password_endpoint`). At least one active MANAGEMENT always remains (`last_management`), even under
  concurrent requests (row locks). Deactivation ends sessions immediately. Admin-set/reset passwords default to
  `must_change_password=true`. New group memberships must be in ACTIVE groups; leaving an inactive group is allowed.
* **Groups**: cannot be deactivated while they hold ACTIVE equipment (`group_has_active_equipment`, with `count`).
  Equipment cannot be created/moved/reactivated into an inactive group (`group_inactive`).
* **Equipment move** is audited (`equipment.move`: from/to group). Existing reports keep their frozen `reports.group_id`.
* **Report types**: `is_failure` cannot change once any report uses the type (`report_type_in_use`); create a new type instead.
* **Null fields**: an explicit JSON `null` for a non-nullable field (group `name`, report-type `name_fa`/`is_failure`) is `422`; only `description` fields are nullable (null clears them).
* **Settings**: writing the value a setting already has is a no-op (no audit row, `updated_by` unchanged); only registered keys; out-of-range values are rejected, never clamped. Reads clamp, so a damaged row can
  never weaken a policy.

| Key | Default | Allowed |
|---|---|---|
| `REPORT_EDIT_WINDOW_HOURS` | 24 | 0-720, **-1 = unlimited**, 0 = USER cannot edit |
| `PASSWORD_MIN_LENGTH` | 8 | 8-64 |
| `LOGIN_MAX_ATTEMPTS` | 5 | 3-20 |
| `LOGIN_LOCKOUT_MINUTES` | 15 | 1-1440 |
| `LOGIN_MAX_ATTEMPTS_PER_IP` | 0 (off) | 0-100000 |

## Notes for later phases
* Phase 6 report creation must take a SHARE lock on the report-type row (and on the equipment's group) before inserting, mirroring
  the FOR UPDATE locks used here, so `is_failure` flips and group deactivation cannot interleave with report creation.
* Phase 7 reads `get_report_edit_window_hours(db)`: `None` = unlimited.
* Migration `c4a9d7e2b610` lower-cases usernames and upper-cases codes of existing rows; it STOPS (changing nothing) if two
  rows differ only by case.
