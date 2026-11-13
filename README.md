# EMS-Claude — Equipment Maintenance Reporting System

Equipment/maintenance activity reporting system (not a full CMMS).
**Status:** Phases 0-6 are accepted and merged into `main` (tag `phase6-accepted`); Phase 7
(reports list/detail, editing, priority system) is next.

Project documents (synced here at the end of every phase; the project files remain the source of truth):

- `docs/ems-master-prompt.md` — governing requirements, business rules, quality standards and phase plan.
- `docs/ems-handoff.md` — current progress, accepted decisions, open questions and next steps.

## Repository layout

```
backend/   FastAPI + SQLAlchemy async + Alembic backend
frontend/  React + TypeScript + Vite + MUI (RTL, Persian)
scripts/   Development helper scripts
docs/      Project documents (Master Prompt, Handoff) and technical docs per phase
```

## Backend quickstart

```bash
docker compose up -d                 # local Postgres (repo root)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
alembic upgrade head                 # migrate the dev database
python -m pytest -v
```

### Tests

- `tests/test_*.py` — fast tests on in-memory SQLite (no Postgres needed).
- `tests/postgres/` — schema, migration-chain, and concurrency tests on **real
  PostgreSQL**. Enabled by `TEST_DATABASE_URL` (already in `.env.example`);
  skipped when it is unset. The database (`ems_test`) is created automatically
  and is wiped/re-migrated on every run, so its name must end with `_test`
  (enforced) — your dev database `ems_db` is never touched.

### Frontend (Phase 4b)

See `docs/frontend.md` (`npm install`, `npm run dev`, `npm test`).

### Equipment import (Phase 5)

Excel/CSV import per group with preview, error report and undo: see `docs/equipment-import.md`. Run `alembic upgrade head`
(migration `e5b8a1c3f702`).

### Report creation (Phase 6)

Create reports with server-side drafts, gap-free numbering, per-type labor rules and "general" (equipment-less) reports:
see `docs/report-creation.md` (API) and the "Report entry page" section of `docs/frontend.md`. Run `alembic upgrade head`
(migrations `f6c3d9a7b104`, `a7d4e1b8c215`, `b8e5f2a9c326`, `c9f6a3b0d437`, and `d0b8c4f1a539` for favorite people). Page: `/reports/new`.

### Reports list UI (Phase 7b)

List, detail and equipment history pages; every role lands on `/reports` (dashboard at `/dashboard`): see `docs/frontend.md`.

### Reports list/detail (Phase 7a)

Read side of reports: list with filters and cursor, detail, column registry, equipment history: see `docs/report-views.md`. No migration.

### Personnel phase (in progress)

Sub-phase `Pa` (data foundation: optional login profile, personnel code, mobile): see `docs/personnel.md`. Run
`alembic upgrade head` (migration `e1c7b2d9f640`).

### Management API (Phase 4a)

Users, groups, equipment, report types and settings: see `docs/management-api.md`. Run `alembic upgrade head` after
pulling — migration `c4a9d7e2b610` normalises existing usernames/codes (and stops with a message if two differ only by case).

### Authentication (Phase 3)

See `docs/auth.md`. After `alembic upgrade head`, create the first administrator (no default
accounts or passwords exist):

```bash
python -m app.cli create-user --username admin --full-name "Admin" --role MANAGEMENT
```

### One-command dev startup (WSL)

`bash scripts/dev-start.sh` checks Docker, starts Postgres (waits until
healthy), creates `.venv` / `.env` if missing, applies migrations, and opens
a shell in `backend/` with the venv active. Docker Desktop must be running.
