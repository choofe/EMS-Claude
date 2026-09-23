"""
Health endpoint.

Two levels are exposed deliberately:
- /health/live  : process is up (no DB dependency) — used for basic liveness probes.
- /health/ready : process is up AND can reach the database — used to confirm
                  the deployment is actually usable, which matters on free-tier
                  hosts where the DB can be a separate, sometimes-sleeping service.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_db

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/live")
async def liveness() -> dict:
    settings = get_settings()
    return {"status": "ok", "app": settings.app_name, "environment": settings.environment}


@router.get("/ready")
async def readiness(db: AsyncSession = Depends(get_db)) -> dict:
    await db.execute(text("SELECT 1"))
    return {"status": "ok", "database": "reachable"}
