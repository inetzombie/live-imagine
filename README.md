# Live Imagine: live diffusion preview

Type a prompt, press **Generate**, and watch the image form on a live canvas: noise, then blurry colour blobs, then shapes, then detail. Previews stream over Server-Sent Events and are crossfaded on a `<canvas>`, so the canvas is never blank and never just shows a spinner.

**Live (zero setup, Simulated mode):** https://live-imagine.vercel.app

```
┌──────────── frontend/ (React + TS + Vite + Tailwind) ────────────┐
│ LiveCanvas: DPR canvas, letterbox, 200 ms rAF crossfade, deblur, │
│ grain · HUD · timeline replay (60-frame ring) · WebM/GIF/PNG export│
└──────┬─────────────────────┬──────────────────────┬──────────────┘
       │ EventSource (SSE)    │ fetch-stream (SSE)    │ Web Worker
┌──────▼────────────┐ ┌──────▼──────────────┐ ┌──────▼───────────────┐
│ backend/ FastAPI   │ │ api/ Vercel funcs    │ │ in-browser Simulated │
│ queue + providers: │ │ openai / fal, one    │ │ (used when no        │
│ simulated·diffusers│ │ request per run      │ │ backend, e.g. Vercel)│
│ openai·fal         │ └─────────────────────┘ └──────────────────────┘
└────────────────────┘
```

## Modes

| Mode | Where | Needs | Previews |
|---|---|---|---|
| **Simulated** (default) | FastAPI `SimulatedProvider`, or the in-browser worker on Vercel | nothing | **Fake.** A procedural image is put through decaying noise, 8px-to-full upscaling and blur-to-sharp. It is labelled **Simulated** everywhere. |
| **Local GPU** | FastAPI `DiffusersProvider` | CUDA GPU, `requirements-gpu.txt` | Real latents decoded by TAESD |
| **API: OpenAI** | FastAPI `OpenAIStreamingProvider` or Vercel `api/stream.js` | `OPENAI_API_KEY` | Real partial images (up to 3 plus the final) |
| **API: fal.ai** (extra) | FastAPI `FalStreamingProvider` or Vercel `api/stream.js` | `FAL_KEY` | Whatever images fal's `/stream` emits |

### 1. CPU / Simulated mode (no GPU, no keys)
```bash
make dev                # FastAPI on :8000 + Vite on :5173 → open http://localhost:5173
# or: docker compose up --build
```
You can also run it without make: `cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/uvicorn app.main:app --port 8000`, then in another terminal run `cd frontend && npm ci && npx vite`.
If no backend is reachable, the frontend falls back to the in-browser simulator, and the header says **Browser only**.

### 2. Local GPU mode
```bash
make gpu                                         # pip install torch/diffusers into backend/.venv
DIFFUSERS_MODEL=stabilityai/sdxl-turbo make dev   # or black-forest-labs/FLUX.1-schnell (needs HF_TOKEN + license)
# docker: docker compose --profile gpu up backend-gpu frontend   (needs nvidia-container-toolkit)
```
Pick **Local GPU (diffusers)** in the provider dropdown. SDXL-Turbo works well with 1–4 steps and guidance 0. The tiny VAE is chosen automatically: `taesdxl` for SDXL, `taef1` for FLUX, `taesd3` for SD3 and `taesd` for SD1.x. You can override it with `DIFFUSERS_TAESD`. `DIFFUSERS_DEVICE=cpu` works but is very slow.

### 3. API mode
* **Local backend:** `OPENAI_API_KEY=sk-... make dev` (and/or `FAL_KEY=...`).
* **Vercel:** add the variables in Project → Settings → Environment Variables, then redeploy (`vercel env add OPENAI_API_KEY production && vercel --prod`). **Also set `LIVE_PASSCODE`** so strangers with the link can't spend your credits. The UI then asks for the passcode before any paid provider runs.

Keys are read only on the server (`backend/` or `api/`). They never reach the browser and are never committed (`.env*` is git-ignored; see `.env.example`).

## How latent previews work, and why TAESD makes them fast
A latent diffusion model never denoises pixels. It denoises a small latent tensor, for SDXL 4×128×128 for a 1024² image, and only the VAE decoder turns that into an image. diffusers' `callback_on_step_end` hands us the current latents after each step, so we can show the image "so far". But decoding with the real VAE costs about as much as a denoising step (hundreds of ms and gigabytes of activations at 1024²), so previewing every step would roughly halve generation speed. **TAESD** (Tiny AutoEncoder for Stable Diffusion, `AutoencoderTiny`) is a ~1M-parameter distilled decoder trained to map the same latent space to approximately the same RGB. It decodes in a few milliseconds with negligible memory, so we can afford a preview every N steps. We downscale the preview to 512px, encode it as JPEG q=70 and stream it. The full VAE runs exactly once, for the final image.

## API (FastAPI backend)
| | |
|---|---|
| `POST /generate` | body `GenerateParams` → `{job_id, provider, queue_position}`. Returns 422 on invalid input (max steps 60, max 1,572,864 px, multiples of 8, prompt ≤ 2000 chars) and 503 if the provider isn't configured. |
| `GET /stream/{job_id}` | SSE: `meta`, `queue {position}`, `progress {step,total_steps,elapsed_ms,preview_b64_jpeg,width,height}`, `final {image_url,seed,params}`, `error {message,recoverable,code}`. Each event has an `id:`. Reconnects send `Last-Event-ID` and resume after it. |
| `POST /cancel/{job_id}` | Stops the job: diffusers is interrupted via `pipe._interrupt`, then `torch.cuda.empty_cache()` runs. |
| `GET /images/{job_id}.png` | Final image |
| `GET /health` | Provider list with `configured` and `reason` |

**Backpressure:** each job keeps a capped event log (60 frames). A subscriber that falls behind gets only the newest pending `progress` frame; `queue`, `final` and `error` are always delivered. There is one worker, which means one GPU job at a time, and queued jobs receive `queue` position updates.

Error codes map to specific messages and a Retry button: `oom` (GPU out of memory), `rate_limit` (API 429), `network` (dropped connection, after 5 failed EventSource reconnects), `not_configured`, `upstream`, `invalid` and `cancelled`.

## Hosted on Vercel
Vercel functions keep no memory between requests, so the in-memory job queue can't run there. The hosted site therefore uses:
* **Simulated:** runs entirely in the browser (Web Worker + OffscreenCanvas, frames transferred as `ImageBitmap`s). It is the same algorithm as `SimulatedProvider`.
* **OpenAI / fal:** `POST /api/stream?provider=…` streams the normalized SSE events in a single request. There is no Last-Event-ID resume, because nothing persists to resume from.
* **Local GPU:** shown as "not configured", because Vercel has no GPU.

## Frontend features
Live canvas at devicePixelRatio, letterboxed · `createImageBitmap` decode (off the main thread) · 200 ms rAF crossfade · deblur settle (canvas `blur()` eased from 12px to 0) · film grain that fades with progress · HUD (progress ring, Step n/N, elapsed, steps/s, seed, model, **Real preview / Simulated** badge) · timeline scrubber with play/pause and 0.5x/1x/2x replay (60-frame ring buffer; evicted bitmaps are `close()`d) · PNG download, WebM export (MediaRecorder on `canvas.captureStream`), animated GIF export (built-in encoder: per-frame median-cut palette + LZW, no dependencies), copy params as JSON · history drawer (localStorage, 30 runs, thumbnails) · seed dice and lock · regenerate with the same seed · aspect presets · preview-frequency slider · provider dropdown.
**Shortcuts:** ⌘/Ctrl+Enter generate · Esc cancel · Space play/pause the replay · F fullscreen. `prefers-reduced-motion` disables the crossfade and grain.

## Tests
```bash
make test            # everything below
make test-backend    # pytest: providers (incl. DiffusersProvider with a mocked pipeline), SSE, backpressure, API, cancel, queue
make test-frontend   # tsc strict + vitest: SSE parser, event validation, frame ring buffer, history
make e2e             # Playwright: SimulatedProvider end to end (FastAPI + browser-only), asserts canvas pixels change over time
```
To use an installed Chrome instead of downloading Chromium, run `PW_CHROME_PATH=/usr/bin/google-chrome npx playwright test`.

## Layout
```
backend/app/        main.py (routes) · jobs.py (queue, event log, resume) · sse.py · events.py · schemas.py · config.py
backend/app/providers/  base.py · simulated.py · diffusers_provider.py · openai_provider.py · fal_provider.py
backend/tests/      pytest
frontend/src/       App.tsx · shared/events.ts (wire types) · lib/{transport,sse,renderer,frames,history,record,procedural}.ts · workers/sim.worker.ts
frontend/tests/unit vitest · frontend/e2e Playwright
api/                Vercel functions: health.js, stream.js
docker-compose.yml · Makefile · .env.example
```

## How to verify it works
1. Open https://live-imagine.vercel.app, or run `make dev` and open http://localhost:5173.
2. Click **Generate**. Within about 1 s the canvas shows coloured noise, which then resolves into blobs, then shapes, then a sharp image. The badge says **Simulated**.
3. Watch the HUD: the Step counter, elapsed time and steps/s rise, and the ring fills.
4. Press **Esc** mid-run. It stops, says "Cancelled", and the frames so far stay scrubbable.
5. After a run, drag the timeline or press **Space** to replay it. Try 0.5x and 2x.
6. **⬇ PNG** downloads the final image, **⬇ WebM** downloads a video of the formation, and **⬇ GIF** downloads it as an animated GIF (384 px long side).
7. Open **History** and click a thumbnail. The prompt and params (seed locked) are reloaded.
8. Choose **OpenAI gpt-image** in the provider dropdown without a key. You should see a "Not configured… set OPENAI_API_KEY" note and Generate should be disabled.
9. Run `make test`. All pytest, vitest and Playwright tests should pass.

MIT © 2026 der_zuhalter

## Simulated mode scenes

The in-browser Simulated mode paints a procedural scene picked from prompt keywords: ocean, city, forest, desert, mountains or space, with a dusk, night, day or neon mood (for example "cyberpunk city at night" or "lighthouse on the ocean at sunset"). Prompts with none of the keywords get a scene chosen from the prompt hash, so the same prompt and seed always give the same picture. The noise it starts from is a fixed low-resolution "latent" that stays the same between steps and fades on a cosine schedule, so shapes appear first and detail last. It is still a simulation, not a diffusion model. The FastAPI backend's Simulated provider still uses the older, simpler scene.
