"""Event types emitted by providers and streamed over SSE.

Wire format (see shared/events.ts):
  progress {step, total_steps, elapsed_ms, preview_b64_jpeg, width, height}
  final    {image_url, seed, params}
  error    {message, recoverable, code}
  queue    {position}
"""
from __future__ import annotations

import base64
import io
from dataclasses import dataclass, field
from typing import Any, Literal

from PIL import Image

EventType = Literal["progress", "final", "error", "queue"]


@dataclass
class Event:
    type: EventType
    data: dict[str, Any] = field(default_factory=dict)
    # Internal only: final PNG bytes, replaced by image_url before going on the wire.
    image_png: bytes | None = None


class ProviderError(Exception):
    """A failure with a human-readable message. code is one of: oom, rate_limit,
    not_configured, upstream, cancelled, invalid."""

    def __init__(self, message: str, *, code: str = "upstream", recoverable: bool = True) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.recoverable = recoverable


def encode_preview(img: Image.Image, max_side: int = 512, quality: int = 70) -> str:
    """JPEG q=70, downscaled to max 512px on the long side, base64 (no data: prefix)."""
    im = img.convert("RGB")
    w, h = im.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1.0:
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def encode_png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def progress(step: int, total: int, elapsed_ms: int, preview: Image.Image, width: int, height: int) -> Event:
    return Event("progress", {
        "step": step, "total_steps": total, "elapsed_ms": elapsed_ms,
        "preview_b64_jpeg": encode_preview(preview), "width": width, "height": height,
    })


def final(img: Image.Image, seed: int, params: dict[str, Any]) -> Event:
    return Event("final", {"image_url": "", "seed": seed, "params": params}, image_png=encode_png(img))


def error(message: str, *, recoverable: bool = True, code: str = "upstream") -> Event:
    return Event("error", {"message": message, "recoverable": recoverable, "code": code})
