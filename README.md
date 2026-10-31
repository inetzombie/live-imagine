# Live Imagine

Watch an image form in real time. Type a prompt, hit **Generate**, and the hero canvas is repainted in place with the
model's actual intermediate diffusion frames as they stream in (noise → structure → detail → final). Final PNG is downloadable;
history lives in your browser (IndexedDB).

## Model / API
**FLUX.1 [dev] on fal.ai, via its `/stream` endpoint** (`https://fal.run/fal-ai/flux/dev/stream`, Server-Sent Events).
Why: fal is the only major hosted API that exposes a streaming endpoint for Flux that pushes image events *during*
generation; Replicate streaming is for text tokens and its image predictions return only the final output, and Stability's
API returns final images only. Flux dev gives high quality at ~28 steps.
Notes: Flux dev has no native negative prompt, so the negative prompt is appended as an "Avoid: …" hint.
If fal sends only the final image for a request, the UI says so honestly; there is no fake progress bar.

## Setup
1. Get a key at https://fal.ai/dashboard/keys (fal is pay-as-you-go; FLUX.1 [dev] is roughly $0.025 per megapixel; check fal's pricing page).
2. In Vercel → project **live-imagine** → Settings → Environment Variables, add `FAL_KEY` = your key (Production + Preview), then redeploy.
   CLI: `vercel env add FAL_KEY production && vercel --prod`.
Without the key, the app loads and shows "API key not configured".

The key is read only in `api/generate.js` (a Vercel serverless function) and never reaches the browser or git.

## Run locally
```
npm i -g vercel
echo "FAL_KEY=your_key" > .env.local   # git-ignored
vercel dev
```
Open http://localhost:3000.

## Layout
`public/` static UI (vanilla HTML/CSS/JS) · `api/health.js` key-configured check · `api/generate.js` SSE proxy to fal.

MIT © 2026 der_zuhalter
