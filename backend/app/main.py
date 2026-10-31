"""FastAPI app: POST /generate, GET /stream/{id} (SSE), POST /cancel/{id}."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .config import get_settings
from .events import ProviderError
from .jobs import JobManager
from .providers import Registry
from .schemas import GenerateParams, GenerateResponse
from .sse import format_sse, parse_last_event_id


def create_app(registry: Registry | None = None) -> FastAPI:
    settings = get_settings()
    reg = registry or Registry(settings)
    manager = JobManager(reg.resolve, max_frames=settings.frame_buffer, max_jobs_kept=settings.max_jobs_kept)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        manager.start()
        yield
        await manager.stop()

    app = FastAPI(title="Live Imagine", lifespan=lifespan)
    app.state.manager = manager
    app.state.registry = reg
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins.split(","),
                       allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(ProviderError)
    async def _perr(_: Request, e: ProviderError) -> JSONResponse:
        status = 503 if e.code == "not_configured" else 400
        return JSONResponse({"error": e.code, "message": e.message, "recoverable": e.recoverable}, status_code=status)

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {"mode": "server", "providers": reg.describe(), "default_provider": settings.default_provider,
                "limits": {"max_steps": settings.max_steps, "max_pixels": settings.max_pixels},
                "queue_length": len(manager.queue)}

    @app.post("/generate", response_model=GenerateResponse)
    async def generate(params: GenerateParams) -> GenerateResponse:
        job = await manager.submit(params)
        return GenerateResponse(job_id=job.id, provider=job.provider.name, queue_position=manager.position(job))

    @app.get("/stream/{job_id}")
    async def stream(job_id: str, request: Request,
                     last_event_id: str | None = Header(default=None, alias="Last-Event-ID")) -> StreamingResponse:
        job = manager.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "Unknown or expired job.")
        start = parse_last_event_id(last_event_id or request.query_params.get("lastEventId"))
        meta = {"provider": job.provider.name, "model": job.provider.model_label,
                "real_preview": job.provider.real_preview}

        async def body() -> AsyncIterator[str]:
            yield "retry: 1500\n\n"
            yield f"event: meta\ndata: {json.dumps(meta)}\n\n"
            async for eid, kind, data in manager.subscribe(job, start):
                if await request.is_disconnected():
                    return
                if kind == "ping":
                    yield ": ping\n\n"
                else:
                    yield format_sse(eid, kind, data)

        return StreamingResponse(body(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

    @app.post("/cancel/{job_id}")
    async def cancel(job_id: str) -> dict[str, bool]:
        if job_id not in manager.jobs:
            raise HTTPException(404, "Unknown or expired job.")
        return {"cancelled": await manager.cancel(job_id)}

    @app.get("/images/{job_id}.png")
    async def image(job_id: str) -> Response:
        job = manager.jobs.get(job_id)
        if job is None or job.image_png is None:
            raise HTTPException(404, "No image for this job.")
        return Response(job.image_png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})

    return app


app = create_app()
