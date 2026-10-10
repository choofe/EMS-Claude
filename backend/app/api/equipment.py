"""Equipment. Read: EQUIPMENT_VIEW, scoped (own groups' ACTIVE equipment; MANAGEMENT/AUDITOR see everything).
Write: EQUIPMENT_MANAGE. Bulk Excel import is Phase 5; the report-entry quick-pick is Phase 6."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import MAX_OFFSET, EquipmentCreate, EquipmentMove, EquipmentOut, EquipmentUpdate, Page
from app.services import equipment_admin

router = APIRouter(prefix="/equipment", tags=["equipment"])
_manage = require_capability(C.EQUIPMENT_MANAGE)
_view = require_capability(C.EQUIPMENT_VIEW)


@router.get("", response_model=Page[EquipmentOut])
async def list_equipment(
    q: str | None = Query(None, max_length=64), group_id: int | None = None, is_active: bool | None = None,
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=MAX_OFFSET),
    principal: Principal = Depends(_view), db: AsyncSession = Depends(get_db),
) -> dict:
    items, total = await equipment_admin.list_equipment(db, principal, q=q, group_id=group_id, is_active=is_active,
                                                        limit=limit, offset=offset)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("", response_model=EquipmentOut, status_code=201)
async def create_equipment(body: EquipmentCreate, actor: Principal = Depends(_manage),
                           db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_admin.create_equipment(db, actor_id=actor.user_id, equipment_code=body.equipment_code,
                                                  group_id=body.group_id, description=body.description)


@router.get("/{equipment_id}", response_model=EquipmentOut)
async def get_equipment(equipment_id: int, principal: Principal = Depends(_view), db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_admin.get_equipment(db, principal, equipment_id)


@router.patch("/{equipment_id}", response_model=EquipmentOut)
async def update_equipment(equipment_id: int, body: EquipmentUpdate, actor: Principal = Depends(_manage),
                           db: AsyncSession = Depends(get_db)) -> dict:
    fields = {k: getattr(body, k) for k in body.model_fields_set}
    return await equipment_admin.update_equipment(db, actor_id=actor.user_id, equipment_id=equipment_id, **fields)


@router.post("/{equipment_id}/move", response_model=EquipmentOut)
async def move_equipment(equipment_id: int, body: EquipmentMove, actor: Principal = Depends(_manage),
                         db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_admin.move_equipment(db, actor_id=actor.user_id, equipment_id=equipment_id, group_id=body.group_id)


@router.post("/{equipment_id}/deactivate", response_model=EquipmentOut)
async def deactivate(equipment_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_admin.set_equipment_active(db, actor_id=actor.user_id, equipment_id=equipment_id, active=False)


@router.post("/{equipment_id}/activate", response_model=EquipmentOut)
async def activate(equipment_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_admin.set_equipment_active(db, actor_id=actor.user_id, equipment_id=equipment_id, active=True)
