"""Test client for the REAL routers (app.api.router.API_ROUTERS) on a given session maker. Logs in through the
real /auth/login (tokens cached per user), so every call goes through genuine authentication."""
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.errors import register_error_handlers
from app.api.router import API_ROUTERS
from app.db.session import get_db
from tests import factories as f


def build_app(maker) -> FastAPI:
    app = FastAPI()
    register_error_handlers(app)
    for r in API_ROUTERS:
        app.include_router(r)

    async def _db():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    return app


class Api:
    def __init__(self, maker):
        self._client = AsyncClient(transport=ASGITransport(app=build_app(maker)), base_url="http://test")
        self._tokens: dict[str, str] = {}

    async def __aenter__(self):
        await self._client.__aenter__()
        return self

    async def __aexit__(self, *exc):
        await self._client.__aexit__(*exc)

    async def token(self, username: str, password: str = f.PASSWORD) -> str:
        if username not in self._tokens:
            r = await self._client.post("/auth/login", json={"username": username, "password": password})
            assert r.status_code == 200, (username, r.status_code, r.text)
            self._tokens[username] = r.json()["access_token"]
        return self._tokens[username]

    async def call(self, method: str, path: str, who: str | None = None, **kw):
        headers = dict(kw.pop("headers", {}))
        if who:
            headers["Authorization"] = f"Bearer {await self.token(who)}"
        return await self._client.request(method, path, headers=headers, **kw)

    async def get(self, path, who=None, **kw):
        return await self.call("GET", path, who, **kw)

    async def post(self, path, who=None, **kw):
        return await self.call("POST", path, who, **kw)

    async def patch(self, path, who=None, **kw):
        return await self.call("PATCH", path, who, **kw)

    async def put(self, path, who=None, **kw):
        return await self.call("PUT", path, who, **kw)
