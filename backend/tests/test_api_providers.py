import base64
import io
import json

import httpx
import pytest
from PIL import Image

from app.events import ProviderError
from app.providers.fal_provider import FalStreamingProvider, image_refs
from app.providers.openai_provider import OpenAIStreamingProvider, openai_size
from app.schemas import GenerateParams

from .test_providers import collect


def png_b64(color: str) -> str:
    b = io.BytesIO()
    Image.new("RGB", (16, 16), color).save(b, "PNG")
    return base64.b64encode(b.getvalue()).decode()


def client_with(handler):
    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


P = GenerateParams(prompt="otter", width=768, height=512, steps=20)


async def test_openai_partials_forwarded():
    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        assert body["stream"] is True and body["partial_images"] == 3 and body["size"] == "1536x1024"
        assert req.headers["authorization"] == "Bearer sk-test"
        sse = "".join(
            f"event: image_generation.partial_image\ndata: {json.dumps({'type': 'image_generation.partial_image', 'partial_image_index': i, 'b64_json': png_b64('red')})}\n\n"
            for i in range(3))
        sse += f"data: {json.dumps({'type': 'image_generation.completed', 'b64_json': png_b64('blue')})}\n\n"
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    evs = await collect(OpenAIStreamingProvider(lambda: "sk-test", client_factory=client_with(handler)), P)
    assert [e.data["step"] for e in evs if e.type == "progress"] == [1, 2, 3, 4]
    assert evs[-1].type == "final"


async def test_openai_not_configured_and_rate_limit():
    p = OpenAIStreamingProvider(lambda: None)
    assert p.configured()[0] is False
    with pytest.raises(ProviderError) as ei:
        await collect(p, P)
    assert ei.value.code == "not_configured"
    p2 = OpenAIStreamingProvider(lambda: "k", client_factory=client_with(lambda r: httpx.Response(429, text="slow")))
    with pytest.raises(ProviderError) as ei:
        await collect(p2, P)
    assert ei.value.code == "rate_limit" and ei.value.recoverable


def test_openai_size():
    assert openai_size(512, 512) == "1024x1024"
    assert openai_size(512, 896) == "1024x1536"


async def test_fal_stream():
    uri = "data:image/png;base64," + png_b64("green")
    uri2 = "data:image/png;base64," + png_b64("white")
    sse = f"data: {json.dumps({'images': [{'url': uri}]})}\n\ndata: {json.dumps({'images': [{'url': uri2}], 'seed': 9})}\n\n"
    p = FalStreamingProvider(lambda: "k", client_factory=client_with(lambda r: httpx.Response(200, text=sse)))
    evs = await collect(p, P)
    assert [e.type for e in evs] == ["progress", "progress", "final"] and evs[-1].data["seed"] == 9


def test_image_refs():
    assert image_refs({"a": [{"url": "https://x/y.png"}], "b": "data:image/png;base64,AA"}) == [
        "https://x/y.png", "data:image/png;base64,AA"]
