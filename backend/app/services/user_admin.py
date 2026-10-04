"""
Account administration primitives used by the CLI now and by the Phase 4
management API later (so password rules / audit live in exactly one place).
Each function commits and writes its own audit row.
"""
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.password_policy import validate_password
from app.core.security import ahash_password, utcnow
from app.models.refresh_token import RefreshToken
from app.models.role import Role
from app.models.user import User
from app.services.audit import add_audit
from app.services.auth_service import PasswordPolicyError, revoke_all_user_tokens
from app.services.runtime_settings import get_auth_policy


async def create_user(
    db: AsyncSession,
    *,
    username: str,
    full_name: str,
    role_code: str,
    password: str,
    actor_id: int | None = None,
) -> User:
    username = username.strip()
    if not username or len(username) > 64:
        raise ValueError("username must be 1-64 characters")
    role = (await db.execute(select(Role).where(Role.code == role_code))).scalar_one_or_none()
    if role is None:
        raise ValueError(f"unknown role {role_code!r}")
    policy = await get_auth_policy(db)
    errors = validate_password(password, username=username, min_length=policy.password_min_length)
    if errors:
        raise PasswordPolicyError(errors)

    user = User(
        username=username,
        full_name=full_name.strip(),
        role_id=role.id,
        hashed_password=await ahash_password(password),
    )
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise ValueError(f"username {username!r} already exists")
    add_audit(db, actor_id=actor_id, action="user.create", entity_type="user", entity_id=user.id,
              metadata={"username": username, "role": role_code})
    await db.commit()
    return user


async def reset_password(
    db: AsyncSession, *, username: str, password: str, force_change: bool = True,
    actor_id: int | None = None,
) -> None:
    user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if user is None:
        raise ValueError(f"no such user {username!r}")
    policy = await get_auth_policy(db)
    errors = validate_password(password, username=user.username, min_length=policy.password_min_length)
    if errors:
        raise PasswordPolicyError(errors)
    user.hashed_password = await ahash_password(password)
    user.must_change_password = force_change
    await revoke_all_user_tokens(db, user.id)
    add_audit(db, actor_id=actor_id, action="user.password_reset", entity_type="user",
              entity_id=user.id, metadata={"force_change": force_change})
    await db.commit()


async def force_password_change_all(db: AsyncSession, *, actor_id: int | None = None) -> int:
    """Every ACTIVE user (whatever their current password looks like) must set a new
    password at next login, and every existing session is ended. Returns the user count."""
    result = await db.execute(
        update(User).where(User.is_active.is_(True)).values(must_change_password=True)
    )
    await db.execute(
        update(RefreshToken).where(RefreshToken.revoked_at.is_(None)).values(revoked_at=utcnow())
    )
    count = result.rowcount or 0
    add_audit(db, actor_id=actor_id, action="auth.force_password_change_all", entity_type="system",
              entity_id=None, metadata={"users_affected": count})
    await db.commit()
    return count
