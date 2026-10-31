import type { GenerateParams } from '../shared/events';

export interface HistoryItem { id: string; created: number; params: GenerateParams; seed: number; model: string; thumb: string; frames: number }
const KEY = 'live-imagine:history:v2';
export const HISTORY_MAX = 30;

export function loadHistory(storage: Storage = localStorage): HistoryItem[] {
  try {
    const v: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? (v as HistoryItem[]).filter((x) => x && typeof x.id === 'string' && x.params) : [];
  } catch { return []; }
}

/** Prepend an item, cap the list, and shrink further if storage quota is hit. */
export function saveHistory(item: HistoryItem, storage: Storage = localStorage): HistoryItem[] {
  let list = [item, ...loadHistory(storage).filter((x) => x.id !== item.id)].slice(0, HISTORY_MAX);
  while (list.length) {
    try { storage.setItem(KEY, JSON.stringify(list)); return list; } catch { list = list.slice(0, -1); }
  }
  return list;
}

export function clearHistory(storage: Storage = localStorage): void { storage.removeItem(KEY); }

export async function thumbnail(bitmap: ImageBitmap, max = 160): Promise<string> {
  const s = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bitmap.width * s); c.height = Math.round(bitmap.height * s);
  c.getContext('2d')?.drawImage(bitmap, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}
