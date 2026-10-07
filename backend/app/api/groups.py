"""Groups. Read: GROUPS_VIEW, scoped (everyone sees their own active groups; MANAGEMENT/AUDITOR see all). Write: GROUPS_MANAGE."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import GroupCreate, GroupOut, GroupUpdate, Page
from app.services import group_admin

router = APIRouter(prefix="/groups", tags=["groups"])
_manage = require_capability(C.GROUPS_MANAGE)


@router.get("", response_model=Page[GroupOut])
async def list_groups(
    include_inactive: bool = False, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
    principal: Principal = Depends(require_capability(C.GROUPS_VIEW)), db: AsyncSession = Depends(get_db),
) -> dict:
    items, total = await group_admin.list_groups(db, principal, include_inactive=include_inactive, limit=limit, offset=offset)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("", response_model=GroupOut, status_code=201)
async def create_group(body: GroupCreate, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await group_admin.create_group(db, actor_id=actor.user_id, code=body.code, name=body.name,
                                          description=body.description)


@router.get("/{group_id}", response_model=GroupOut)
async def get_group(group_id: int, principal: Principal = Depends(require_capability(C.GROUPS_VIEW)),
                    db: AsyncSession = Depends(get_db)) -> dict:
    return await group_admin.get_group(db, principal, group_id)


@router.patch("/{group_id}", response_model=GroupOut)
async def update_group(group_id: int, body: GroupUpdate, actor: Principal = Depends(_manage),
                       db: AsyncSession = Depends(get_db)) -> dict:
    fields = {k: getattr(body, k) for k in body.model_fields_set}
    return await group_admin.update_group(db, actor_id=actor.user_id, group_id=group_id, **fields)


@router.post("/{group_id}/deactivate", response_model=GroupOut)
async def deactivate(group_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await group_admin.set_group_active(db, actor_id=actor.user_id, group_id=group_id, active=False)


@router.post("/{group_id}/activate", response_model=GroupOut)
async def activate(group_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await group_admin.set_group_active(db, actor_id=actor.user_id, group_id=group_id, active=True)
