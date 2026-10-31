"""DiffusersProvider: local GPU generation with real latent previews.

Every N denoising steps, `callback_on_step_end` hands us the current latents.
We decode them with a tiny preview VAE (TAESD / AutoencoderTiny) instead of the
full VAE, which is ~100x cheaper, so previews cost a few ms each. The full VAE
runs only once, for the final image.

torch / diffusers are imported lazily, so the server runs without them; this
provider then reports "not configured".
"""
from __future__ import annotations

import asyncio
import gc
import importlib.util
import threading
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Optional

from PIL import Image

from ..events import Event, ProviderError, final, progress
from ..schemas import GenerateParams
from .base import ImageProvider
from .simulated import seed_for

PreviewDecoder = Callable[[Any, int, int], Image.Image]


def default_taesd_for(model_id: str) -> str:
    m = model_id.lower()
    if "flux" in m:
        return "madebyollin/taef1"
    if "xl" in m:
        return "madebyollin/taesdxl"
    if "stable-diffusion-3" in m or "sd3" in m:
        return "madebyollin/taesd3"
    return "madebyollin/taesd"


def is_oom(exc: BaseException) -> bool:
    return type(exc).__name__ == "OutOfMemoryError" or "out of memory" in str(exc).lower()


@dataclass
class Loaded:
    pipe: Any
    decode_preview: PreviewDecoder
    is_flux: bool


def load_pipeline(model_id: str, taesd_id: str, device: str) -> Loaded:  # pragma: no cover - needs GPU + weights
    import torch
    from diffusers import AutoencoderTiny, AutoPipelineForText2Image

    dtype = torch.float16 if device.startswith("cuda") else torch.float32
    is_flux = "flux" in model_id.lower()
    if is_flux:
        dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    pipe = AutoPipelineForText2Image.from_pretrained(model_id, torch_dtype=dtype)
    pipe.to(device)
    tiny = AutoencoderTiny.from_pretrained(taesd_id, torch_dtype=dtype).to(device)

    @torch.no_grad()
    def decode_preview(latents: Any, width: int, height: int) -> Image.Image:
        lat = latents
        if is_flux:
            # Flux packs latents as (B, seq, 64); unpack and undo the VAE scaling/shift.
            lat = pipe._unpack_latents(lat, height, width, pipe.vae_scale_factor)
            lat = lat / pipe.vae.config.scaling_factor + pipe.vae.config.shift_factor
        img = tiny.decode(lat[:1].to(tiny.dtype)).sample[0]  # [-1, 1]
        img = ((img.float().clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()
        return Image.fromarray(img)

    return Loaded(pipe, decode_preview, is_flux)


class DiffusersProvider(ImageProvider):
    name = "diffusers"
    real_preview = True

    def __init__(self, model_id: str, taesd_id: str = "", device: str = "cuda",
                 loader: Optional[Callable[[], Loaded]] = None) -> None:
        self.model_id = model_id
        self.taesd_id = taesd_id or default_taesd_for(model_id)
        self.device = device
        self.model_label = f"{model_id} + {self.taesd_id.split('/')[-1]} previews"
        self._loader = loader or (lambda: load_pipeline(self.model_id, self.taesd_id, self.device))
        self._custom_loader = loader is not None
        self._loaded: Optional[Loaded] = None
        self._lock = threading.Lock()

    def configured(self) -> tuple[bool, str]:
        if self._custom_loader or self._loaded is not None:
            return True, ""
        if importlib.util.find_spec("torch") is None or importlib.util.find_spec("diffusers") is None:
            return False, "Local GPU mode needs torch + diffusers (pip install -r requirements-gpu.txt)."
        try:
            import torch  # noqa: F401

            if self.device.startswith("cuda") and not torch.cuda.is_available():
                return False, "No CUDA GPU detected (set DIFFUSERS_DEVICE=cpu to force CPU, very slow)."
        except Exception as e:  # pragma: no cover
            return False, f"torch failed to import: {e}"
        return True, ""

    def _get(self) -> Loaded:
        with self._lock:
            if self._loaded is None:
                self._loaded = self._loader()
            return self._loaded

    def _run(self, params: GenerateParams, seed: int, cancel: asyncio.Event,
             push: Callable[[Event], None]) -> Image.Image:
        loaded = self._get()
        pipe = loaded.pipe
        t0 = time.perf_counter()
        total = params.steps

        def on_step_end(p: Any, step_index: int, timestep: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
            step = step_index + 1
            if cancel.is_set():
                p._interrupt = True  # diffusers checks this flag between steps
                return kwargs
            if step % params.preview_every == 0 and step < total:
                img = loaded.decode_preview(kwargs["latents"], params.width, params.height)
                push(progress(step, total, int((time.perf_counter() - t0) * 1000), img, params.width, params.height))
            return kwargs

        generator = None
        try:
            import torch

            generator = torch.Generator(device=self.device).manual_seed(seed)
        except ImportError:
            pass
        call: dict[str, Any] = dict(
            prompt=params.prompt, width=params.width, height=params.height,
            num_inference_steps=total, guidance_scale=params.guidance, generator=generator,
            callback_on_step_end=on_step_end, callback_on_step_end_tensor_inputs=["latents"],
        )
        if params.negative_prompt and not loaded.is_flux:
            call["negative_prompt"] = params.negative_prompt
        out = pipe(**call)
        img = out.images[0]
        # Last preview step == final full-VAE image, so the timeline ends on the true result.
        push(progress(total, total, int((time.perf_counter() - t0) * 1000), img, params.width, params.height))
        return img

    async def generate(self, params: GenerateParams, cancel: asyncio.Event) -> AsyncIterator[Event]:
        ok, why = self.configured()
        if not ok:
            raise ProviderError(why, code="not_configured", recoverable=False)
        loop = asyncio.get_running_loop()
        q: asyncio.Queue[Event] = asyncio.Queue()
        seed = seed_for(params.prompt, params.seed)
        fut = loop.run_in_executor(None, self._run, params, seed, cancel,
                                   lambda ev: loop.call_soon_threadsafe(q.put_nowait, ev))
        while True:
            getter = asyncio.ensure_future(q.get())
            done, _ = await asyncio.wait({getter, fut}, return_when=asyncio.FIRST_COMPLETED)
            if getter in done:
                yield getter.result()
                continue
            getter.cancel()
            while not q.empty():
                yield q.get_nowait()
            break
        try:
            img = fut.result()
        except Exception as e:
            if is_oom(e):
                raise ProviderError("The GPU ran out of memory. Try a smaller size or fewer steps, then retry.",
                                    code="oom", recoverable=True) from e
            raise ProviderError(f"Diffusers failed: {e}", code="upstream") from e
        if cancel.is_set():
            return
        yield final(img, seed, params.model_dump())

    async def release(self) -> None:
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
