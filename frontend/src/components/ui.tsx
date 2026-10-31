import type { ReactNode } from 'react';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between text-[11px] uppercase tracking-wider text-zinc-500">
        {label}{hint ? <span className="normal-case tracking-normal text-zinc-400 font-mono">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export const inputCls =
  'w-full rounded-md border border-line bg-black/40 px-2.5 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-amber/70 focus:ring-1 focus:ring-amber/40 disabled:opacity-50';

export function Btn({ children, onClick, kind = 'ghost', disabled, title, type = 'button', testId, className = '' }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; title?: string;
  type?: 'button' | 'submit'; testId?: string; className?: string;
}) {
  const k = kind === 'primary'
    ? 'bg-amber text-black font-semibold hover:bg-amber/90 shadow-[0_0_24px_-6px_rgba(255,179,71,.6)]'
    : kind === 'danger' ? 'border border-red-500/40 text-red-300 hover:bg-red-500/10'
      : 'border border-line text-zinc-300 hover:border-zinc-500 hover:text-white';
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} data-testid={testId}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${k} ${className}`}>
      {children}
    </button>
  );
}

export function Ring({ value, size = 44 }: { value: number; size?: number }) {
  const r = size / 2 - 4, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="-rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,.12)" strokeWidth="3" fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke="#ffb347" strokeWidth="3" fill="none" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - value)} style={{ transition: 'stroke-dashoffset .25s ease-out' }} />
    </svg>
  );
}
