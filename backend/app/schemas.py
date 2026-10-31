"""Request validation. Mirrors shared/events.ts on the frontend."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

from .config import get_settings

ProviderName = Literal["simulated", "diffusers", "openai", "fal"]


class GenerateParams(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    negative_prompt: str = Field(default="", max_length=1000)
    width: int = Field(default=768, ge=64, le=2048)
    height: int = Field(default=768, ge=64, le=2048)
    steps: int = Field(default=30, ge=1, le=150)
    guidance: float = Field(default=4.0, ge=0.0, le=20.0)
    seed: Optional[int] = Field(default=None, ge=0, le=2**32 - 1)
    preview_every: int = Field(default=1, ge=1, le=20)
    provider: ProviderName = "simulated"

    @model_validator(mode="after")
    def _limits(self) -> "GenerateParams":
        s = get_settings()
        if not self.prompt.strip():
            raise ValueError("prompt must not be blank")
        if self.steps > s.max_steps:
            raise ValueError(f"steps must be <= {s.max_steps}")
        if self.width * self.height > s.max_pixels:
            raise ValueError(f"width*height must be <= {s.max_pixels} pixels")
        if self.width % 8 or self.height % 8:
            raise ValueError("width and height must be multiples of 8")
        return self


class GenerateResponse(BaseModel):
    job_id: str
    provider: str
    queue_position: int
