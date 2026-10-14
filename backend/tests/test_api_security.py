"""Systematic checks over the REAL application's route table, so a new endpoint cannot ship unprotected by accident."""
import re

from httpx import ASGITransport, AsyncClient

from app.main import app

PUBLIC = {
    ("GET", "/health/live"), ("GET", "/health/ready"), ("POST", "/auth/login"),
    ("POST", "/auth/refresh"), ("POST", "/auth/logout"),  # cookie + CSRF-guarded, covered in test_auth_api
}


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)


def _routes():
    for r in app.routes:
        methods = getattr(r, "methods", None)
        path = getattr(r, "path", "")
        if not methods or path.startswith("/docs") or path == "/openapi.json":
            continue
        for method in sorted(methods - {"HEAD", "OPTIONS"}):
            yield method, path


async def test_every_non_public_route_requires_a_bearer_token():
    checked = 0
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        for method, path in _routes():
            if (method, path) in PUBLIC:
                continue
            r = await c.request(method, _concrete(path), json={})
            assert r.status_code == 401, f"{method} {path} answered {r.status_code} without credentials"
            assert r.headers.get("www-authenticate") == "Bearer"
            checked += 1
    assert checked >= 30  # guards against the test silently checking nothing


async def test_garbage_bearer_is_rejected_everywhere():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        for method, path in _routes():
            if (method, path) in PUBLIC or path == "/auth/change-password":
                continue
            r = await c.request(method, _concrete(path), headers={"Authorization": "Bearer not.a.jwt"}, json={})
            assert r.status_code == 401, f"{method} {path}"


def test_public_list_is_exactly_what_we_expect():
    assert {(m, p) for m, p in _routes() if (m, p) in PUBLIC} == PUBLIC  # none of the public routes disappeared silently


async def test_cors_allows_the_frontend_origin_with_credentials_and_exposes_retry_after():
    origin = "http://localhost:5173"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        simple = await c.get("/health/live", headers={"Origin": origin})
        assert simple.headers["access-control-allow-origin"] == origin
        assert simple.headers["access-control-allow-credentials"] == "true"
        assert "retry-after" in simple.headers["access-control-expose-headers"].lower()
        pre = await c.options("/auth/refresh", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-requested-with"})
        assert pre.status_code == 200 and "x-requested-with" in pre.headers["access-control-allow-headers"].lower()
        evil = await c.get("/health/live", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in evil.headers
