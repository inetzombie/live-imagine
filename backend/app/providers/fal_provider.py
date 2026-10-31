"""FalStreamingProvider (extra): FLUX.1 [dev] via fal.ai's /stream endpoint.
Key from env FAL_KEY. fal emits SSE events whose JSON contains image URLs or
data URIs; every new image is forwarded as a `progress` event."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import time
from typing import Any, AsyncIterator, Callable, Optional

import httpx
from PIL import Image

from ..events import Event, ProviderError, final, progress
from ..schemas import GenerateParams
from ..sse import SSEParser
from .base import ImageProvider
from .openai_provider import http_error

URL = "https://fal.run/fal-ai/flux/dev/stream"


def image_refs(obj: Any) -> list[str]:
    out: list[str] = []

    def walk(o: Any) -> None:
        if isinstance(o, str):
            if o.startswith("data:image"):
                out.append(o)
        elif isinstance(o, dict):
            for k, v in o.items():
                if k == "url" and isinstance(v, str):
                    out.append(v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(obj)
    return [u for u in out if u.startswith("data:image") or u.startswith("http")]


class FalStreamingProvider(ImageProvider):
    name = "fal"
    real_preview = True
    model_label = "FLUX.1 [dev] on fal.ai (stream)"

    def __init__(self, key_getter: Callable[[], Optional[str]],
                 client_factory: Optional[Callable[[], httpx.AsyncClient]] = None) -> None:
        self._key = key_getter
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=httpx.Timeout(180, connect=15)))

    def configured(self) -> tuple[bool, str]:
        return (True, "") if self._key() else (False, "fal.ai not configured: set FAL_KEY.")

    async def _load(self, client: httpx.AsyncClient, ref: str) -> Image.Image:
        if ref.startswith("data:"):
            raw = base64.b64decode(ref.split(",", 1)[1])
        else:
            raw = (await client.get(ref)).content
        return Image.open(io.BytesIO(raw)).convert("RGB")

    async def generate(self, params: GenerateParams, cancel: asyncio.Event) -> AsyncIterator[Event]:
        key = self._key()
        if not key:
            raise ProviderError("fal.ai not configured: set FAL_KEY.", code="not_configured", recoverable=False)
        body: dict[str, Any] = {
            "prompt": params.prompt + (f". Avoid: {params.negative_prompt}" if params.negative_prompt else ""),
            "image_size": {"width": params.width, "height": params.height},
            "num_inference_steps": params.steps, "guidance_scale": params.guidance,
            "num_images": 1, "enable_safety_checker": True, "output_format": "png",
        }
        if params.seed is not None:
            body["seed"] = params.seed
        t0 = time.perf_counter()
        parser = SSEParser()
        seen: set[str] = set()
        last: Optional[Image.Image] = None
        frames = 0
        seed = params.seed or 0
        async with self._client_factory() as client:
            try:
                async with client.stream("POST", URL, json=body, headers={
                        "Authorization": f"Key {key}", "Accept": "text/event-stream"}) as r:
                    if r.status_code >= 400:
                        raise http_error(r.status_code, (await r.aread()).decode(errors="replace"), "fal.ai")
                    async for chunk in r.aiter_text():
                        if cancel.is_set():
                            return
                        for event, data in parser.feed(chunk):
                            try:
                                ev = json.loads(data)
                            except json.JSONDecodeError:
                                continue
                            if event == "error":
                                raise ProviderError(f"fal.ai: {ev}", code="upstream")
                            if isinstance(ev, dict) and isinstance(ev.get("seed"), int):
                                seed = ev["seed"]
                            for ref in image_refs(ev):
                                if ref in seen:
                                    continue
                                seen.add(ref)
                                last = await self._load(client, ref)
                                frames += 1
                                yield progress(min(frames, params.steps), params.steps,
                                               int((time.perf_counter() - t0) * 1000), last,
                                               params.width, params.height)
            except httpx.HTTPError as e:
                raise ProviderError(f"Connection to fal.ai dropped: {e}", code="network") from e
        if last is None:
            raise ProviderError("fal.ai returned no image.", code="upstream")
        yield final(last, seed, params.model_dump())
