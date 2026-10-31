"""Single-worker job queue (one GPU => one job at a time) with a capped,
resumable event log per job."""
from __future__ import annotations

import asyncio
import collections
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

from .events import Event, ProviderError
from .providers.base import ImageProvider
from .schemas import GenerateParams

TERMINAL = {"final", "error"}


@dataclass
class Job:
    id: str
    params: GenerateParams
    provider: ImageProvider
    max_frames: int
    log: collections.deque = field(init=False)
    next_id: int = 1
    done: bool = False
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    image_png: bytes | None = None
    created: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        # Capped: progress frames beyond the cap fall off; terminal events are appended last so always present.
        self.log = collections.deque(maxlen=self.max_frames + 4)

    async def emit(self, type_: str, data: dict[str, Any]) -> None:
        async with self.changed:
            self.log.append((self.next_id, type_, data))
            self.next_id += 1
            if type_ in TERMINAL:
                self.done = True
            self.changed.notify_all()


class JobManager:
    def __init__(self, resolve: Callable[[str], ImageProvider], *, max_frames: int = 60, max_jobs_kept: int = 50) -> None:
        self._resolve = resolve
        self.max_frames = max_frames
        self.max_jobs_kept = max_jobs_kept
        self.jobs: dict[str, Job] = {}
        self.queue: collections.deque[Job] = collections.deque()
        self._wake = asyncio.Event()
        self._worker: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._worker:
            self._worker.cancel()
            try:
                await self._worker
            except (asyncio.CancelledError, Exception):
                pass

    async def submit(self, params: GenerateParams) -> Job:
        provider = self._resolve(params.provider)  # raises ProviderError(not_configured)
        job = Job(secrets.token_urlsafe(9), params, provider, self.max_frames)
        self.jobs[job.id] = job
        self._gc()
        self.queue.append(job)
        await job.emit("queue", {"position": len(self.queue) - 1})
        self._wake.set()
        self.start()
        return job

    def position(self, job: Job) -> int:
        try:
            return list(self.queue).index(job)
        except ValueError:
            return 0

    async def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.done:
            return False
        job.cancel.set()
        if job in self.queue:
            self.queue.remove(job)
            await job.emit("error", {"message": "Cancelled.", "recoverable": True, "code": "cancelled"})
            await self._announce_positions()
        return True

    def _gc(self) -> None:
        if len(self.jobs) <= self.max_jobs_kept:
            return
        for jid, j in sorted(self.jobs.items(), key=lambda kv: kv[1].created):
            if len(self.jobs) <= self.max_jobs_kept:
                break
            if j.done:
                del self.jobs[jid]

    async def _announce_positions(self) -> None:
        for i, j in enumerate(list(self.queue)):
            await j.emit("queue", {"position": i})

    async def _run(self) -> None:
        while True:
            if not self.queue:
                self._wake.clear()
                await self._wake.wait()
                continue
            job = self.queue[0]
            await job.emit("queue", {"position": 0})
            try:
                await self._execute(job)
            finally:
                if self.queue and self.queue[0] is job:
                    self.queue.popleft()
                await self._announce_positions()

    async def _execute(self, job: Job) -> None:
        try:
            async for ev in job.provider.generate(job.params, job.cancel):
                if job.cancel.is_set():
                    break
                await self._publish(job, ev)
                if ev.type in TERMINAL:
                    return
            if job.cancel.is_set():
                await job.emit("error", {"message": "Cancelled.", "recoverable": True, "code": "cancelled"})
            elif not job.done:
                await job.emit("error", {"message": "Provider ended without a final image.", "recoverable": True, "code": "upstream"})
        except ProviderError as e:
            await job.emit("error", {"message": e.message, "recoverable": e.recoverable, "code": e.code})
        except Exception as e:  # noqa: BLE001 - surface anything else as a readable error
            await job.emit("error", {"message": f"Unexpected error: {e}", "recoverable": True, "code": "upstream"})
        finally:
            await job.provider.release()

    async def _publish(self, job: Job, ev: Event) -> None:
        data = dict(ev.data)
        if ev.type == "final":
            job.image_png = ev.image_png
            data["image_url"] = f"/images/{job.id}.png"
        await job.emit(ev.type, data)

    async def subscribe(self, job: Job, last_id: int = 0) -> AsyncIterator[tuple[int, str, dict[str, Any]]]:
        from .sse import select_pending

        while True:
            async with job.changed:
                batch = select_pending(list(job.log), last_id)
                if not batch:
                    if job.done:
                        return
                    try:
                        await asyncio.wait_for(job.changed.wait(), timeout=15)
                    except asyncio.TimeoutError:
                        yield (0, "ping", {})
                    continue
            for item in batch:
                last_id = item[0]
                yield item
                if item[1] in TERMINAL:
                    return
