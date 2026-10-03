"""
Auth endpoints. Frontend contract (see docs/auth.md):
  * access token lives in JS memory only, sent as `Authorization: Bearer`;
  * refresh token is an HttpOnly cookie scoped to /auth; /auth/refresh and
    /auth/logout additionally require the header `X-Requested-With: ems-web`;
  * call /auth/refresh single-flight (one request at a time) — rotation treats
    a second use of the same token as theft and ends the session.
Every login failure (unknown user, wrong password, inactive account) returns
the same 401 `invalid_credentials`.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    csrf_guard,
    get_client_ip,
    get_principal_allow_password_change,
)
from app.core.config import get_settings
from app.core.permissions import Principal
from app.db.session import get_db
from app.schemas.auth import ChangePasswordRequest, LoginRequest, TokenResponse, UserOut
from app.services import auth_service
from app.services.auth_service import (
    InvalidCredentials,
    InvalidRefreshToken,
    PasswordPolicyError,
    Session,
    TooManyAttempts,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_out(p: Principal) -> UserOut:
    return UserOut(
        id=p.user_id,
        username=p.username,
        full_name=p.full_name,
        role_code=p.role_code,
        role_label_fa=p.role_label_fa,
        group_ids=sorted(p.group_ids),
        must_change_password=p.must_change_password,
    )


def _set_refresh_cookie(response: Response, raw: str, expires_at: datetime) -> None:
    s = get_settings()
    response.set_cookie(
        key=s.refresh_cookie_name,
        value=raw,
        max_age=s.refresh_token_expire_days * 86400,
        path=s.refresh_cookie_path,
        domain=s.refresh_cookie_domain,
        secure=s.refresh_cookie_secure,
        httponly=True,
        samesite=s.refresh_cookie_samesite,
    )


def _clear_refresh_cookie(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(
        key=s.refresh_cookie_name,
        path=s.refresh_cookie_path,
        domain=s.refresh_cookie_domain,
        secure=s.refresh_cookie_secure,
        httponly=True,
        samesite=s.refresh_cookie_samesite,
    )


def _token_response(response: Response, principal: Principal, session: Session) -> TokenResponse:
    _set_refresh_cookie(response, session.refresh_token, session.refresh_expires_at)
    response.headers["Cache-Control"] = "no-store"
    return TokenResponse(
        access_token=session.access_token,
        expires_in=session.expires_in,
        must_change_password=principal.must_change_password,
        user=_user_out(principal),
    )


def _too_many(exc: TooManyAttempts) -> HTTPException:
    return HTTPException(
        status_code=429, detail="too_many_attempts", headers={"Retry-After": str(exc.retry_after)}
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)
) -> TokenResponse:
    try:
        principal, session = await auth_service.login(
            db, body.username, body.password, get_client_ip(request)
        )
    except TooManyAttempts as exc:
        raise _too_many(exc)
    except InvalidCredentials:
        raise HTTPException(status_code=401, detail="invalid_credentials")
    return _token_response(response, principal, session)


@router.post("/refresh", response_model=TokenResponse, dependencies=[Depends(csrf_guard)])
async def refresh(
    request: Request, response: Response, db: AsyncSession = Depends(get_db)
) -> TokenResponse | JSONResponse:
    raw = request.cookies.get(get_settings().refresh_cookie_name)
    try:
        principal, session = await auth_service.rotate_refresh_token(db, raw)
    except InvalidRefreshToken:
        failure = JSONResponse(status_code=401, content={"detail": "invalid_refresh_token"})
        _clear_refresh_cookie(failure)
        return failure
    return _token_response(response, principal, session)


@router.post("/logout", status_code=204, dependencies=[Depends(csrf_guard)])
async def logout(request: Request, db: AsyncSession = Depends(get_db)) -> Response:
    await auth_service.logout(db, request.cookies.get(get_settings().refresh_cookie_name))
    out = Response(status_code=204)
    _clear_refresh_cookie(out)
    return out


@router.get("/me", response_model=UserOut)
async def me(principal: Principal = Depends(get_principal_allow_password_change)) -> UserOut:
    return _user_out(principal)


@router.post("/change-password", response_model=TokenResponse)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    response: Response,
    principal: Principal = Depends(get_principal_allow_password_change),
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    try:
        fresh, session = await auth_service.change_password(
            db, principal, body.current_password, body.new_password, get_client_ip(request)
        )
    except TooManyAttempts as exc:
        raise _too_many(exc)
    except InvalidCredentials:
        raise HTTPException(status_code=401, detail="invalid_credentials")
    except PasswordPolicyError as exc:
        raise HTTPException(status_code=422, detail={"code": "password_policy", "errors": exc.errors})
    return _token_response(response, fresh, session)
