"""
User administration (used by the Phase 4 API and the operator CLI, so password rules, guards and audit
live in exactly one place). Every function commits and writes its own audit row; failures raise DomainError
(or PasswordPolicyError). Passwords never reach audit metadata.

Guards: a MANAGEMENT user cannot deactivate or change the role of THEMSELVES; and whatever happens
concurrently, at least one active MANAGEMENT must remain (rows are locked, the count re-checked before commit).
"""
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.normalize import canonical_username, clean_text
from app.core.password_policy import validate_password
from app.core.permissions import Principal
from app.core.security import ahash_password, utcnow
from app.models.group import Group
from app.models.refresh_token import RefreshToken
from app.models.role import Role
from app.models.user import User
from app.models.user_group import UserGroup
from app.services.audit import add_audit
from app.services.auth_service import PasswordPolicyError, revoke_all_user_tokens
from app.services.queries import LIKE_ESCAPE, contains_pattern
from app.services.runtime_settings import get_auth_policy

MANAGEMENT = "MANAGEMENT"


# ---------------------------------------------------------------- lookups / views

async def _role(db: AsyncSession, code: str) -> Role:
    role = (await db.execute(select(Role).where(Role.code == code))).scalar_one_or_none()
    if role is None:
        raise DomainError("unknown_role", 422, role_code=code)
    return role


async def _user(db: AsyncSession, user_id: int, *, lock: bool = False) -> User:
    stmt = select(User).where(User.id == user_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    user = (await db.execute(stmt)).scalar_one_or_none()
    if user is None:
        raise DomainError("user_not_found", 404)
    return user


def _view(user: User, role: Role, group_ids: list[int]) -> dict:
    return {
        "id": user.id, "username": user.username, "full_name": user.full_name,
        "role_code": role.code, "role_label_fa": role.label_fa,
        "is_active": user.is_active, "must_change_password": user.must_change_password,
        "group_ids": sorted(group_ids), "created_at": user.created_at, "updated_at": user.updated_at,
    }


async def _views(db: AsyncSession, rows: list[tuple[User, Role]]) -> list[dict]:
    ids = [u.id for u, _ in rows]
    groups: dict[int, list[int]] = {i: [] for i in ids}
    if ids:
        for uid, gid in (await db.execute(select(UserGroup.user_id, UserGroup.group_id).where(UserGroup.user_id.in_(ids)))).all():
            groups[uid].append(gid)
    return [_view(u, r, groups[u.id]) for u, r in rows]


async def get_user_view(db: AsyncSession, user_id: int) -> dict:
    row = (await db.execute(select(User, Role).join(Role, Role.id == User.role_id).where(User.id == user_id))).first()
    if row is None:
        raise DomainError("user_not_found", 404)
    return (await _views(db, [row]))[0]


async def list_users(
    db: AsyncSession, *, q: str | None, role_code: str | None, is_active: bool | None,
    group_id: int | None, limit: int, offset: int,
) -> tuple[list[dict], int]:
    conds = []
    if q and q.strip():
        pat = contains_pattern(q)
        conds.append(or_(User.username.ilike(pat, escape=LIKE_ESCAPE), User.full_name.ilike(pat, escape=LIKE_ESCAPE)))
    if role_code:
        conds.append(Role.code == role_code)
    if is_active is not None:
        conds.append(User.is_active.is_(is_active))
    if group_id is not None:
        conds.append(User.id.in_(select(UserGroup.user_id).where(UserGroup.group_id == group_id)))
    base = select(User, Role).join(Role, Role.id == User.role_id).where(*conds)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    rows = (await db.execute(base.order_by(User.username).limit(limit).offset(offset))).all()
    return await _views(db, [(u, r) for u, r in rows]), total


# ---------------------------------------------------------------- guards

async def _lock_management(db: AsyncSession) -> None:
    """Serialise every operation that could reduce the number of active MANAGEMENT users."""
    await db.execute(
        select(User.id).join(Role, Role.id == User.role_id)
        .where(Role.code == MANAGEMENT, User.is_active.is_(True)).with_for_update()
    )


async def _assert_management_remains(db: AsyncSession) -> None:
    await db.flush()
    n = (await db.execute(
        select(func.count()).select_from(User).join(Role, Role.id == User.role_id)
        .where(Role.code == MANAGEMENT, User.is_active.is_(True))
    )).scalar_one()
    if n == 0:
        await db.rollback()
        raise DomainError("last_management", 409)


async def _check_groups_assignable(db: AsyncSession, group_ids: set[int]) -> None:
    if not group_ids:
        return
    found = {g.id: g for g in (await db.execute(select(Group).where(Group.id.in_(group_ids)))).scalars()}
    for gid in sorted(group_ids):
        if gid not in found:
            raise DomainError("group_not_found", 404, group_id=gid)
        if not found[gid].is_active:
            raise DomainError("group_inactive", 409, group_id=gid)


async def _validated_password(db: AsyncSession, password: str, username: str) -> str:
    policy = await get_auth_policy(db)
    errors = validate_password(password, username=username, min_length=policy.password_min_length)
    if errors:
        raise PasswordPolicyError(errors)
    return await ahash_password(password)


# ---------------------------------------------------------------- create / update

async def create_user(
    db: AsyncSession, *, username: str, full_name: str, role_code: str, password: str,
    must_change_password: bool, actor_id: int | None = None, group_ids: tuple[int, ...] | list[int] = (),
) -> User:
    """`must_change_password` is REQUIRED (no default) so every caller states it: the admin API passes True for
    admin-chosen temporary passwords; the CLI passes False for the first administrator, who types their own password."""
    username = canonical_username(username)
    full_name = clean_text(full_name, max_length=128, code="invalid_full_name")
    role = await _role(db, role_code)
    wanted = set(group_ids)
    await _check_groups_assignable(db, wanted)
    if (await db.execute(select(User.id).where(User.username == username))).first():
        raise DomainError("username_taken", 409)
    hashed = await _validated_password(db, password, username)

    user = User(username=username, full_name=full_name, role_id=role.id, hashed_password=hashed,
                must_change_password=must_change_password)
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise DomainError("username_taken", 409)
    for gid in sorted(wanted):
        db.add(UserGroup(user_id=user.id, group_id=gid))
    add_audit(db, actor_id=actor_id, action="user.create", entity_type="user", entity_id=user.id,
              metadata={"username": username, "role": role_code, "group_ids": sorted(wanted),
                        "must_change_password": must_change_password})
    await db.commit()
    return user


async def update_user(
    db: AsyncSession, *, actor: Principal, user_id: int, full_name: str | None = None, role_code: str | None = None,
) -> dict:
    new_name = clean_text(full_name, max_length=128, code="invalid_full_name") if full_name is not None else None
    new_role = await _role(db, role_code) if role_code is not None else None
    if new_role is not None:
        if user_id == actor.user_id:
            raise DomainError("cannot_change_own_role", 409)
        await _lock_management(db)  # before reading the target, so concurrent demotions serialise
    user = await _user(db, user_id, lock=True)
    old_role = (await db.get(Role, user.role_id)).code

    if new_name is not None and new_name != user.full_name:
        add_audit(db, actor_id=actor.user_id, action="user.update", entity_type="user", entity_id=user.id,
                  metadata={"changes": {"full_name": [user.full_name, new_name]}})
        user.full_name = new_name
    if new_role is not None and new_role.id != user.role_id:
        user.role_id = new_role.id
        add_audit(db, actor_id=actor.user_id, action="user.role_change", entity_type="user", entity_id=user.id,
                  metadata={"from": old_role, "to": new_role.code})
        if old_role == MANAGEMENT:
            await _assert_management_remains(db)
    await db.commit()
    return await get_user_view(db, user_id)


async def set_active(db: AsyncSession, *, actor: Principal, user_id: int, active: bool) -> dict:
    if not active:
        if user_id == actor.user_id:
            raise DomainError("cannot_deactivate_self", 409)
        await _lock_management(db)
    user = await _user(db, user_id, lock=True)
    if user.is_active != active:
        user.is_active = active
        if not active:
            await revoke_all_user_tokens(db, user.id)  # access tokens die at once too: principal is re-read per request
            await _assert_management_remains(db)
        add_audit(db, actor_id=actor.user_id, action="user.activate" if active else "user.deactivate",
                  entity_type="user", entity_id=user.id)
    await db.commit()
    return await get_user_view(db, user_id)


async def set_groups(db: AsyncSession, *, actor: Principal, user_id: int, group_ids: list[int]) -> dict:
    user = await _user(db, user_id, lock=True)
    wanted = set(group_ids)
    current = set((await db.execute(select(UserGroup.group_id).where(UserGroup.user_id == user.id))).scalars())
    to_add, to_remove = wanted - current, current - wanted
    await _check_groups_assignable(db, to_add)  # only NEW memberships must be to active groups
    if to_remove:
        await db.execute(delete(UserGroup).where(UserGroup.user_id == user.id, UserGroup.group_id.in_(to_remove)))
    for gid in sorted(to_add):
        db.add(UserGroup(user_id=user.id, group_id=gid))
    if to_add or to_remove:
        add_audit(db, actor_id=actor.user_id, action="user.groups_change", entity_type="user", entity_id=user.id,
                  metadata={"added": sorted(to_add), "removed": sorted(to_remove)})
    await db.commit()
    return await get_user_view(db, user_id)


# ---------------------------------------------------------------- passwords / sessions

async def _apply_password_reset(
    db: AsyncSession, user: User, password: str, force_change: bool, actor_id: int | None,
) -> None:
    user.hashed_password = await _validated_password(db, password, user.username)
    user.must_change_password = force_change
    await revoke_all_user_tokens(db, user.id)
    add_audit(db, actor_id=actor_id, action="user.password_reset", entity_type="user", entity_id=user.id,
              metadata={"force_change": force_change})
    await db.commit()


async def reset_password(
    db: AsyncSession, *, username: str, password: str, force_change: bool = True, actor_id: int | None = None,
) -> None:
    """By username — used by the CLI."""
    user = (await db.execute(select(User).where(User.username == username.strip().lower()))).scalar_one_or_none()
    if user is None:
        raise DomainError("user_not_found", 404)
    await _apply_password_reset(db, user, password, force_change, actor_id)


async def reset_password_for(
    db: AsyncSession, *, actor: Principal, user_id: int, password: str, force_change: bool = True,
) -> dict:
    if user_id == actor.user_id:
        raise DomainError("use_change_password_endpoint", 409)  # own password: needs the current password
    user = await _user(db, user_id, lock=True)
    await _apply_password_reset(db, user, password, force_change, actor.user_id)
    return await get_user_view(db, user_id)


async def force_password_change_user(db: AsyncSession, *, actor: Principal, user_id: int) -> dict:
    user = await _user(db, user_id, lock=True)
    user.must_change_password = True
    await revoke_all_user_tokens(db, user.id)
    add_audit(db, actor_id=actor.user_id, action="user.force_password_change", entity_type="user", entity_id=user.id)
    await db.commit()
    return await get_user_view(db, user_id)


async def force_password_change_all(db: AsyncSession, *, actor_id: int | None = None) -> int:
    """Every ACTIVE user (whatever their current password looks like) must set a new password at next
    login, and every existing session is ended. Returns the user count."""
    result = await db.execute(update(User).where(User.is_active.is_(True)).values(must_change_password=True))
    await db.execute(update(RefreshToken).where(RefreshToken.revoked_at.is_(None)).values(revoked_at=utcnow()))
    count = result.rowcount or 0
    add_audit(db, actor_id=actor_id, action="auth.force_password_change_all", entity_type="system",
              entity_id=None, metadata={"users_affected": count})
    await db.commit()
    return count
