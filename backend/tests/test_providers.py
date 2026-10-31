import asyncio

import numpy as np
import pytest
from PIL import Image

from app.events import Event, ProviderError
from app.providers.base import ImageProvider
from app.providers.diffusers_provider import DiffusersProvider, Loaded, default_taesd_for
from app.providers.simulated import SimulatedProvider, procedural_image, simulate_step
from app.schemas import GenerateParams


async def collect(provider: ImageProvider, params: GenerateParams, cancel=None) -> list[Event]:
    cancel = cancel or asyncio.Event()
    return [e async for e in provider.generate(params, cancel)]


def P(**kw) -> GenerateParams:
    base = dict(prompt="a red lighthouse at dusk", width=256, height=192, steps=8, seed=42)
    base.update(kw)
    return GenerateParams(**base)


async def test_simulated_contract():
    evs = await collect(SimulatedProvider(step_ms=0), P())
    prog = [e for e in evs if e.type == "progress"]
    assert [e.data["step"] for e in prog] == list(range(1, 9))
    assert all(e.data["total_steps"] == 8 and e.data["preview_b64_jpeg"] for e in prog)
    assert evs[-1].type == "final" and evs[-1].image_png and evs[-1].data["seed"] == 42
    assert sum(e.type == "final" for e in evs) == 1


async def test_simulated_preview_every():
    evs = await collect(SimulatedProvider(step_ms=0), P(steps=10, preview_every=3))
    assert [e.data["step"] for e in evs if e.type == "progress"] == [3, 6, 9, 10]


def test_procedural_is_deterministic_and_prompt_dependent():
    a = np.asarray(procedural_image("cat", 1, 64, 64))
    b = np.asarray(procedural_image("cat", 1, 64, 64))
    c = np.asarray(procedural_image("dog", 1, 64, 64))
    assert (a == b).all() and not (a == c).all()


def test_simulation_converges_to_target():
    t = procedural_image("x", 3, 128, 128)
    rng = np.random.default_rng(0)
    err = [np.abs(np.asarray(simulate_step(t, s, rng), float) - np.asarray(t, float)).mean() for s in (0.1, 0.5, 1.0)]
    assert err[0] > err[1] > err[2] and err[2] < 1.0


async def test_simulated_cancel_stops():
    cancel = asyncio.Event()
    out = []
    async for e in SimulatedProvider(step_ms=0).generate(P(steps=20), cancel):
        out.append(e)
        if len(out) == 3:
            cancel.set()
    assert len(out) == 3 and all(e.type == "progress" for e in out)


def test_validation_limits():
    with pytest.raises(ValueError):
        P(steps=500)
    with pytest.raises(ValueError):
        P(width=2048, height=2048)
    with pytest.raises(ValueError):
        P(prompt="   ")
    with pytest.raises(ValueError):
        P(width=250)


# ---- DiffusersProvider with a mocked pipeline (no GPU, no torch) ----

class FakeOut:
    def __init__(self, img): self.images = [img]


class FakePipe:
    """Mimics diffusers' callback_on_step_end contract."""

    def __init__(self, fail: Exception | None = None):
        self.fail = fail
        self.calls = {}
        self._interrupt = False

    def __call__(self, **kw):
        self.calls = kw
        if self.fail:
            raise self.fail
        cb = kw["callback_on_step_end"]
        assert kw["callback_on_step_end_tensor_inputs"] == ["latents"]
        for i in range(kw["num_inference_steps"]):
            if self._interrupt:
                break
            cb(self, i, 999 - i, {"latents": np.full((1, 4, 8, 8), i, np.float32)})
        return FakeOut(Image.new("RGB", (kw["width"], kw["height"]), "blue"))


def make(pipe, decoded):
    def decode(lat, w, h):
        decoded.append(float(lat.mean()))
        return Image.new("RGB", (w // 8, h // 8), "gray")
    return DiffusersProvider("stabilityai/sdxl-turbo", loader=lambda: Loaded(pipe, decode, False))


async def test_diffusers_previews_via_taesd_callback():
    decoded: list[float] = []
    pipe = FakePipe()
    evs = await collect(make(pipe, decoded), P(steps=6, preview_every=2, negative_prompt="blurry"))
    steps = [e.data["step"] for e in evs if e.type == "progress"]
    assert steps == [2, 4, 6]          # 2,4 from TAESD; 6 = full-VAE final frame
    assert decoded == [1.0, 3.0]       # preview decoder only ran on sampled steps, never for the final
    assert evs[-1].type == "final" and evs[-1].image_png
    assert pipe.calls["negative_prompt"] == "blurry"


async def test_diffusers_cancel_interrupts_pipeline():
    pipe = FakePipe()
    cancel = asyncio.Event()
    cancel.set()
    evs = await collect(make(pipe, []), P(steps=6), cancel)
    assert pipe._interrupt is True and not any(e.type == "final" for e in evs)


async def test_diffusers_oom_is_human_readable():
    class OutOfMemoryError(RuntimeError):
        pass
    with pytest.raises(ProviderError) as ei:
        await collect(make(FakePipe(fail=OutOfMemoryError("CUDA out of memory")), []), P())
    assert ei.value.code == "oom" and "ran out of memory" in ei.value.message


def test_taesd_choice():
    assert default_taesd_for("stabilityai/sdxl-turbo") == "madebyollin/taesdxl"
    assert default_taesd_for("black-forest-labs/FLUX.1-schnell") == "madebyollin/taef1"
    assert default_taesd_for("runwayml/stable-diffusion-v1-5") == "madebyollin/taesd"
