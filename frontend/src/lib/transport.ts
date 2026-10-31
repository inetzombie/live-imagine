import { type ErrorCode, type GenerateParams, type Health, type ProviderInfo, type StreamEvent, parseStreamEvent } from '../shared/events';
import { SSEParser, b64ToBlob } from './sse';

/** A decoded-or-decodable preview frame plus its step metadata. */
export interface FrameMsg {
  kind: 'frame'; step: number; total: number; elapsedMs: number; width: number; height: number;
  image: Blob | ImageBitmap;
}
export interface FinalMsg { kind: 'final'; seed: number; image: Blob }
export interface ErrorMsg { kind: 'error'; code: ErrorCode; message: string; recoverable: boolean }
export interface QueueMsg { kind: 'queue'; position: number }
export interface MetaMsg { kind: 'meta'; model: string; realPreview: boolean }
export interface ConnMsg { kind: 'connection'; state: 'connecting' | 'open' | 'reconnecting' }
export type RunMsg = FrameMsg | FinalMsg | ErrorMsg | QueueMsg | MetaMsg | ConnMsg;

export interface RunHandle { cancel(): void; done: Promise<void> }
export interface Transport { readonly mode: Health['mode']; run(p: GenerateParams, on: (m: RunMsg) => void): RunHandle }

const FRIENDLY: Record<ErrorCode, string> = {
  oom: 'The GPU ran out of memory.',
  rate_limit: 'The image API is rate-limiting requests.',
  not_configured: 'This provider is not configured.',
  upstream: 'The image service returned an error.',
  cancelled: 'Cancelled.',
  invalid: 'The request was rejected.',
  network: 'The connection dropped.',
};
export const friendly = (code: ErrorCode): string => FRIENDLY[code];

async function finalBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not download the final image (${r.status}).`);
  return r.blob();
}

async function errorFromResponse(r: Response): Promise<ErrorMsg> {
  let message = `${r.status} ${r.statusText}`;
  let code: ErrorCode = r.status === 503 ? 'not_configured' : r.status === 429 ? 'rate_limit' : r.status >= 500 ? 'upstream' : 'invalid';
  try {
    const j: unknown = await r.json();
    if (typeof j === 'object' && j !== null) {
      const o = j as { message?: unknown; detail?: unknown; error?: unknown };
      if (typeof o.message === 'string') message = o.message;
      else if (Array.isArray(o.detail)) message = o.detail.map((d: { msg?: string }) => d.msg ?? '').join('; ');
      else if (typeof o.detail === 'string') message = o.detail;
      if (o.error === 'not_configured') code = 'not_configured';
    }
  } catch { /* non-JSON body */ }
  return { kind: 'error', code, message, recoverable: code !== 'not_configured' && code !== 'invalid' };
}

function toMsg(e: StreamEvent): RunMsg | null {
  switch (e.type) {
    case 'progress':
      return { kind: 'frame', step: e.step, total: e.total_steps, elapsedMs: e.elapsed_ms, width: e.width, height: e.height, image: b64ToBlob(e.preview_b64_jpeg) };
    case 'queue': return { kind: 'queue', position: e.position };
    case 'meta': return { kind: 'meta', model: e.model, realPreview: e.real_preview };
    case 'error': return { kind: 'error', code: e.code, message: e.message, recoverable: e.recoverable };
    case 'final': return null; // handled separately (needs a fetch)
  }
}

/** FastAPI backend: POST /generate, EventSource /stream/{id} (auto-reconnect with Last-Event-ID), POST /cancel/{id}. */
export class ServerTransport implements Transport {
  readonly mode = 'server' as const;
  constructor(private readonly base: string) {}

  run(p: GenerateParams, on: (m: RunMsg) => void): RunHandle {
    let jobId: string | null = null;
    let es: EventSource | null = null;
    let cancelled = false;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const finish = (): void => { es?.close(); es = null; resolveDone(); };

    void (async () => {
      on({ kind: 'connection', state: 'connecting' });
      let r: Response;
      try {
        r = await fetch(`${this.base}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      } catch {
        on({ kind: 'error', code: 'network', message: 'Could not reach the Live Imagine server.', recoverable: true });
        return finish();
      }
      if (!r.ok) { on(await errorFromResponse(r)); return finish(); }
      const { job_id } = (await r.json()) as { job_id: string };
      jobId = job_id;
      if (cancelled) void fetch(`${this.base}/cancel/${job_id}`, { method: 'POST' });
      let failures = 0;
      es = new EventSource(`${this.base}/stream/${job_id}`);
      es.onopen = () => { failures = 0; on({ kind: 'connection', state: 'open' }); };
      const handle = (name: string) => (ev: Event): void => {
        if (!(ev instanceof MessageEvent) || typeof ev.data !== 'string') {
          // Native EventSource error: the browser retries and resends Last-Event-ID automatically.
          if (name !== 'error') return;
          failures++;
          if (es && es.readyState !== EventSource.CLOSED && failures <= 5) { on({ kind: 'connection', state: 'reconnecting' }); return; }
          on({ kind: 'error', code: 'network', message: 'Lost the connection to the server and could not resume.', recoverable: true });
          return finish();
        }
        const parsed = parseStreamEvent(name, ev.data);
        if (!parsed) return;
        if (parsed.type === 'final') {
          void finalBlob(this.base + parsed.image_url.replace(/^\/?/, '/'))
            .then((image) => on({ kind: 'final', seed: parsed.seed, image }))
            .catch((err: Error) => on({ kind: 'error', code: 'network', message: err.message, recoverable: true }))
            .finally(finish);
          return;
        }
        const m = toMsg(parsed);
        if (m) on(m);
        if (parsed.type === 'error') finish();
      };
      for (const n of ['meta', 'queue', 'progress', 'final', 'error']) es.addEventListener(n, handle(n));
    })();

    return {
      cancel: () => {
        cancelled = true;
        if (jobId) void fetch(`${this.base}/cancel/${jobId}`, { method: 'POST' }).catch(() => undefined);
        // If the stream doesn't confirm quickly, close it ourselves.
        setTimeout(() => { if (es) { on({ kind: 'error', code: 'cancelled', message: 'Cancelled.', recoverable: true }); finish(); } }, 2500);
      },
      done,
    };
  }
}

/** Hosted (Vercel) API providers: one streaming POST per run, normalized SSE events. */
export class HostedApiTransport implements Transport {
  readonly mode = 'hosted' as const;
  constructor(private readonly passcode: () => string) {}

  run(p: GenerateParams, on: (m: RunMsg) => void): RunHandle {
    const ac = new AbortController();
    const done = (async () => {
      on({ kind: 'connection', state: 'connecting' });
      try {
        const r = await fetch(`/api/stream?provider=${encodeURIComponent(p.provider)}`, {
          method: 'POST', signal: ac.signal,
          headers: { 'Content-Type': 'application/json', 'X-Live-Passcode': this.passcode() },
          body: JSON.stringify(p),
        });
        if (!r.ok || !r.body) { on(await errorFromResponse(r)); return; }
        on({ kind: 'connection', state: 'open' });
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        const parser = new SSEParser();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          for (const raw of parser.feed(value)) {
            const ev = parseStreamEvent(raw.event, raw.data);
            if (!ev) continue;
            if (ev.type === 'final') { on({ kind: 'final', seed: ev.seed, image: await finalBlob(ev.image_url) }); return; }
            const m = toMsg(ev);
            if (m) on(m);
            if (ev.type === 'error') return;
          }
        }
        on({ kind: 'error', code: 'network', message: 'The stream ended before the final image arrived.', recoverable: true });
      } catch (e) {
        if (ac.signal.aborted) on({ kind: 'error', code: 'cancelled', message: 'Cancelled.', recoverable: true });
        else on({ kind: 'error', code: 'network', message: `Connection dropped: ${(e as Error).message}`, recoverable: true });
      }
    })();
    return { cancel: () => ac.abort(), done };
  }
}

/** In-browser SimulatedProvider (Web Worker + OffscreenCanvas). Used when no backend is running, e.g. on Vercel. */
export class BrowserSimTransport implements Transport {
  readonly mode = 'browser' as const;
  constructor(private readonly stepMs = 110) {}

  run(p: GenerateParams, on: (m: RunMsg) => void): RunHandle {
    const worker = new Worker(new URL('../workers/sim.worker.ts', import.meta.url), { type: 'module' });
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const end = (): void => { worker.terminate(); resolveDone(); };
    on({ kind: 'meta', model: 'Simulated (in-browser, procedural; not a model)', realPreview: false });
    on({ kind: 'connection', state: 'open' });
    worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const d = ev.data;
      if (d.type === 'frame') on({ kind: 'frame', step: d.step, total: d.total, elapsedMs: d.elapsedMs, width: d.width, height: d.height, image: d.bitmap });
      else if (d.type === 'final') { on({ kind: 'final', seed: d.seed, image: d.blob }); end(); }
      else { on({ kind: 'error', code: 'upstream', message: d.message, recoverable: true }); end(); }
    };
    worker.onerror = (e) => { on({ kind: 'error', code: 'upstream', message: `Simulator crashed: ${e.message}`, recoverable: true }); end(); };
    const msg: WorkerIn = { type: 'start', params: p, stepMs: this.stepMs };
    worker.postMessage(msg);
    return {
      cancel: () => { on({ kind: 'error', code: 'cancelled', message: 'Cancelled.', recoverable: true }); end(); },
      done,
    };
  }
}

export type WorkerIn = { type: 'start'; params: GenerateParams; stepMs: number };
export type WorkerOut =
  | { type: 'frame'; step: number; total: number; elapsedMs: number; width: number; height: number; bitmap: ImageBitmap }
  | { type: 'final'; seed: number; blob: Blob }
  | { type: 'error'; message: string };

const BROWSER_SIM: ProviderInfo = { name: 'simulated', label: 'Simulated (in-browser)', real_preview: false, configured: true, reason: '' };

async function getJson(url: string, ms = 2500): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

export interface Backend { health: Health; transportFor(p: ProviderInfo['name']): Transport }

/** Detect: FastAPI backend (/backend/health) → hosted Vercel functions (/api/health) → browser-only. */
export async function detectBackend(passcode: () => string): Promise<Backend> {
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/backend';
  const s = (await getJson(`${base}/health`)) as Health | null;
  if (s && s.mode === 'server' && Array.isArray(s.providers)) {
    const t = new ServerTransport(base);
    return { health: s, transportFor: () => t };
  }
  const h = (await getJson('/api/health')) as Health | null;
  const sim = new BrowserSimTransport();
  if (h && h.mode === 'hosted' && Array.isArray(h.providers)) {
    const api = new HostedApiTransport(passcode);
    return {
      health: { ...h, providers: [BROWSER_SIM, ...h.providers.filter((p) => p.name !== 'simulated')] },
      transportFor: (name) => (name === 'simulated' ? sim : api),
    };
  }
  return { health: { mode: 'browser', providers: [BROWSER_SIM] }, transportFor: () => sim };
}
