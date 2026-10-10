"""Management dashboard numbers and the role lookup used by the user forms. USERS_VIEW (MANAGEMENT, AUDITOR)."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import DashboardOut, RoleOut
from app.services import dashboard

router = APIRouter(tags=["dashboard"])
_view = require_capability(C.USERS_VIEW)


@router.get("/dashboard/summary", response_model=DashboardOut)
async def dashboard_summary(_: Principal = Depends(_view), db: AsyncSession = Depends(get_db)) -> dict:
    return await dashboard.summary(db)


@router.get("/roles", response_model=list[RoleOut])
async def roles(_: Principal = Depends(_view), db: AsyncSession = Depends(get_db)) -> list[dict]:
    return await dashboard.list_roles(db)
