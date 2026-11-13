"""User management. Read: USERS_VIEW (MANAGEMENT, AUDITOR). Everything that writes: USERS_MANAGE (MANAGEMENT)."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import (MAX_OFFSET, CountOut, MobileSet, NoGroupAlertOut, Page, PasswordReset, PersonCreate,
                               PersonnelCodeSet, ProfileCreate, UserCreate, UserGroupsSet, UserOut, UsernameSet,
                               UserUpdate)
from app.services import personnel_admin, user_admin

router = APIRouter(prefix="/users", tags=["users"])
_view = Depends(require_capability(C.USERS_VIEW))
_manage = require_capability(C.USERS_MANAGE)


@router.get("", response_model=Page[UserOut])
async def list_users(
    q: str | None = Query(None, max_length=64), role_code: str | None = Query(None, max_length=32),
    is_active: bool | None = None, group_id: int | None = None,
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=MAX_OFFSET),
    viewer: Principal = _view, db: AsyncSession = Depends(get_db),
) -> dict:
    items, total = await user_admin.list_users(db, q=q, role_code=role_code, is_active=is_active,
                                               group_id=group_id, limit=limit, offset=offset,
                                               include_mobile=user_admin.can_see_mobile(viewer))
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/force-password-change-all", response_model=CountOut)
async def force_change_all(actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return {"users_affected": await user_admin.force_password_change_all(db, actor_id=actor.user_id)}


@router.get("/no-group-alert", response_model=NoGroupAlertOut)
async def no_group_alert(actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_admin.no_group_alert(db, actor=actor)


@router.post("/no-group-alert/dismiss", response_model=NoGroupAlertOut)
async def dismiss_no_group_alert(actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_admin.dismiss_no_group_alert(db, actor=actor)


@router.post("/people", response_model=UserOut, status_code=201)
async def create_person(body: PersonCreate, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_admin.create_person(
        db, actor=actor, first_name=body.first_name, last_name=body.last_name, personnel_code=body.personnel_code,
        mobile=body.mobile, group_ids=body.group_ids, profile=body.profile.model_dump() if body.profile else None)


@router.post("", response_model=UserOut, status_code=201)
async def create_user(body: UserCreate, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    user = await user_admin.create_user(
        db, username=body.username, full_name=body.full_name, role_code=body.role_code, password=body.password,
        actor_id=actor.user_id, group_ids=body.group_ids, must_change_password=body.must_change_password,
    )
    return await user_admin.get_user_view(db, user.id, user_admin.can_see_mobile(actor))


@router.get("/{user_id}", response_model=UserOut)
async def get_user(user_id: int, viewer: Principal = _view, db: AsyncSession = Depends(get_db)) -> dict:
    return await user_admin.get_user_view(db, user_id, user_admin.can_see_mobile(viewer))


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(user_id: int, body: UserUpdate, actor: Principal = Depends(_manage),
                      db: AsyncSession = Depends(get_db)) -> dict:
    return await user_admin.update_user(db, actor=actor, user_id=user_id, full_name=body.full_name, role_code=body.role_code,
                                      first_name=body.first_name, last_name=body.last_name)


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


@router.post("/{user_id}/profile", response_model=UserOut, status_code=201)
async def create_profile(user_id: int, body: ProfileCreate, actor: Principal = Depends(_manage),
                         db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_admin.create_profile(db, actor=actor, user_id=user_id, **body.model_dump())


@router.put("/{user_id}/personnel-code", response_model=UserOut)
async def set_personnel_code(user_id: int, body: PersonnelCodeSet, actor: Principal = Depends(_manage),
                             db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_admin.set_personnel_code(db, actor=actor, user_id=user_id, personnel_code=body.personnel_code,
                                                    reason=body.reason, note=body.note)


@router.put("/{user_id}/mobile", response_model=UserOut)
async def set_mobile(user_id: int, body: MobileSet, actor: Principal = Depends(_manage),
                     db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_admin.set_mobile(db, actor=actor, user_id=user_id, mobile=body.mobile)


@router.put("/{user_id}/username", response_model=UserOut)
async def set_username(user_id: int, body: UsernameSet, actor: Principal = Depends(_manage),
                       db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_admin.set_username(db, actor=actor, user_id=user_id, username=body.username,
                                              reason=body.reason, note=body.note)


@router.post("/{user_id}/login/disable", response_model=UserOut)
async def disable_login(user_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_admin.set_login_enabled(db, actor=actor, user_id=user_id, enabled=False)


@router.post("/{user_id}/login/enable", response_model=UserOut)
async def enable_login(user_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_admin.set_login_enabled(db, actor=actor, user_id=user_id, enabled=True)
