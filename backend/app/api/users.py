"""User management. Read: USERS_VIEW (MANAGEMENT, AUDITOR). Everything that writes: USERS_MANAGE (MANAGEMENT)."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import MAX_OFFSET, CountOut, Page, PasswordReset, UserCreate, UserGroupsSet, UserOut, UserUpdate
from app.services import user_admin

router = APIRouter(prefix="/users", tags=["users"])
_view = Depends(require_capability(C.USERS_VIEW))
_manage = require_capability(C.USERS_MANAGE)


@router.get("", response_model=Page[UserOut])
async def list_users(
    q: str | None = Query(None, max_length=64), role_code: str | None = Query(None, max_length=32),
    is_active: bool | None = None, group_id: int | None = None,
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=MAX_OFFSET),
    _: Principal = _view, db: AsyncSession = Depends(get_db),
) -> dict:
    items, total = await user_admin.list_users(db, q=q, role_code=role_code, is_active=is_active,
                                               group_id=group_id, limit=limit, offset=offset)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/force-password-change-all", response_model=CountOut)
async def force_change_all(actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return {"users_affected": await user_admin.force_password_change_all(db, actor_id=actor.user_id)}


@router.post("", response_model=UserOut, status_code=201)
async def create_user(body: UserCreate, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    user = await user_admin.create_user(
        db, username=body.username, full_name=body.full_name, role_code=body.role_code, password=body.password,
        actor_id=actor.user_id, group_ids=body.group_ids, must_change_password=body.must_change_password,
    )
    return await user_admin.get_user_view(db, user.id)


@router.get("/{user_id}", response_model=UserOut)
async def get_user(user_id: int, _: Principal = _view, db: AsyncSession = Depends(get_db)) -> dict:
    return await user_admin.get_user_view(db, user_id)


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(user_id: int, body: UserUpdate, actor: Principal = Depends(_manage),
                      db: AsyncSession = Depends(get_db)) -> dict:
    return await user_admin.update_user(db, actor=actor, user_id=user_id, full_name=body.full_name, role_code=body.role_code)


@router.post("/{user_id}/deactivate", response_model=UserOut)
async def deactivate(user_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await user_admin.set_active(db, actor=actor, user_id=user_id, active=False)


@router.post("/{user_id}/activate", response_model=UserOut)
async def activate(user_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await user_admin.set_active(db, actor=actor, user_id=user_id, active=True)


@router.put("/{user_id}/groups", response_model=UserOut)
async def set_groups(user_id: int, body: UserGroupsSet, actor: Principal = Depends(_manage),
                     db: AsyncSession = Depends(get_db)) -> dict:
    return await user_admin.set_groups(db, actor=actor, user_id=user_id, group_ids=body.group_ids)


@router.post("/{user_id}/reset-password", response_model=UserOut)
async def reset_password(user_id: int, body: PasswordReset, actor: Principal = Depends(_manage),
                         db: AsyncSession = Depends(get_db)) -> dict:
    return await user_admin.reset_password_for(db, actor=actor, user_id=user_id, password=body.password,
                                               force_change=body.must_change_password)


@router.post("/{user_id}/force-password-change", response_model=UserOut)
async def force_change(user_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await user_admin.force_password_change_user(db, actor=actor, user_id=user_id)
