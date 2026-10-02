#!/usr/bin/env bash
# One-shot dev environment: Postgres up, venv ready, migrations applied,
# then drops you into a shell inside backend/ with the venv active.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running. Start Docker Desktop, wait until it is ready, then run this again." >&2
  exit 1
fi

echo "==> Starting Postgres (waits until healthy)..."
docker compose up -d --wait

cd "$ROOT/backend"
if [ ! -d .venv ]; then
  echo "==> Creating .venv and installing requirements (first run only)..."
  python3 -m venv .venv
  . .venv/bin/activate
  pip install -q -r requirements.txt
fi
[ -f .env ] || { echo "==> No .env found, copying .env.example"; cp .env.example .env; }

. .venv/bin/activate
echo "==> Applying migrations to the dev database..."
alembic upgrade head

echo "==> Ready. Postgres is up, .venv is active, you are in backend/."
exec bash --rcfile <(echo "[ -f ~/.bashrc ] && . ~/.bashrc; . '$ROOT/backend/.venv/bin/activate'; cd '$ROOT/backend'") -i
