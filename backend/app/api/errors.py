from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.core.errors import DomainError
from app.services.auth_service import PasswordPolicyError


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def _domain(_: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail()})

    @app.exception_handler(PasswordPolicyError)
    async def _policy(_: Request, exc: PasswordPolicyError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": {"code": "password_policy", "errors": exc.errors}})
