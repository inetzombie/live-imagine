"""SimulatedProvider: no GPU, no keys. NOT real diffusion.

Builds a deterministic procedural image from hash(prompt, seed), then fakes a
denoising trajectory: Gaussian noise that decays, progressive upscaling from
8x8 to full size, and blur-to-sharp. The UI labels it "Simulated".
"""
from __future__ import annotations

import asyncio
import colorsys
import hashlib
import time
from typing import AsyncIterator

import numpy as np
from PIL import Image, ImageFilter

from ..events import Event, final, progress
from ..schemas import GenerateParams
from .base import ImageProvider


def seed_for(prompt: str, seed: int | None) -> int:
    if seed is not None:
        return int(seed)
    return int.from_bytes(hashlib.sha256(prompt.encode()).digest()[:4], "big")


def procedural_image(prompt: str, seed: int, width: int, height: int) -> Image.Image:
    """Deterministic 'painting': gradient sky, horizon ridges, soft glowing orbs, texture."""
    h = hashlib.sha256(f"{prompt}|{seed}".encode()).digest()
    rng = np.random.default_rng(int.from_bytes(h[:8], "big"))
    base_hue = h[8] / 255.0

    def col(dh: float, s: float, v: float) -> np.ndarray:
        return np.array(colorsys.hsv_to_rgb((base_hue + dh) % 1.0, s, v), dtype=np.float32)

    # Work at <=512 then upscale: keeps CPU cost low.
    sc = min(1.0, 512 / max(width, height))
    w, hgt = max(8, int(width * sc)), max(8, int(height * sc))
    ys, xs = np.mgrid[0:hgt, 0:w].astype(np.float32)
    u, v = xs / w, ys / hgt

    top, bottom = col(0.0, 0.55, 0.25), col(0.08, 0.6, 0.95)
    img = top[None, None, :] * (1 - v[..., None]) + bottom[None, None, :] * v[..., None]

    # Glowing orbs (sun / moons / lights)
    for _ in range(int(rng.integers(1, 4))):
        cx, cy, r = rng.uniform(0.15, 0.85), rng.uniform(0.1, 0.5), rng.uniform(0.05, 0.16)
        d = np.sqrt((u - cx) ** 2 + ((v - cy) * hgt / w) ** 2)
        glow = np.exp(-((d / (r * 2.2)) ** 2))[..., None]
        disc = (d < r).astype(np.float32)[..., None]
        c = col(rng.uniform(-0.1, 0.15), 0.35, 1.0)
        img = img * (1 - 0.5 * glow) + c * 0.5 * glow
        img = img * (1 - disc) + c * disc

    # Layered ridges (mountains / city / waves), farther = lighter
    layers = int(rng.integers(3, 6))
    for i in range(layers):
        depth = (i + 1) / layers
        base = 0.45 + 0.45 * depth
        f1, f2 = rng.uniform(2, 6), rng.uniform(8, 20)
        p1, p2 = rng.uniform(0, 6.28, 2)
        ridge = base - 0.12 * (1 - depth * 0.5) * (np.sin(u * f1 * 3.14 + p1) * 0.6 + np.sin(u * f2 * 3.14 + p2) * 0.25 + 0.3)
        mask = (v > ridge).astype(np.float32)[..., None]
        c = col(0.5 + rng.uniform(-0.08, 0.08), 0.5, 0.15 + 0.5 * (1 - depth))
        shade = (1 - 0.35 * (v - ridge).clip(0, 1))[..., None]
        img = img * (1 - mask) + c * shade * mask

    # Fine texture so the "detail" phase has something to resolve
    tex = rng.normal(0, 0.035, (hgt, w, 1)).astype(np.float32)
    img = np.clip(img + tex, 0, 1)
    out = Image.fromarray((img * 255).astype(np.uint8), "RGB")
    if (w, hgt) != (width, height):
        out = out.resize((width, height), Image.BICUBIC)
    return out


def simulate_step(target: Image.Image, s: float, rng: np.random.Generator) -> Image.Image:
    """One fake 'denoising' frame at progress s in (0, 1]."""
    w, h = target.size
    # Progressive upscale: 8px -> full along a geometric schedule.
    long_side = max(w, h)
    res = int(round(8 * (long_side / 8) ** min(1.0, s * 1.15)))
    rw, rh = max(2, round(w * res / long_side)), max(2, round(h * res / long_side))
    img = target.resize((rw, rh), Image.BOX).resize((w, h), Image.BICUBIC)
    blur = 12.0 * (1 - s) ** 2
    if blur > 0.3:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    # DDPM-like mix: x = sqrt(a)*x0 + sqrt(1-a)*noise, a rising with s.
    a = min(1.0, s ** 1.6)
    if a < 1.0:
        arr = np.asarray(img, dtype=np.float32) / 255.0
        noise = rng.normal(0.5, 0.5, arr.shape).astype(np.float32)
        arr = np.sqrt(a) * arr + np.sqrt(1 - a) * noise
        img = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "RGB")
    return img


class SimulatedProvider(ImageProvider):
    name = "simulated"
    model_label = "Simulated (procedural, not a model)"
    real_preview = False

    def __init__(self, step_ms: int = 120) -> None:
        self.step_ms = step_ms

    async def generate(self, params: GenerateParams, cancel: asyncio.Event) -> AsyncIterator[Event]:
        t0 = time.perf_counter()
        seed = seed_for(params.prompt, params.seed)
        target = await asyncio.to_thread(procedural_image, params.prompt, seed, params.width, params.height)
        rng = np.random.default_rng(seed)
        preview_target = target.copy()
        preview_target.thumbnail((512, 512))
        total = params.steps
        for step in range(1, total + 1):
            if cancel.is_set():
                return
            if step % params.preview_every == 0 or step == total:
                frame = await asyncio.to_thread(simulate_step, preview_target, step / total, rng)
                yield progress(step, total, int((time.perf_counter() - t0) * 1000), frame, params.width, params.height)
            await asyncio.sleep(self.step_ms / 1000)
        yield final(target, seed, params.model_dump())
