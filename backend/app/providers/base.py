"""The pluggable provider interface."""
from __future__ import annotations

import abc
import asyncio
from typing import AsyncIterator

from ..events import Event
from ..schemas import GenerateParams


class ImageProvider(abc.ABC):
    #: machine name used in the API / provider dropdown
    name: str = "base"
    #: shown in the HUD
    model_label: str = ""
    #: True when previews are real intermediate model states (not simulated)
    real_preview: bool = True

    def configured(self) -> tuple[bool, str]:
        """(ready, reason). reason is human readable when not ready."""
        return True, ""

    @abc.abstractmethod
    def generate(self, params: GenerateParams, cancel: asyncio.Event) -> AsyncIterator[Event]:
        """Yield `progress` events as the image forms, then exactly one `final`
        (or raise ProviderError). Must stop promptly once `cancel` is set."""

    async def release(self) -> None:
        """Free per-job resources (e.g. GPU cache) after a job ends or is cancelled."""
        return None
