#!/bin/bash
set -e

echo "Running database migrations..."
cd /app/backend
alembic upgrade head

echo "Starting Nginx and FastAPI..."
nginx -g 'daemon off;' &
exec uvicorn app.main:app --host 0.0.0.0 --port 8000