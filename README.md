# EMS-Claude — Equipment Maintenance Reporting System

Equipment/maintenance activity reporting system (not a full CMMS).
See `docs/ems-handoff.md` for full project history: Phase 0 decisions,
Phase 1 status, and next steps.

## Repository layout

```
backend/   FastAPI + SQLAlchemy async + Alembic backend (Phase 1 skeleton)
docs/      Project handoff / decision log
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
