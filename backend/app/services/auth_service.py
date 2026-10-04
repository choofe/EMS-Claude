"""
Authentication logic: login with lockout, session issuing, refresh-token
rotation with replay detection, password change.

Transaction convention: functions here COMMIT themselves where an outcome
must survive an exception raised right after (failed-login records, replay
revocations). Errors are domain exceptions; the API layer maps them to HTTP.
"""
import math
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.password_policy import validate_password
from app.core.permissions import Principal
from app.core.security import (
    ahash_password,
    as_utc,
    averify_dummy,
    averify_password,
    create_access_token,
    hash_refresh_token,
    new_family_id,
    new_refresh_token,
    password_needs_rehash,
    utcnow,
)
from app.models.login_attempt import LoginAttempt
from app.models.refresh_token import RefreshToken
from app.models.role import Role
from app.models.user import User
from app.models.user_group import UserGroup
from app.services.audit import add_audit
from app.services.runtime_settings import AuthPolicy, get_auth_policy


class AuthError(Exception):
    """Base for all expected authentication failures."""


class InvalidCredentials(AuthError):
    pass


class TooManyAttempts(AuthError):
    def __init__(self, retry_after: int):
        super().__init__("too_many_attempts")
        self.retry_after = retry_after


class InvalidRefreshToken(AuthError):
    pass


class PasswordPolicyError(AuthError):
    def __init__(self, errors: list[str]):
        super().__init__("password_policy")
        self.errors = errors


@dataclass(frozen=True)
class Session:
    access_token: str
    expires_in: int
    refresh_token: str
    refresh_expires_at: datetime


# --- principal loading ---------------------------------------------------

async def load_principal(db: AsyncSession, user_id: int) -> Principal | None:
    """Fresh from the DB every time. None if the user is missing or inactive.
    Group memberships are loaded regardless of groups.is_active so that history
    of a deactivated group stays visible to its members (spec section 26)."""
    row = (
        await db.execute(
            select(User, Role)
            .join(Role, Role.id == User.role_id)
            .where(User.id == user_id, User.is_active.is_(True))
        )
    ).first()
    if row is None:
        return None
    user, role = row
    group_ids = (
        await db.execute(select(UserGroup.group_id).where(UserGroup.user_id == user_id))
    ).scalars().all()
    return Principal(
        user_id=user.id,
        username=user.username,
        full_name=user.full_name,
        role_code=role.code,
        role_label_fa=role.label_fa,
        group_ids=frozenset(group_ids),
        must_change_password=user.must_change_password,
    )


# --- lockout -------------------------------------------------------------

async def _acquire_attempt_lock(db: AsyncSession, username: str) -> None:
    """Serialise login attempts per username so the lockout count cannot be raced.

    Without this, N parallel requests all read "fewer than max failures" before any
    of them commits its own failure, and all N reach password verification. On
    PostgreSQL we take a transaction-scoped advisory lock keyed by the username; it is
    released by the commit in _record_attempt (or the rollback when the request ends).
    try-lock: if another attempt for the SAME username is in flight we answer 429
    immediately instead of queueing, so a flood against one name cannot pin the whole
    DB connection pool. Identical for real and non-existent usernames.
    SQLite (dev/tests, single process) has no advisory locks and needs none."""
    if db.get_bind().dialect.name != "postgresql":
        return
    got = (
        await db.execute(
            text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"ems:login:{username}"},
        )
    ).scalar_one()
    if not got:
        raise TooManyAttempts(retry_after=1)


async def _check_lockout(
    db: AsyncSession, username: str, ip: str | None, policy: AuthPolicy, now: datetime
) -> None:
    window = timedelta(minutes=policy.login_lockout_minutes)
    cutoff = now - window

    last_success = (
        await db.execute(
            select(func.max(LoginAttempt.attempted_at)).where(
                LoginAttempt.username == username,
                LoginAttempt.success.is_(True),
                LoginAttempt.attempted_at > cutoff,
            )
        )
    ).scalar_one()
    counted_from = max(cutoff, as_utc(last_success)) if last_success else cutoff

    failures = [
        as_utc(t)
        for t in (
            await db.execute(
                select(LoginAttempt.attempted_at)
                .where(
                    LoginAttempt.username == username,
                    LoginAttempt.success.is_(False),
                    LoginAttempt.attempted_at > counted_from,
                )
                .order_by(LoginAttempt.attempted_at)
            )
        ).scalars()
    ]
    if len(failures) >= policy.login_max_attempts:
        # Lock lifts when enough old failures age out of the window.
        unlock_at = failures[len(failures) - policy.login_max_attempts] + window
        raise TooManyAttempts(max(1, math.ceil((unlock_at - now).total_seconds())))

    if ip and policy.login_max_attempts_per_ip > 0:
        ip_failures = (
            await db.execute(
                select(func.count())
                .select_from(LoginAttempt)
                .where(
                    LoginAttempt.ip == ip,
                    LoginAttempt.success.is_(False),
                    LoginAttempt.attempted_at > cutoff,
                )
            )
        ).scalar_one()
        if ip_failures >= policy.login_max_attempts_per_ip:
            raise TooManyAttempts(int(window.total_seconds()))


async def _record_attempt(
    db: AsyncSession, username: str, ip: str | None, success: bool, now: datetime
) -> None:
    db.add(LoginAttempt(username=username, ip=ip, success=success, attempted_at=now))
    await db.commit()


# --- sessions ------------------------------------------------------------

async def _issue_session(
    db: AsyncSession, user_id: int, family_id: str | None = None, now: datetime | None = None
) -> Session:
    """Adds a new refresh-token row (caller commits)."""
    settings = get_settings()
    now = now or utcnow()
    access, expires_in = create_access_token(user_id, now)
    raw = new_refresh_token()
    expires_at = now + timedelta(days=settings.refresh_token_expire_days)
    db.add(
        RefreshToken(
            user_id=user_id,
            family_id=family_id or new_family_id(),
            token_hash=hash_refresh_token(raw),
            expires_at=expires_at,
        )
    )
    return Session(access, expires_in, raw, expires_at)


async def revoke_all_user_tokens(db: AsyncSession, user_id: int, now: datetime | None = None) -> None:
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now or utcnow())
    )


async def _revoke_family(db: AsyncSession, family_id: str, now: datetime) -> None:
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )


# --- login ---------------------------------------------------------------

async def login(
    db: AsyncSession, username: str, password: str, ip: str | None
) -> tuple[Principal, Session]:
    username = username.strip()[:64]
    now = utcnow()
    policy = await get_auth_policy(db)

    await _acquire_attempt_lock(db, username)
    await _check_lockout(db, username, ip, policy, now)

    user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if user is None:
        await averify_dummy(password)  # same cost as a real check -> no timing oracle
        ok = False
    else:
        ok = await averify_password(user.hashed_password, password) and user.is_active

    await _record_attempt(db, username, ip, ok, now)
    if not ok:
        raise InvalidCredentials()

    assert user is not None
    if password_needs_rehash(user.hashed_password):
        user.hashed_password = await ahash_password(password)

    forced = False
    if not user.must_change_password and validate_password(
        password, username=user.username, min_length=policy.password_min_length
    ):
        # Password no longer satisfies the CURRENT policy (e.g. minimum was raised).
        user.must_change_password = True
        forced = True

    session = await _issue_session(db, user.id, now=now)
    add_audit(db, actor_id=user.id, action="auth.login", entity_type="user", entity_id=user.id,
              metadata={"ip": ip})
    if forced:
        add_audit(db, actor_id=None, action="auth.password_change_required", entity_type="user",
                  entity_id=user.id, metadata={"reason": "password_below_current_policy"})
    await db.commit()

    principal = await load_principal(db, user.id)
    assert principal is not None
    return principal, session


# --- refresh / logout ----------------------------------------------------

async def rotate_refresh_token(db: AsyncSession, raw: str | None) -> tuple[Principal, Session]:
    if not raw:
        raise InvalidRefreshToken()
    now = utcnow()
    # FOR UPDATE serialises concurrent use of the same token on PostgreSQL: the
    # second caller waits, then sees used_at set and is treated as a replay.
    token = (
        await db.execute(
            select(RefreshToken)
            .where(RefreshToken.token_hash == hash_refresh_token(raw))
            .with_for_update()
        )
    ).scalar_one_or_none()
    if token is None:
        raise InvalidRefreshToken()

    if token.revoked_at is not None:
        await db.rollback()
        raise InvalidRefreshToken()

    if token.used_at is not None:
        # A rotated-away token came back: assume it was stolen. Kill the family.
        await _revoke_family(db, token.family_id, now)
        add_audit(db, actor_id=None, action="auth.refresh_reuse_detected", entity_type="user",
                  entity_id=token.user_id, metadata={"family_id": token.family_id})
        await db.commit()
        raise InvalidRefreshToken()

    if as_utc(token.expires_at) <= now:
        await db.rollback()
        raise InvalidRefreshToken()

    principal = await load_principal(db, token.user_id)
    if principal is None:  # user deactivated since
        await _revoke_family(db, token.family_id, now)
        await db.commit()
        raise InvalidRefreshToken()

    if principal.must_change_password:
        # While a password change is pending the account may only change its password or log
        # out; it must not keep a session alive by refreshing. Nothing is consumed or revoked:
        # the user simply logs in again (login is allowed) and changes the password.
        await db.rollback()
        raise InvalidRefreshToken()

    token.used_at = now
    session = await _issue_session(db, token.user_id, family_id=token.family_id, now=now)
    await db.commit()
    return principal, session


async def logout(db: AsyncSession, raw: str | None) -> None:
    if not raw:
        return
    token = (
        await db.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw)))
    ).scalar_one_or_none()
    if token is not None:
        await _revoke_family(db, token.family_id, utcnow())
        await db.commit()


# --- password change -----------------------------------------------------

async def change_password(
    db: AsyncSession, principal: Principal, current_password: str, new_password: str, ip: str | None
) -> tuple[Principal, Session]:
    now = utcnow()
    policy = await get_auth_policy(db)
    # Same lockout as login: a stolen access token must not become a free
    # oracle for guessing the current password.
    await _acquire_attempt_lock(db, principal.username)
    await _check_lockout(db, principal.username, ip, policy, now)

    # Row lock + active re-check inside this transaction: an account deactivated after the
    # request authenticated must not get a password change or a fresh session.
    user = (
        await db.execute(select(User).where(User.id == principal.user_id).with_for_update())
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        await db.rollback()
        raise InvalidCredentials()
    ok = await averify_password(user.hashed_password, current_password)
    await _record_attempt(db, principal.username, ip, ok, now)
    if not ok:
        raise InvalidCredentials()

    errors = validate_password(new_password, username=user.username, min_length=policy.password_min_length)
    if new_password == current_password:
        errors.append("same_as_current")
    if errors:
        raise PasswordPolicyError(errors)

    user.hashed_password = await ahash_password(new_password)
    user.must_change_password = False
    await revoke_all_user_tokens(db, user.id, now)  # every other session is logged out
    session = await _issue_session(db, user.id, now=now)
    add_audit(db, actor_id=user.id, action="auth.password_change", entity_type="user", entity_id=user.id)
    await db.commit()

    fresh = await load_principal(db, user.id)
    if fresh is None:  # cannot happen: row was locked and active; fail safe rather than assert
        raise InvalidCredentials()
    return fresh, session
