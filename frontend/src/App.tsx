import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ASPECTS, LIMITS, type ErrorCode, type GenerateParams, type ProviderInfo, type ProviderName, validateParams } from './shared/events';
import { type Backend, type RunHandle, type RunMsg, detectBackend, friendly } from './lib/transport';
import { FrameBuffer } from './lib/frames';
import { LiveCanvas } from './lib/renderer';
import { type HistoryItem, clearHistory, loadHistory, saveHistory, thumbnail } from './lib/history';
import { downloadBlob, recordWebM } from './lib/record';
import { Btn, Field, Ring, inputCls } from './components/ui';

type Status = 'idle' | 'connecting' | 'queued' | 'running' | 'done' | 'error';
interface RunState {
  status: Status; step: number; total: number; elapsedMs: number; queuePos: number; model: string; realPreview: boolean;
  seed: number | null; error: { code: ErrorCode; message: string; recoverable: boolean } | null; reconnecting: boolean; frames: number;
}
const IDLE: RunState = { status: 'idle', step: 0, total: 0, elapsedMs: 0, queuePos: 0, model: '', realPreview: false, seed: null, error: null, reconnecting: false, frames: 0 };
async function toPng(bmp: ImageBitmap): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')?.drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
}
const randomSeed = (): number => Math.floor(Math.random() * 4294967295);
const SPEEDS = [0.5, 1, 2] as const;
const PROVIDER_TITLE: Record<ProviderName, string> = { simulated: 'Simulated', diffusers: 'Local GPU (diffusers)', openai: 'OpenAI gpt-image', fal: 'fal.ai FLUX' };
const ENV_HINT: Record<ProviderName, string> = { simulated: '', diffusers: 'Run the FastAPI backend on a CUDA machine with requirements-gpu.txt.', openai: 'Set OPENAI_API_KEY.', fal: 'Set FAL_KEY.' };

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lcRef = useRef<LiveCanvas | null>(null);
  const frames = useRef(new FrameBuffer(60));
  const finalRef = useRef<{ blob: Blob; bitmap: ImageBitmap } | null>(null);
  const handleRef = useRef<RunHandle | null>(null);
  const runId = useRef(0);
  const t0 = useRef(0);
  const lastParams = useRef<GenerateParams | null>(null);
  const modelRef = useRef('');
  const endedRef = useRef(false);

  const [backend, setBackend] = useState<Backend | null>(null);
  const [prompt, setPrompt] = useState('a lighthouse on a cliff at dusk, glowing windows, cinematic');
  const [negative, setNegative] = useState('');
  const [steps, setSteps] = useState(30);
  const [guidance, setGuidance] = useState(4);
  const [seed, setSeed] = useState<string>(String(randomSeed()));
  const [seedLocked, setSeedLocked] = useState(false);
  const [aspect, setAspect] = useState('1:1');
  const [previewEvery, setPreviewEvery] = useState(1);
  const [provider, setProvider] = useState<ProviderName>('simulated');
  const [passcode, setPasscode] = useState(() => sessionStorage.getItem('live-imagine:pass') ?? '');
  const passRef = useRef(passcode);
  passRef.current = passcode;
  const [deblur, setDeblur] = useState(true);
  const [grain, setGrain] = useState(true);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [run, setRun] = useState<RunState>(IDLE);
  const [tick, setTick] = useState(0);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [drawer, setDrawer] = useState(false);
  const [recording, setRecording] = useState(false);
  const [toast, setToast] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const busy = run.status === 'connecting' || run.status === 'queued' || run.status === 'running';
  const providers: ProviderInfo[] = backend?.health.providers ?? [];
  const pinfo = providers.find((p) => p.name === provider);
  const [w, h] = ASPECTS[aspect] ?? [768, 768];

  // ---- setup ----
  useEffect(() => { void detectBackend(() => passRef.current).then(setBackend); }, []);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const lc = new LiveCanvas(c, { reducedMotion: reduced, deblur, grain });
    lcRef.current = lc;
    return () => lc.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (lcRef.current) lcRef.current.opts = { reducedMotion: reduced, deblur, grain }; }, [reduced, deblur, grain]);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const f = (): void => setReduced(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  useEffect(() => { if (!busy) lcRef.current?.setAspect(w, h); }, [w, h, busy]);
  useEffect(() => { sessionStorage.setItem('live-imagine:pass', passcode); }, [passcode]);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [busy]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 2200); return () => clearTimeout(id); }, [toast]);

  // ---- run ----
  const onMsg = useCallback((id: number, p: GenerateParams) => (m: RunMsg): void => {
    if (id !== runId.current) { if (m.kind === 'frame' && m.image instanceof ImageBitmap) m.image.close(); return; }
    switch (m.kind) {
      case 'connection':
        setRun((r) => ({ ...r, reconnecting: m.state === 'reconnecting', status: m.state === 'connecting' && r.status === 'idle' ? 'connecting' : r.status }));
        break;
      case 'meta': modelRef.current = m.model; setRun((r) => ({ ...r, model: m.model, realPreview: m.realPreview })); break;
      case 'queue': setRun((r) => ({ ...r, status: r.status === 'running' ? 'running' : 'queued', queuePos: m.position })); break;
      case 'frame': {
        const decode = m.image instanceof ImageBitmap ? Promise.resolve(m.image) : createImageBitmap(m.image);
        void decode.then((bmp) => {
          if (id !== runId.current) { bmp.close(); return; }
          frames.current.push({ bitmap: bmp, step: m.step, total: m.total, elapsedMs: m.elapsedMs });
          if (endedRef.current) return; // a late-decoding frame must not overwrite the final / cancelled view
          lcRef.current?.show(bmp, m.step / m.total);
          setRun((r) => ({ ...r, status: r.status === 'error' || r.status === 'done' ? r.status : 'running', step: m.step, total: m.total, elapsedMs: m.elapsedMs, frames: frames.current.length, reconnecting: false }));
          setIdx(frames.current.length - 1);
        }).catch(() => undefined);
        break;
      }
      case 'final':
        endedRef.current = true;
        void createImageBitmap(m.image).then(async (bmp) => {
          if (id !== runId.current) { bmp.close(); return; }
          finalRef.current = { blob: m.image.type === 'image/png' ? m.image : await toPng(bmp), bitmap: bmp };
          lcRef.current?.show(bmp, 1);
          lcRef.current?.setGenerating(false);
          const elapsed = performance.now() - t0.current;
          setRun((r) => ({ ...r, status: 'done', step: r.total || p.steps, total: r.total || p.steps, seed: m.seed, elapsedMs: Math.round(elapsed) }));
          setIdx(frames.current.length);
          const item: HistoryItem = { id: `${Date.now()}`, created: Date.now(), params: { ...p, seed: m.seed }, seed: m.seed, model: modelRef.current, thumb: await thumbnail(bmp), frames: frames.current.length };
          setHistory(saveHistory(item));
        });
        break;
      case 'error':
        endedRef.current = true;
        lcRef.current?.setGenerating(false);
        setRun((r) => ({ ...r, status: 'error', error: { code: m.code, message: m.message, recoverable: m.recoverable } }));
        setIdx(Math.max(0, frames.current.length - 1));
        break;
    }
  }, []);

  const buildParams = useCallback((override?: Partial<GenerateParams>): GenerateParams => {
    const s: number | null = override && 'seed' in override ? override.seed ?? null
      : seedLocked && seed.trim() !== '' ? Number(seed) : randomSeed();
    if (s !== null) setSeed(String(s));
    return { prompt, negative_prompt: negative, width: w, height: h, steps, guidance, preview_every: previewEvery, provider, ...override, seed: s };
  }, [prompt, negative, w, h, steps, guidance, seed, seedLocked, previewEvery, provider]);

  const start = useCallback((p: GenerateParams): void => {
    if (!backend) return;
    const err = validateParams(p);
    const info = backend.health.providers.find((x) => x.name === p.provider);
    if (err || !info?.configured) {
      setRun({ ...IDLE, status: 'error', error: { code: err ? 'invalid' : 'not_configured', message: err ?? `${PROVIDER_TITLE[p.provider]} is not configured here. ${info?.reason || ENV_HINT[p.provider]}`, recoverable: false } });
      return;
    }
    handleRef.current?.cancel();
    const id = ++runId.current;
    lastParams.current = p;
    setPlaying(false);
    const lc = lcRef.current;
    lc?.reset();
    frames.current.clear();
    finalRef.current?.bitmap.close();
    finalRef.current = null;
    lc?.setAspect(p.width, p.height);
    lc?.setGenerating(true);
    t0.current = performance.now();
    endedRef.current = false;
    setRun({ ...IDLE, status: 'connecting', total: p.steps });
    setIdx(0);
    handleRef.current = backend.transportFor(p.provider).run(p, onMsg(id, p));
    // On narrow screens the controls sit below the canvas: bring the canvas into view to watch it form.
    const stage = stageRef.current;
    if (stage && stage.getBoundingClientRect().top < 0) stage.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, [backend, onMsg, reduced]);

  const generate = useCallback((override?: Partial<GenerateParams>) => { if (!busy) start(buildParams(override)); }, [busy, start, buildParams]);
  const cancel = useCallback(() => { if (busy) handleRef.current?.cancel(); }, [busy]);
  const retry = useCallback(() => { if (lastParams.current) start(lastParams.current); }, [start]);
  const regenerateSame = useCallback(() => { if (run.seed !== null) { setSeedLocked(true); generate({ seed: run.seed }); } }, [run.seed, generate]);

  // ---- replay ----
  const replayable = !busy && frames.current.length > 0;
  const maxIdx = frames.current.length - (finalRef.current ? 0 : 1);
  const showIndex = useCallback((i: number, instant: boolean) => {
    const fb = frames.current;
    const lc = lcRef.current;
    if (!lc) return;
    if (i >= fb.length && finalRef.current) lc.show(finalRef.current.bitmap, 1, instant);
    else { const f = fb.at(i); if (f) lc.show(f.bitmap, f.step / f.total, instant); }
  }, []);
  useEffect(() => {
    if (!playing) return;
    if (idx >= maxIdx) { setPlaying(false); return; }
    const id = setTimeout(() => { const n = idx + 1; setIdx(n); showIndex(n, false); }, 180 / speed);
    return () => clearTimeout(id);
  }, [playing, idx, maxIdx, speed, showIndex]);
  const togglePlay = useCallback(() => {
    if (!replayable) return;
    if (!playing && idx >= maxIdx) { setIdx(0); showIndex(0, true); }
    setPlaying((p) => !p);
  }, [replayable, playing, idx, maxIdx, showIndex]);

  // ---- export ----
  const downloadPng = (): void => { if (finalRef.current) downloadBlob(finalRef.current.blob, `live-imagine-${run.seed ?? 'image'}.png`); };
  const downloadWebm = async (): Promise<void> => {
    const lc = lcRef.current;
    if (!lc || recording) return;
    setRecording(true); setPlaying(false);
    try { downloadBlob(await recordWebM(lc, frames.current.all(), finalRef.current?.bitmap ?? null, 180), `live-imagine-${run.seed ?? 'formation'}.webm`); }
    catch (e) { setToast((e as Error).message); }
    finally { setRecording(false); setIdx(maxIdx); }
  };
  const copyParams = async (): Promise<void> => {
    const p = lastParams.current;
    if (!p) return;
    const text = JSON.stringify({ ...p, seed: run.seed ?? p.seed, model: run.model }, null, 2);
    try { await navigator.clipboard.writeText(text); setToast('Params copied as JSON'); } catch { setToast('Clipboard blocked by the browser'); }
  };
  const fullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen(); else void el.requestFullscreen?.().catch(() => undefined);
  }, []);
  const loadItem = (it: HistoryItem): void => {
    const p = it.params;
    setPrompt(p.prompt); setNegative(p.negative_prompt); setSteps(p.steps); setGuidance(p.guidance);
    setSeed(String(it.seed)); setSeedLocked(true); setPreviewEvery(p.preview_every);
    const a = Object.entries(ASPECTS).find(([, v]) => v[0] === p.width && v[1] === p.height);
    if (a) setAspect(a[0]);
    if (providers.some((x) => x.name === p.provider)) setProvider(p.provider);
    setDrawer(false);
    setToast('Loaded prompt + params (seed locked)');
  };

  // ---- shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generate(); return; }
      if (e.key === 'Escape') { if (busy) { e.preventDefault(); cancel(); } else setDrawer(false); return; }
      if (typing) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fullscreen(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [generate, cancel, togglePlay, fullscreen, busy]);

  // ---- derived HUD ----
  void tick;
  const liveElapsed = busy ? performance.now() - t0.current : run.elapsedMs;
  const sps = run.step > 0 && run.elapsedMs > 0 ? (run.step / run.elapsedMs) * 1000 : 0;
  const progress = run.total ? run.step / run.total : 0;
  const scrubFrame = replayable ? frames.current.at(Math.min(idx, frames.current.length - 1)) : undefined;
  const isSim = pinfo ? !pinfo.real_preview : true;
  const badgeReal = run.status !== 'idle' ? run.realPreview : !isSim;
  const errorHelp: Partial<Record<ErrorCode, string>> = {
    oom: 'Lower the size or steps, then retry.',
    rate_limit: 'Wait a few seconds, then retry.',
    network: 'Check your connection, then retry. The stream resumes where it left off when it can.',
  };
  const modeLabel = useMemo(() => backend?.health.mode === 'server' ? 'FastAPI backend' : backend?.health.mode === 'hosted' ? 'Hosted (Vercel)' : backend ? 'Browser only' : 'Detecting…', [backend]);

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber shadow-[0_0_12px_#ffb347]" />
          <h1 className="text-[15px] font-semibold tracking-tight">Live Imagine</h1>
          <span className="hidden text-xs text-zinc-500 sm:inline">watch it form</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="hidden sm:inline" data-testid="mode">{modeLabel}</span>
          <Btn onClick={() => setDrawer(true)} testId="history-btn">History{history.length ? ` · ${history.length}` : ''}</Btn>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-4 p-3 sm:p-4 lg:grid-cols-[340px_1fr]">
        {/* ---------- stage ---------- */}
        <section className="order-1 min-w-0 lg:order-2">
          <div ref={stageRef} className="relative overflow-hidden rounded-xl border border-line bg-black">
            <canvas ref={canvasRef} data-testid="live-canvas" className="block h-[56vh] w-full sm:h-[66vh] lg:h-[calc(100dvh-210px)] lg:min-h-[440px]" />
            {/* badges */}
            <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap items-center gap-2">
              <span data-testid="badge" className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider backdrop-blur ${badgeReal ? 'border-phos/50 bg-phos/10 text-phos' : 'border-amber/60 bg-amber/10 text-amber'}`}>
                {badgeReal ? 'Real preview' : 'Simulated'}
              </span>
              {(run.model || pinfo?.label) ? <span className="rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] text-zinc-300 backdrop-blur">{run.model || pinfo?.label}</span> : null}
              {run.reconnecting ? <span className="rounded-full bg-yellow-500/20 px-2.5 py-0.5 text-[11px] text-yellow-300">Reconnecting…</span> : null}
            </div>
            {/* idle hint */}
            {run.status === 'idle' ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
                <div>
                  <div className="text-lg text-zinc-300">Type a prompt and press <b className="text-amber">Generate</b></div>
                  <div className="mt-1 text-xs text-zinc-500">Frames stream onto this canvas as the image forms · ⌘/Ctrl+Enter</div>
                </div>
              </div>
            ) : null}
            {run.status === 'queued' || run.status === 'connecting' ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className="rounded-lg bg-black/70 px-4 py-2 font-mono text-sm text-amber" data-testid="queue">
                  {run.status === 'queued' && run.queuePos > 0 ? `Queued · position ${run.queuePos}` : 'Starting…'}
                </div>
              </div>
            ) : null}
            {/* HUD */}
            {run.status !== 'idle' ? (
              <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-lg bg-black/60 px-3 py-2 font-mono text-xs text-zinc-300 backdrop-blur" data-testid="hud">
                <div className="relative grid place-items-center">
                  <Ring value={run.status === 'done' ? 1 : progress} />
                  <span className="absolute text-[10px] text-zinc-200">{Math.round((run.status === 'done' ? 1 : progress) * 100)}%</span>
                </div>
                <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
                  <span data-testid="hud-step">Step <b className="text-white">{scrubFrame && !playing && run.status === 'done' && idx < frames.current.length ? scrubFrame.step : run.step}/{run.total}</b></span>
                  <span>{(liveElapsed / 1000).toFixed(1)}s</span>
                  <span>{sps ? `${sps.toFixed(1)} steps/s` : '— steps/s'}</span>
                  <span className="truncate">seed {run.seed ?? lastParams.current?.seed ?? '—'}</span>
                </div>
                {busy ? <Btn kind="danger" onClick={cancel} testId="cancel">Cancel <kbd className="text-[10px] opacity-60">Esc</kbd></Btn> : null}
              </div>
            ) : null}
            <button onClick={fullscreen} title="Fullscreen (F)" className="absolute right-3 top-3 rounded-md bg-black/50 px-2 py-1 text-xs text-zinc-300 hover:text-white">⤢</button>
          </div>

          {/* error */}
          {run.error && run.error.code !== 'cancelled' ? (
            <div role="alert" data-testid="error" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              <b>{friendly(run.error.code)}</b>
              <span className="text-red-200/80">{run.error.message}</span>
              {errorHelp[run.error.code] ? <span className="text-red-200/60">{errorHelp[run.error.code]}</span> : null}
              {run.error.recoverable ? <Btn onClick={retry} className="ml-auto">Retry</Btn> : null}
            </div>
          ) : null}
          {run.error?.code === 'cancelled' ? <div className="mt-3 text-sm text-zinc-500">Cancelled. The frames received so far are kept below.</div> : null}

          {/* timeline + export */}
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
            <Btn onClick={togglePlay} disabled={!replayable} title="Play / pause replay (Space)" testId="play">{playing ? '❚❚' : '▶'}</Btn>
            <input type="range" aria-label="Timeline" data-testid="scrubber" className="min-w-[120px] flex-1 accent-amber"
              min={0} max={Math.max(0, maxIdx)} value={Math.min(idx, Math.max(0, maxIdx))} disabled={!replayable}
              onChange={(e) => { const i = Number(e.target.value); setPlaying(false); setIdx(i); showIndex(i, true); }} />
            <span className="w-24 text-right font-mono text-[11px] text-zinc-500">{replayable ? `frame ${Math.min(idx, maxIdx) + 1}/${maxIdx + 1}` : `${run.frames} frames`}</span>
            <div className="flex overflow-hidden rounded-md border border-line">
              {SPEEDS.map((s) => (
                <button key={s} onClick={() => setSpeed(s)} className={`px-2 py-1.5 text-xs ${speed === s ? 'bg-amber/20 text-amber' : 'text-zinc-400 hover:text-white'}`}>{s}x</button>
              ))}
            </div>
            <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
              <Btn onClick={downloadPng} disabled={!finalRef.current || busy} testId="download">⬇ PNG</Btn>
              <Btn onClick={() => void downloadWebm()} disabled={!replayable || recording} testId="webm">{recording ? 'Recording…' : '⬇ WebM'}</Btn>
              <Btn onClick={() => void copyParams()} disabled={!lastParams.current}>Copy JSON</Btn>
              <Btn onClick={regenerateSame} disabled={busy || run.seed === null} title="Regenerate with the same seed">↻ Same seed</Btn>
            </div>
          </div>
        </section>

        {/* ---------- controls ---------- */}
        <form className="order-2 space-y-3 lg:order-1" onSubmit={(e) => { e.preventDefault(); generate(); }}>
          <Field label="Prompt" hint={`${prompt.length}/${LIMITS.maxPrompt}`}>
            <textarea data-testid="prompt" className={`${inputCls} min-h-[92px] resize-y`} maxLength={LIMITS.maxPrompt} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe an image…" />
          </Field>
          <Field label="Negative prompt">
            <input className={inputCls} maxLength={LIMITS.maxNegative} value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="blurry, text, watermark" />
          </Field>
          <Field label="Provider">
            <select data-testid="provider" className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value as ProviderName)}>
              {providers.map((p) => (
                <option key={p.name} value={p.name}>{PROVIDER_TITLE[p.name]}{p.configured ? '' : ' (not configured)'}</option>
              ))}
            </select>
          </Field>
          {pinfo && !pinfo.configured ? (
            <div data-testid="not-configured" className="rounded-md border border-line bg-black/40 px-3 py-2 text-xs text-zinc-400">
              <b className="text-zinc-200">Not configured.</b> {pinfo.reason || ENV_HINT[pinfo.name]} See the README. Simulated mode works without any setup.
            </div>
          ) : null}
          {backend?.health.passcode_required && provider !== 'simulated' ? (
            <Field label="Passcode"><input type="password" className={inputCls} value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="Required for paid providers" /></Field>
          ) : null}
          <Field label="Aspect ratio">
            <div className="grid grid-cols-6 gap-1">
              {Object.keys(ASPECTS).map((a) => (
                <button type="button" key={a} onClick={() => setAspect(a)} className={`rounded-md border px-1 py-1.5 text-xs ${aspect === a ? 'border-amber/70 bg-amber/10 text-amber' : 'border-line text-zinc-400 hover:text-white'}`}>{a}</button>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Steps" hint={String(steps)}>
              <input type="range" className="w-full accent-amber" min={1} max={LIMITS.maxSteps} value={steps} onChange={(e) => setSteps(Number(e.target.value))} />
            </Field>
            <Field label="Guidance" hint={guidance.toFixed(1)}>
              <input type="range" className="w-full accent-amber" min={0} max={20} step={0.5} value={guidance} onChange={(e) => setGuidance(Number(e.target.value))} />
            </Field>
          </div>
          <Field label="Seed">
            <div className="flex gap-1.5">
              <input data-testid="seed" inputMode="numeric" className={`${inputCls} font-mono`} value={seed} onChange={(e) => { setSeed(e.target.value.replace(/\D/g, '').slice(0, 10)); setSeedLocked(true); }} />
              <Btn onClick={() => setSeed(String(randomSeed()))} title="Random seed">🎲</Btn>
              <Btn onClick={() => setSeedLocked((l) => !l)} title={seedLocked ? 'Seed locked: reused every run' : 'Seed unlocked: new seed every run'} className={seedLocked ? 'border-amber/60 text-amber' : ''}>{seedLocked ? '🔒' : '🔓'}</Btn>
            </div>
          </Field>
          <button type="button" onClick={() => setShowAdvanced((s) => !s)} className="text-xs text-zinc-500 hover:text-zinc-300">{showAdvanced ? '▾' : '▸'} Preview & effects</button>
          {showAdvanced ? (
            <div className="space-y-3 rounded-md border border-line p-3">
              <Field label="Preview every N steps" hint={String(previewEvery)}>
                <input type="range" className="w-full accent-amber" min={1} max={10} value={previewEvery} onChange={(e) => setPreviewEvery(Number(e.target.value))} />
              </Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={deblur} onChange={(e) => setDeblur(e.target.checked)} /> Deblur settle</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={grain} onChange={(e) => setGrain(e.target.checked)} disabled={reduced} /> Film grain {reduced ? <span className="text-xs text-zinc-500">(off: reduced motion)</span> : null}</label>
            </div>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Btn type="submit" kind="primary" className="flex-1 py-2.5" disabled={busy || !backend || (pinfo !== undefined && !pinfo.configured)} testId="generate">
              {busy ? 'Imagining…' : 'Generate'} <kbd className="text-[10px] opacity-60">⌘↵</kbd>
            </Btn>
            {busy ? <Btn kind="danger" onClick={cancel}>Cancel</Btn> : null}
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Shortcuts: ⌘/Ctrl+Enter generate · Esc cancel · Space play/pause replay · F fullscreen.
            {isSim ? ' Simulated mode fakes the denoising look with a procedural image; it is not a diffusion model.' : ''}
          </p>
        </form>
      </main>

      {/* history drawer */}
      <div className={`fixed inset-0 z-30 transition ${drawer ? 'pointer-events-auto bg-black/50' : 'pointer-events-none'}`} onClick={() => setDrawer(false)}>
        <aside onClick={(e) => e.stopPropagation()} data-testid="drawer"
          className={`absolute right-0 top-0 h-full w-[min(360px,90vw)] overflow-y-auto border-l border-line bg-panel p-4 transition-transform duration-200 ${drawer ? 'translate-x-0' : 'translate-x-full'}`}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">History</h2>
            <div className="flex gap-2">
              <Btn onClick={() => { clearHistory(); setHistory([]); }} disabled={!history.length}>Clear</Btn>
              <Btn onClick={() => setDrawer(false)}>✕</Btn>
            </div>
          </div>
          {history.length === 0 ? <p className="text-sm text-zinc-500">Finished images appear here. Click one to reload its prompt and params.</p> : null}
          <div className="grid grid-cols-2 gap-2">
            {history.map((it) => (
              <button key={it.id} onClick={() => loadItem(it)} className="group overflow-hidden rounded-md border border-line text-left hover:border-amber/60">
                <img src={it.thumb} alt="" className="aspect-square w-full object-cover" />
                <div className="p-1.5 text-[11px] text-zinc-400"><div className="line-clamp-2 text-zinc-200">{it.params.prompt}</div><div className="font-mono">seed {it.seed}</div></div>
              </button>
            ))}
          </div>
        </aside>
      </div>
      {toast ? <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md bg-zinc-800 px-3 py-2 text-sm shadow-lg">{toast}</div> : null}
    </div>
  );
}
