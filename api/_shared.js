// Shared helpers for the hosted (Vercel) functions. Emits the same normalized SSE events as the FastAPI backend.
export const LIMITS = { maxSteps: 60, maxPixels: 1536 * 1024 };

export function providers() {
  return [
    { name: 'openai', label: `OpenAI ${process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'} (partial images)`, real_preview: true,
      configured: Boolean(process.env.OPENAI_API_KEY), reason: process.env.OPENAI_API_KEY ? '' : 'OpenAI not configured: set OPENAI_API_KEY in the Vercel project.' },
    { name: 'fal', label: 'FLUX.1 [dev] on fal.ai (stream)', real_preview: true,
      configured: Boolean(process.env.FAL_KEY), reason: process.env.FAL_KEY ? '' : 'fal.ai not configured: set FAL_KEY in the Vercel project.' },
    { name: 'diffusers', label: 'Local GPU (diffusers)', real_preview: true, configured: false,
      reason: 'Local GPU mode needs the FastAPI backend on a CUDA machine (see README); it cannot run on Vercel.' },
  ];
}

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export function validate(b) {
  const p = {
    prompt: String(b.prompt ?? ''), negative_prompt: String(b.negative_prompt ?? ''),
    width: Number(b.width), height: Number(b.height), steps: Number(b.steps), guidance: Number(b.guidance ?? 4),
    seed: b.seed === null || b.seed === undefined ? null : Number(b.seed), preview_every: Number(b.preview_every ?? 1),
  };
  if (!p.prompt.trim() || p.prompt.length > 2000) return [null, 'Prompt must be 1–2000 characters.'];
  if (p.negative_prompt.length > 1000) return [null, 'Negative prompt is too long.'];
  if (!Number.isInteger(p.steps) || p.steps < 1 || p.steps > LIMITS.maxSteps) return [null, `Steps must be 1–${LIMITS.maxSteps}.`];
  if (!Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width % 8 || p.height % 8 || p.width < 64 || p.height < 64) return [null, 'Width/height must be multiples of 8, at least 64.'];
  if (p.width * p.height > LIMITS.maxPixels) return [null, 'Image is too large.'];
  if (p.seed !== null && (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 4294967295)) return [null, 'Invalid seed.'];
  if (!(p.guidance >= 0 && p.guidance <= 20)) return [null, 'Guidance must be 0–20.'];
  return [p, null];
}

let nextId = 1;
export const sse = (res, event, data) => res.write(`id: ${nextId++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Incremental SSE parser for upstream streams. */
export function sseParser() {
  let buf = '';
  return (chunk) => {
    buf += chunk.replace(/\r\n?/g, '\n');
    const out = [];
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = 'message'; const data = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const c = line.indexOf(':'); const k = c < 0 ? line : line.slice(0, c);
        let v = c < 0 ? '' : line.slice(c + 1); if (v.startsWith(' ')) v = v.slice(1);
        if (k === 'event') event = v; else if (k === 'data') data.push(v);
      }
      if (data.length) out.push({ event, data: data.join('\n') });
    }
    return out;
  };
}

export function httpError(status, body, service) {
  if (status === 429) return { code: 'rate_limit', message: `${service} rate limit or quota reached. Wait a moment, then retry.`, recoverable: true };
  if (status === 401 || status === 403) return { code: 'not_configured', message: `${service} rejected the API key (${status}).`, recoverable: false };
  if (status === 400) return { code: 'invalid', message: `${service} refused the request: ${body.slice(0, 300)}`, recoverable: false };
  return { code: 'upstream', message: `${service} error ${status}: ${body.slice(0, 300)}`, recoverable: true };
}
