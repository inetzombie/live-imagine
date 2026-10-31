/**
 * Shared wire types for the Live Imagine event stream.
 * The Python backend (backend/app/events.py, schemas.py) emits exactly these shapes;
 * the hosted Vercel functions (api/) emit the same normalized events.
 */

export type ProviderName = 'simulated' | 'diffusers' | 'openai' | 'fal';

export interface GenerateParams {
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed: number | null;
  preview_every: number;
  provider: ProviderName;
}

export interface ProgressEvent {
  type: 'progress';
  step: number;
  total_steps: number;
  elapsed_ms: number;
  /** Base64 image bytes (JPEG from the backend; PNG/JPEG passthrough from hosted APIs). */
  preview_b64_jpeg: string;
  width: number;
  height: number;
}
export interface FinalEvent { type: 'final'; image_url: string; seed: number; params: Partial<GenerateParams> }
export type ErrorCode = 'oom' | 'rate_limit' | 'not_configured' | 'upstream' | 'cancelled' | 'invalid' | 'network';
export interface ErrorEvent { type: 'error'; message: string; recoverable: boolean; code: ErrorCode }
export interface QueueEvent { type: 'queue'; position: number }
export interface MetaEvent { type: 'meta'; provider: string; model: string; real_preview: boolean }
export type StreamEvent = ProgressEvent | FinalEvent | ErrorEvent | QueueEvent | MetaEvent;

export interface ProviderInfo {
  name: ProviderName;
  label: string;
  real_preview: boolean;
  configured: boolean;
  reason: string;
}
export interface Health {
  mode: 'server' | 'hosted' | 'browser';
  providers: ProviderInfo[];
  default_provider?: string;
  limits?: { max_steps: number; max_pixels: number };
  passcode_required?: boolean;
}

export const LIMITS = { maxSteps: 60, maxPixels: 1536 * 1024, maxPrompt: 2000, maxNegative: 1000 } as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const CODES: readonly ErrorCode[] = ['oom', 'rate_limit', 'not_configured', 'upstream', 'cancelled', 'invalid', 'network'];

/** Runtime-validate one SSE event (name + JSON data). Returns null for unknown/malformed events. */
export function parseStreamEvent(name: string, raw: string): StreamEvent | null {
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!isObj(d)) return null;
  switch (name) {
    case 'progress':
      if (num(d.step) && num(d.total_steps) && num(d.elapsed_ms) && str(d.preview_b64_jpeg) && num(d.width) && num(d.height))
        return { type: 'progress', step: d.step, total_steps: d.total_steps, elapsed_ms: d.elapsed_ms, preview_b64_jpeg: d.preview_b64_jpeg, width: d.width, height: d.height };
      return null;
    case 'final':
      if (str(d.image_url) && num(d.seed)) return { type: 'final', image_url: d.image_url, seed: d.seed, params: isObj(d.params) ? (d.params as Partial<GenerateParams>) : {} };
      return null;
    case 'error': {
      const code = CODES.includes(d.code as ErrorCode) ? (d.code as ErrorCode) : 'upstream';
      return str(d.message) ? { type: 'error', message: d.message, recoverable: d.recoverable !== false, code } : null;
    }
    case 'queue':
      return num(d.position) ? { type: 'queue', position: d.position } : null;
    case 'meta':
      return str(d.provider) ? { type: 'meta', provider: d.provider, model: str(d.model) ? d.model : '', real_preview: d.real_preview === true } : null;
    default:
      return null;
  }
}

/** Client-side validation mirroring backend/app/schemas.py. Returns an error message or null. */
export function validateParams(p: GenerateParams): string | null {
  if (!p.prompt.trim()) return 'Enter a prompt.';
  if (p.prompt.length > LIMITS.maxPrompt) return `Prompt is too long (max ${LIMITS.maxPrompt} characters).`;
  if (p.negative_prompt.length > LIMITS.maxNegative) return `Negative prompt is too long (max ${LIMITS.maxNegative}).`;
  if (!Number.isInteger(p.steps) || p.steps < 1 || p.steps > LIMITS.maxSteps) return `Steps must be 1–${LIMITS.maxSteps}.`;
  if (p.width % 8 || p.height % 8) return 'Width and height must be multiples of 8.';
  if (p.width * p.height > LIMITS.maxPixels) return 'Image is too large.';
  if (p.guidance < 0 || p.guidance > 20) return 'Guidance must be 0–20.';
  if (p.seed !== null && (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 4294967295)) return 'Seed must be 0–4294967295.';
  if (!Number.isInteger(p.preview_every) || p.preview_every < 1 || p.preview_every > 20) return 'Preview frequency must be 1–20.';
  return null;
}

export const ASPECTS: Record<string, [number, number]> = {
  '1:1': [768, 768], '4:3': [896, 672], '3:4': [672, 896], '3:2': [912, 608], '16:9': [1024, 576], '9:16': [576, 1024],
};
