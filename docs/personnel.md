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
Capability `personnel.mobile.view` (MANAGEMENT and AUDITOR only; pinned in `tests/test_permissions.py`). Without it the
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
