# Equipment Maintenance Reporting System — Handoff / Continuation Prompt

Paste this whole file into the **Project knowledge** (or the first message)
of the new Claude Project. It captures everything agreed so far so no
work is redone and no decision is lost.

---

## 0. How to use this file

You are continuing an ongoing multi-phase software project as the same
AI software team (Architect, Backend/Frontend Dev, DB Architect,
Security Engineer, DevOps, QA, Reviewer, UX/UI, Reporting Engineer)
described in the original master prompt (attached separately as
`00-original-spec.md` in this Project's knowledge — re-attach it,
it is the governing document for scope, phases, and rules).

**Current status: Phase 0 is complete and approved. Phase 1 is
in progress (skeleton built and passing tests, not yet formally
signed off). Do not redo Phase 0. Do not regenerate Phase 1 files
from scratch — the 20 files below already exist and pass tests;
continue from them.**

---

## 1. Phase 0 — Decisions Made (all approved by Supervisor)

1. **Equipment code uniqueness:** Globally unique across the whole
   organization (not just per-group). Codes are pre-existing and are
   entered primarily via Excel import.
2. **Report numbering:** Persian/Jalali year, two-digit prefix (e.g.
   `05` for 1405), format `YY-GROUPCODE-NNN`. Sequence
   (`report_sequences`) is keyed by `(group_id, jalali_year)`.
3. **Dates/timezone:** Stored internally as UTC/Gregorian (standard
   DB practice), but **displayed everywhere in the UI as Jalali**,
   converted using timezone `Asia/Tehran`. Backend: `jdatetime`.
   Frontend: `jalaali-js` (to be added when frontend work starts).
4. **Labor-hour visibility (USER role) — precise rule:** A USER sees
   `report_participants` rows only for reports **they personally
   created** (`created_by = me`), regardless of which participant the
   hours were logged for. They do NOT see labor hours logged by a
   colleague, even for the same person. EXPERT and MANAGEMENT can
   aggregate by `user_id` across the whole group/org (they see all
   reports in scope), so they can see a person's total hours across
   multiple creators — USER cannot.
5. **Editing:** EXPERT has unlimited-time edit rights, but only within
   their own group(s). Deletion is Management-only, and must be
   **soft delete** (archive/inactive), never physical delete.
6. **Report locking (new feature, approved):** Management can give a
   report a final sign-off, which sets `is_locked = true` and freezes
   it against all further edits (even by Management) unless an
   explicit "unlock" action is performed, which is itself audited.
   Schema columns (`is_locked`, `locked_at`, `locked_by`) are added
   in Phase 2 now; the UI/workflow for it is implemented in Phase 7
   as originally planned.
7. **Hosting/free-tier:** Deferred to Phase 12 — the choice between
   Railway/Render/Supabase/Neon does not materially affect the
   architecture, so no need to decide early.
8. **Three proposed extra features — all approved:**
   - Report status flag (future).
   - "Recently used / frequently used equipment" quick-pick for fast
     report entry, scoped to the user's authorized groups (MVP).
   - CSV/Excel import template download (MVP).
9. **Multi-branch / multi-organization question (resolved):**
   Supervisor may eventually run separate deployments per
   branch/department. Chosen approach: **Option A — API-based
   aggregation**, not a shared multi-tenant database. A new role,
   `AUDITOR` (name TBD), is added: it has exactly the same
   organization-wide **read/report/export** permissions as
   MANAGEMENT, but zero write/delete/import/settings permissions.
   This role's token (or a dedicated API key) is what an eventual
   upstream aggregation dashboard would use to pull data from each
   independent deployment. This is implemented as a *composition* of
   existing permission primitives, not new logic. A future feature
   (not yet in scope) is upstream-manager-to-branch-manager messaging.

## 2. Phase 1 — Status: IN PROGRESS (not yet formally signed off)

**Goal (per master spec Phase 1):** repository structure, backend
skeleton, frontend skeleton, DB connection, env config, migrations,
logging, test framework, health endpoint — all tested.

**Done:**
- Backend skeleton built with FastAPI + async SQLAlchemy 2.x +
  Alembic, structured logging, Pydantic-based settings from env vars.
- `/health/live` (no DB dependency) and `/health/ready` (executes
  `SELECT 1` against the DB) endpoints implemented.
- Alembic wired to read `DATABASE_URL` from app settings (not
  hard-coded), naming convention set for stable constraint names.
- Test suite (pytest + pytest-asyncio + httpx ASGI transport) with an
  in-memory SQLite override for `get_db`, so tests run without a real
  Postgres instance.
- **All 3 tests pass** (`test_liveness`, `test_readiness`,
  `test_docs_available_in_non_production`).
- Fixed a FastAPI deprecation warning by switching `@app.on_event` to
  the modern `lifespan` context-manager pattern.

**NOT yet done (remaining Phase 1 work):**
- Frontend skeleton (React + TypeScript + Vite, RTL-first, MUI or
  Tailwind+RTL — decision pending, see open items below).
- `docker-compose.yml` for local Postgres (so contributors don't need
  a manually installed DB).
- Root `README.md` with setup instructions.
- `.gitignore` (Python + Node + `.env`).
- Formal Phase 1 QA pass + Supervisor sign-off per the Phase Gate
  Rule (Section 37 of the master spec) — implementation exists and is
  tested, but hasn't been presented for acceptance yet.

**Open items for Phase 1 continuation:**
- Confirm frontend UI library: MUI (native RTL support, faster for an
  admin-heavy app) vs Tailwind + RTL plugin. Architect's earlier
  recommendation was MUI — not yet confirmed by Supervisor.
- Confirm final name for the new `AUDITOR` role (placeholder name,
  not yet finalized).
- Decide whether `docker-compose.yml` should be included in Phase 1
  or deferred to Phase 12 deployment work — recommend including a
  minimal one now since local Postgres is needed for Phase 2 anyway.

## 3. File Inventory (20 files created so far — all under `backend/`)

```
backend/
├── .env.example
├── alembic.ini
├── pytest.ini
├── requirements.txt
├── alembic/
│   ├── env.py
│   └── script.py.mako
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── api/
│   │   ├── __init__.py
│   │   └── health.py
│   ├── core/
│   │   ├── __init__.py
│   │   ├── config.py
│   │   └── logging.py
│   ├── db/
│   │   ├── __init__.py
│   │   ├── base.py
│   │   └── session.py
│   └── models/
│       └── __init__.py      (empty — models start in Phase 2)
└── tests/
    ├── __init__.py
    ├── conftest.py
    └── test_health.py
```

All 20 files are included, exactly as last edited, in the accompanying
`ems-backend-phase1.zip`. Unzip it directly into the new Project's
working directory / repo root — no changes needed, it already passes
`python -m pytest -v` (3 passed).

**Not included (intentionally, regenerate locally, never commit):**
`.env` (real secrets), `__pycache__/`, `.pytest_cache/`.

## 4. Immediate Next Steps for the New Conversation

1. Confirm this handoff was read correctly (ask me to summarize back
   Phase 0 decisions and Phase 1 status before doing anything new).
2. Resolve the three open items above (frontend UI library, AUDITOR
   role name, docker-compose timing).
3. Finish remaining Phase 1 work (frontend skeleton, docker-compose,
   README, .gitignore).
4. Present Phase 1 for formal Supervisor sign-off per the Phase Gate
   Rule before starting Phase 2 (database schema).

---
*End of handoff document.*
