# Reports — read side (Phase 7a)

All routes need `report.view` (USER/EXPERT: their groups; MANAGEMENT/AUDITOR: everything). Scope is always
`reports.group_id` (the frozen snapshot), never the equipment's current group. Soft-deleted reports are hidden from
everybody until sub-phase 7d. A report outside the caller's scope is absent from lists and `404 report_not_found` on
detail (same answer as a missing id).

| Route | Purpose |
|---|---|
| `GET /reports` | list, newest event first, `cursor` pagination (`limit` 1–100, default 25) |
| `GET /reports/columns` | column registry for the caller (`key`, `label_fa`, `default_visible`, `sortable`) |
| `GET /reports/{id}` | detail: full description, lock state, participants allowed for the caller |

**List filters:** `date_from`, `date_to` (event time; must carry a UTC offset, naive values are `422`), `report_type_id`, `group_id`, `equipment_id` (this is the
equipment history), `equipment_code` (partial, case-insensitive), `created_by`, `general_only`, `report_number`
(partial), `q` (description text; `%`/`_` are literal), `mine` (reports the caller participates in). Filters only
narrow the caller's scope. `sort_by` ∈ `event_datetime` | `created_at`, `order` = `asc`|`desc`; the cursor is opaque
(`422 invalid_cursor` if tampered). Ties are broken by report id, so pages never repeat or skip rows.

**General reports** have `equipment: null` and `is_general: true`.

**Labor rows** (`my_minutes`, `total_minutes`, `people_count`, detail `participants`):
- anyone sees his OWN row in any report he can see (`my_minutes`, `participants[].is_me`);
- ALL rows of a report only where `labor.view` allows: USER → reports he created, EXPERT → reports of his groups,
  MANAGEMENT/AUDITOR → all. Otherwise `total_minutes`/`people_count` are `null` and `participants_complete` is `false`;
- being a participant never grants access to a report of a group the caller does not belong to.

**Moved equipment:** with an `equipment_id` filter, `other_group_reports_may_exist` is `true` when the equipment has
reports of a group the caller cannot see (never a number). Always `false` for MANAGEMENT/AUDITOR.

**Column registry** (`app/services/report_columns.py`): the code-level list a future per-user column choice will use.
Choosing columns is cosmetic only: the API never returns data the caller may not see.

The UI (list, detail, equipment history) is Phase 7b: see `docs/frontend.md`.

Not in 7a/7b: edit marker / history (7c), lock and soft-delete actions (7d), priority fields (7e–7g). The
USER labor panel (own minutes in non-member groups, 60-day window) belongs to Phase 8.
