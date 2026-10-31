// Server-side proxy: keeps FAL_KEY off the client and relays fal's SSE stream.
export const config = { maxDuration: 60 };
const SIZES = { '1:1': 'square_hd', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.FAL_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured', message: 'API key not configured (FAL_KEY).' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const prompt = String(b.prompt || '').slice(0, 2000).trim();
  if (!prompt) return res.status(400).json({ error: 'empty_prompt' });
  const input = {
    prompt,
    image_size: SIZES[b.aspect] || 'square_hd',
    num_inference_steps: Math.min(50, Math.max(4, parseInt(b.steps) || 28)),
    guidance_scale: 3.5, num_images: 1, enable_safety_checker: true,
    output_format: 'png',
  };
  if (b.seed !== undefined && b.seed !== '' && !isNaN(+b.seed)) input.seed = +b.seed;
  // FLUX.1 [dev] has no negative-prompt input; we fold it in as an "avoid" hint.
  if (b.negative) input.prompt += `. Avoid: ${String(b.negative).slice(0, 500)}`;

  const up = await fetch('https://fal.run/fal-ai/flux/dev/stream', {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(input),
  });
  if (!up.ok || !up.body) {
    const t = await up.text().catch(() => '');
    return res.status(up.status || 502).json({ error: 'upstream', message: t.slice(0, 500) });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  const reader = up.body.getReader();
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
  } catch (e) { res.write(`event: error\ndata: ${JSON.stringify({ message: String(e) })}\n\n`); }
  res.end();
}
