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
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m pytest -v
```

Phase 1 status: skeleton implemented, 3/3 tests passing, not yet
formally signed off (frontend skeleton, docker-compose, and this
README are the remaining Phase 1 items — see the handoff doc).
