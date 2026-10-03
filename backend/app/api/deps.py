"""
Authentication / authorization dependencies.

get_current_principal is the normal gate: valid access token + active user +
password-change not pending. Principal (role, groups, flags) is rebuilt from
the database on every request — nothing authorization-related is trusted from
the token or from the client.
"""
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.permissions import Capability, Principal
from app.core.security import decode_access_token
from app.db.session import get_db
from app.services.auth_service import load_principal

_bearer = HTTPBearer(auto_error=False)


def _not_authenticated() -> HTTPException:
    return HTTPException(status_code=401, detail="not_authenticated", headers={"WWW-Authenticate": "Bearer"})


async def get_principal_allow_password_change(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> Principal:
    """Authenticated, even if a password change is pending (used by /auth/me and /auth/change-password)."""
    if credentials is None:
        raise _not_authenticated()
    user_id = decode_access_token(credentials.credentials)
    if user_id is None:
        raise _not_authenticated()
    principal = await load_principal(db, user_id)
    if principal is None:
        raise _not_authenticated()
    return principal


async def get_current_principal(
    principal: Principal = Depends(get_principal_allow_password_change),
) -> Principal:
    if principal.must_change_password:
        raise HTTPException(status_code=403, detail="password_change_required")
    return principal


def require_capability(capability: Capability):
    """Dependency factory: 403 unless the caller's role has the capability at ANY scope.
    Row-level limits (which reports/equipment) are applied separately by app.core.scoping."""

    async def _dep(principal: Principal = Depends(get_current_principal)) -> Principal:
        if not principal.can(capability):
            raise HTTPException(status_code=403, detail="forbidden")
        return principal

    return _dep


def get_client_ip(request: Request) -> str | None:
    if get_settings().trust_forwarded_for:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[-1].strip()[:45] or None
    return request.client.host[:45] if request.client else None


CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "ems-web"


def csrf_guard(request: Request) -> None:
    """For the cookie-authenticated endpoints (/auth/refresh, /auth/logout).
    A custom header forces a CORS preflight for cross-site callers, and a
    browser-sent Origin must be one we allow. Bearer-token endpoints don't need this."""
    if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
        raise HTTPException(status_code=403, detail="csrf_check_failed")
    origin = request.headers.get("origin")
    if origin and origin not in get_settings().cors_allow_origins:
        raise HTTPException(status_code=403, detail="csrf_check_failed")
