"""Provider registry."""
from __future__ import annotations

from ..config import Settings
from ..events import ProviderError
from .base import ImageProvider
from .diffusers_provider import DiffusersProvider
from .fal_provider import FalStreamingProvider
from .openai_provider import OpenAIStreamingProvider
from .simulated import SimulatedProvider

__all__ = ["ImageProvider", "Registry", "SimulatedProvider", "DiffusersProvider",
           "OpenAIStreamingProvider", "FalStreamingProvider"]


class Registry:
    def __init__(self, settings: Settings) -> None:
        self.providers: dict[str, ImageProvider] = {
            "simulated": SimulatedProvider(step_ms=settings.sim_step_ms),
            "diffusers": DiffusersProvider(settings.diffusers_model, settings.diffusers_taesd, settings.diffusers_device),
            "openai": OpenAIStreamingProvider(lambda: settings.openai_key, settings.openai_model),
            "fal": FalStreamingProvider(lambda: settings.fal_key),
        }

    def describe(self) -> list[dict[str, object]]:
        out = []
        for p in self.providers.values():
            ok, why = p.configured()
            out.append({"name": p.name, "label": p.model_label, "real_preview": p.real_preview,
                        "configured": ok, "reason": why})
        return out

    def resolve(self, name: str) -> ImageProvider:
        p = self.providers.get(name)
        if p is None:
            raise ProviderError(f"Unknown provider '{name}'.", code="invalid", recoverable=False)
        ok, why = p.configured()
        if not ok:
            raise ProviderError(why, code="not_configured", recoverable=False)
        return p
