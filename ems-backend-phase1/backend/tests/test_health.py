import pytest


@pytest.mark.asyncio
async def test_liveness(client):
    resp = await client.get("/health/live")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "app" in body


@pytest.mark.asyncio
async def test_readiness(client):
    resp = await client.get("/health/ready")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "database": "reachable"}


@pytest.mark.asyncio
async def test_docs_available_in_non_production(client):
    resp = await client.get("/docs")
    assert resp.status_code == 200
