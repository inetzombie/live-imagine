"""Runtime configuration, read from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    default_provider: str = field(default_factory=lambda: os.environ.get("LIVE_DEFAULT_PROVIDER", "simulated"))
    max_steps: int = field(default_factory=lambda: _int("LIVE_MAX_STEPS", 60))
    max_pixels: int = field(default_factory=lambda: _int("LIVE_MAX_PIXELS", 1536 * 1024))
    frame_buffer: int = field(default_factory=lambda: _int("LIVE_FRAME_BUFFER", 60))
    max_jobs_kept: int = field(default_factory=lambda: _int("LIVE_MAX_JOBS_KEPT", 50))
    sim_step_ms: int = field(default_factory=lambda: _int("LIVE_SIM_STEP_MS", 120))
    diffusers_model: str = field(default_factory=lambda: os.environ.get("DIFFUSERS_MODEL", "stabilityai/sdxl-turbo"))
    diffusers_taesd: str = field(default_factory=lambda: os.environ.get("DIFFUSERS_TAESD", ""))
    diffusers_device: str = field(default_factory=lambda: os.environ.get("DIFFUSERS_DEVICE", "cuda"))
    openai_model: str = field(default_factory=lambda: os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-1"))
    cors_origins: str = field(default_factory=lambda: os.environ.get("LIVE_CORS_ORIGINS", "*"))

    @property
    def openai_key(self) -> str | None:
        return os.environ.get("OPENAI_API_KEY") or None

    @property
    def fal_key(self) -> str | None:
        return os.environ.get("FAL_KEY") or None


def get_settings() -> Settings:
    return Settings()
