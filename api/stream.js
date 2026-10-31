// Hosted API providers in ONE streaming request (Vercel functions keep no state between requests).
// POST /api/stream?provider=openai|fal  → text/event-stream of normalized progress/final/error events.
import { httpError, providers, readBody, sse, sseParser, validate } from './_shared.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'invalid', message: 'POST only' });
  const name = String(req.query.provider || '');
  const info = providers().find((p) => p.name === name);
  if (!info) return res.status(400).json({ error: 'invalid', message: `Unknown provider '${name}'.` });
  if (!info.configured) return res.status(503).json({ error: 'not_configured', message: info.reason });
  const pass = process.env.LIVE_PASSCODE;
  if (pass && req.headers['x-live-passcode'] !== pass) return res.status(401).json({ error: 'invalid', message: 'Wrong or missing passcode.' });
  const [p, err] = validate(readBody(req));
  if (!p) return res.status(422).json({ error: 'invalid', message: err });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  sse(res, 'meta', { provider: name, model: info.label, real_preview: true });
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    if (name === 'openai') await runOpenAI(p, res, ac.signal);
    else await runFal(p, res, ac.signal);
  } catch (e) {
    if (!ac.signal.aborted) sse(res, 'error', e && e.code ? e : { code: 'network', message: `Upstream connection dropped: ${e?.message || e}`, recoverable: true });
  }
  res.end();
}

async function runOpenAI(p, res, signal) {
  const ratio = p.width / p.height;
  const size = ratio > 1.2 ? '1536x1024' : ratio < 0.83 ? '1024x1536' : '1024x1024';
  const [w, h] = size.split('x').map(Number);
  const t0 = Date.now(); const total = 4;
  const up = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', n: 1, size, stream: true, partial_images: 3,
      output_format: 'jpeg', output_compression: 85,
      prompt: p.prompt + (p.negative_prompt ? `\nAvoid: ${p.negative_prompt}` : '') }),
  });
  if (!up.ok || !up.body) throw httpError(up.status, await up.text().catch(() => ''), 'OpenAI');
  const feed = sseParser(); const dec = new TextDecoder();
  for await (const chunk of up.body) {
    for (const { data } of feed(dec.decode(chunk, { stream: true }))) {
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === 'error' || (ev.error && !ev.b64_json)) throw { code: 'upstream', message: `OpenAI: ${ev.error?.message || JSON.stringify(ev).slice(0, 200)}`, recoverable: true };
      if (!ev.b64_json) continue;
      const ms = Date.now() - t0;
      if (String(ev.type).endsWith('partial_image')) {
        sse(res, 'progress', { step: (ev.partial_image_index ?? 0) + 1, total_steps: total, elapsed_ms: ms, preview_b64_jpeg: ev.b64_json, width: w, height: h });
      } else if (String(ev.type).endsWith('completed')) {
        sse(res, 'progress', { step: total, total_steps: total, elapsed_ms: ms, preview_b64_jpeg: ev.b64_json, width: w, height: h });
        sse(res, 'final', { image_url: `data:image/jpeg;base64,${ev.b64_json}`, seed: p.seed ?? 0, params: p });
        return;
      }
    }
  }
  throw { code: 'upstream', message: 'OpenAI stream ended without a final image.', recoverable: true };
}

function imageRefs(o, out = []) {
  if (typeof o === 'string') { if (o.startsWith('data:image')) out.push(o); }
  else if (Array.isArray(o)) o.forEach((v) => imageRefs(v, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (k === 'url' && typeof v === 'string') out.push(v); else imageRefs(v, out);
  }
  return out;
}

async function toB64(ref, signal) {
  if (ref.startsWith('data:')) return ref.split(',', 2)[1];
  const r = await fetch(ref, { signal });
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

async function runFal(p, res, signal) {
  const body = { prompt: p.prompt + (p.negative_prompt ? `. Avoid: ${p.negative_prompt}` : ''),
    image_size: { width: p.width, height: p.height }, num_inference_steps: p.steps, guidance_scale: p.guidance,
    num_images: 1, enable_safety_checker: true, output_format: 'jpeg' };
  if (p.seed !== null) body.seed = p.seed;
  const t0 = Date.now();
  const up = await fetch('https://fal.run/fal-ai/flux/dev/stream', {
    method: 'POST', signal, body: JSON.stringify(body),
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  });
  if (!up.ok || !up.body) throw httpError(up.status, await up.text().catch(() => ''), 'fal.ai');
  const feed = sseParser(); const dec = new TextDecoder();
  const seen = new Set(); let last = null; let frames = 0; let seed = p.seed ?? 0;
  for await (const chunk of up.body) {
    for (const { event, data } of feed(dec.decode(chunk, { stream: true }))) {
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (event === 'error') throw { code: 'upstream', message: `fal.ai: ${JSON.stringify(ev).slice(0, 300)}`, recoverable: true };
      if (Number.isInteger(ev?.seed)) seed = ev.seed;
      for (const ref of imageRefs(ev)) {
        if (seen.has(ref)) continue; seen.add(ref);
        last = await toB64(ref, signal); frames++;
        sse(res, 'progress', { step: Math.min(frames, p.steps), total_steps: p.steps, elapsed_ms: Date.now() - t0, preview_b64_jpeg: last, width: p.width, height: p.height });
      }
    }
  }
  if (!last) throw { code: 'upstream', message: 'fal.ai returned no image.', recoverable: true };
  sse(res, 'final', { image_url: `data:image/jpeg;base64,${last}`, seed, params: p });
}
