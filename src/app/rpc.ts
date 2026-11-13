/** Typed calls into the processing worker. */
import type { Cmd, Commands, Request, Response } from '../worker/protocol';

export type ProgressFn = (p: { done: number; total: number; note?: string }) => void;

const worker = new Worker(new URL('../worker/worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: ProgressFn }>();

worker.onmessage = (e: MessageEvent<Response>) => {
  const m = e.data;
  const p = pending.get(m.id);
  if (!p) return;
  if (m.progress) { p.onProgress?.(m.progress); return; }
  pending.delete(m.id);
  if (m.error) p.reject(new Error(m.error));
  else p.resolve(m.result);
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message || 'Ошибка обработки'));
  pending.clear();
};

export function call<C extends Cmd>(cmd: C, args: Commands[C]['args'], onProgress?: ProgressFn, transfer: Transferable[] = []): Promise<Commands[C]['result']> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    worker.postMessage({ id, cmd, args } satisfies Request<C>, transfer);
  });
}
