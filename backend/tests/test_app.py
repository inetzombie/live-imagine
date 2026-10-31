import asyncio
import json

import httpx
import pytest

from app.main import create_app
from app.sse import SSEParser


@pytest.fixture
async def client():
    app = create_app()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            yield c


async def read_events(c, job_id, headers=None):
    p, out = SSEParser(), []
    async with c.stream("GET", f"/stream/{job_id}", headers=headers or {}) as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        async for chunk in r.aiter_text():
            for ev, data in p.feed(chunk):
                out.append((ev, json.loads(data)))
            if out and out[-1][0] in ("final", "error"):
                break
    return out


async def test_health_lists_providers(client):
    j = (await client.get("/health")).json()
    names = {p["name"]: p for p in j["providers"]}
    assert names["simulated"]["configured"] and not names["openai"]["configured"]
    assert names["simulated"]["real_preview"] is False


async def test_generate_stream_final_image(client):
    r = await client.post("/generate", json={"prompt": "a fox", "steps": 6, "width": 256, "height": 256, "seed": 5})
    jid = r.json()["job_id"]
    evs = await read_events(client, jid)
    kinds = [e for e, _ in evs]
    assert kinds[0] == "meta" and "progress" in kinds and kinds[-1] == "final"
    img = await client.get(evs[-1][1]["image_url"])
    assert img.status_code == 200 and img.content[:4] == b"\x89PNG"


async def test_resume_with_last_event_id(client):
    jid = (await client.post("/generate", json={"prompt": "a", "steps": 5, "width": 64, "height": 64})).json()["job_id"]
    await read_events(client, jid)
    evs = await read_events(client, jid, {"Last-Event-ID": "4"})
    assert [e for e, _ in evs] == ["meta", "progress", "final"]  # only newest pending progress + final


async def test_not_configured_provider_is_503(client):
    r = await client.post("/generate", json={"prompt": "a", "provider": "openai"})
    assert r.status_code == 503 and r.json()["error"] == "not_configured"


async def test_validation_422(client):
    assert (await client.post("/generate", json={"prompt": "a", "steps": 999})).status_code == 422
    assert (await client.post("/generate", json={"prompt": ""})).status_code == 422


async def test_cancel_and_queue(client):
    a = (await client.post("/generate", json={"prompt": "a", "steps": 60, "width": 64, "height": 64})).json()
    b = (await client.post("/generate", json={"prompt": "b", "steps": 60, "width": 64, "height": 64})).json()
    assert b["queue_position"] >= 1
    assert (await client.post(f"/cancel/{b['job_id']}")).json() == {"cancelled": True}
    evs = await read_events(client, b["job_id"])
    assert evs[-1][0] == "error" and evs[-1][1]["code"] == "cancelled"
    await asyncio.sleep(0.05)
    await client.post(f"/cancel/{a['job_id']}")
    evs = await read_events(client, a["job_id"])
    assert evs[-1][1]["code"] == "cancelled"
    assert (await client.post("/cancel/nope")).status_code == 404
