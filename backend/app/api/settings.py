"""Runtime settings (registered keys only). MANAGEMENT only — AUDITOR has no settings access."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import SettingOut, SettingUpdate
from app.services import settings_admin

router = APIRouter(prefix="/settings", tags=["settings"])
_manage = require_capability(C.SETTINGS_MANAGE)


@router.get("", response_model=list[SettingOut])
async def list_settings(_: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> list[dict]:
    return await settings_admin.list_settings(db)


@router.put("/{key}", response_model=SettingOut)
async def update_setting(key: str, body: SettingUpdate, actor: Principal = Depends(_manage),
                         db: AsyncSession = Depends(get_db)) -> dict:
    return await settings_admin.update_setting(db, actor_id=actor.user_id, key=key, value=body.value)
