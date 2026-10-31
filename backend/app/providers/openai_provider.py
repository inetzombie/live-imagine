"""ApiStreamingProvider: OpenAI gpt-image with `partial_images` streaming.

POST /v1/images/generations {stream: true, partial_images: 3}; the API sends
`image_generation.partial_image` events (real partial renders) and finally
`image_generation.completed`. Each is forwarded as a `progress` event.
Key from env OPENAI_API_KEY.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import time
from typing import AsyncIterator, Callable, Optional

import httpx
from PIL import Image

from ..events import Event, ProviderError, final, progress
from ..schemas import GenerateParams
from ..sse import SSEParser
from .base import ImageProvider

URL = "https://api.openai.com/v1/images/generations"
PARTIALS = 3


def openai_size(w: int, h: int) -> str:
    r = w / h
    if r > 1.2:
        return "1536x1024"
    if r < 0.83:
        return "1024x1536"
    return "1024x1024"


def http_error(status: int, body: str, service: str) -> ProviderError:
    if status == 429:
        return ProviderError(f"{service} rate limit or quota reached. Wait a moment, then retry.", code="rate_limit")
    if status in (401, 403):
        return ProviderError(f"{service} rejected the API key ({status}).", code="not_configured", recoverable=False)
    if status == 400:
        return ProviderError(f"{service} refused the request: {body[:300]}", code="invalid", recoverable=False)
    return ProviderError(f"{service} error {status}: {body[:300]}", code="upstream")


class OpenAIStreamingProvider(ImageProvider):
    name = "openai"
    real_preview = True

    def __init__(self, key_getter: Callable[[], Optional[str]], model: str = "gpt-image-1",
                 client_factory: Optional[Callable[[], httpx.AsyncClient]] = None) -> None:
        self._key = key_getter
        self.model = model
        self.model_label = f"OpenAI {model} (partial images)"
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=httpx.Timeout(180, connect=15)))

    def configured(self) -> tuple[bool, str]:
        return (True, "") if self._key() else (False, "OpenAI not configured: set OPENAI_API_KEY.")

    async def generate(self, params: GenerateParams, cancel: asyncio.Event) -> AsyncIterator[Event]:
        key = self._key()
        if not key:
            raise ProviderError("OpenAI not configured: set OPENAI_API_KEY.", code="not_configured", recoverable=False)
        prompt = params.prompt + (f"\nAvoid: {params.negative_prompt}" if params.negative_prompt else "")
        size = openai_size(params.width, params.height)
        w, h = (int(x) for x in size.split("x"))
        body = {"model": self.model, "prompt": prompt, "size": size, "n": 1,
                "stream": True, "partial_images": PARTIALS}
        t0 = time.perf_counter()
        total = PARTIALS + 1
        parser = SSEParser()
        async with self._client_factory() as client:
            try:
                async with client.stream("POST", URL, json=body,
                                         headers={"Authorization": f"Bearer {key}"}) as r:
                    if r.status_code >= 400:
                        raise http_error(r.status_code, (await r.aread()).decode(errors="replace"), "OpenAI")
                    async for chunk in r.aiter_text():
                        if cancel.is_set():
                            return
                        for _, data in parser.feed(chunk):
                            try:
                                ev = json.loads(data)
                            except json.JSONDecodeError:
                                continue
                            kind = ev.get("type", "")
                            if kind == "error" or "error" in ev and not ev.get("b64_json"):
                                err = ev.get("error") or ev
                                raise ProviderError(f"OpenAI: {err.get('message', err)}", code="upstream")
                            b64 = ev.get("b64_json")
                            if not b64:
                                continue
                            img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
                            ms = int((time.perf_counter() - t0) * 1000)
                            if kind.endswith("partial_image"):
                                step = int(ev.get("partial_image_index", 0)) + 1
                                yield progress(step, total, ms, img, w, h)
                            elif kind.endswith("completed"):
                                yield progress(total, total, ms, img, w, h)
                                yield final(img, params.seed or 0, params.model_dump())
                                return
            except httpx.HTTPError as e:
                raise ProviderError(f"Connection to OpenAI dropped: {e}", code="network") from e
        raise ProviderError("OpenAI stream ended without a final image.", code="upstream")
