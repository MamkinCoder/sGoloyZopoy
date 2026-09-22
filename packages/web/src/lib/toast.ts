export type ToastKind = "info" | "ok" | "error";
export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

type Listener = (items: ToastItem[]) => void;
let items: ToastItem[] = [];
let seq = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

export function pushToast(kind: ToastKind, text: string, ttlMs = kind === "error" ? 6000 : 3500) {
  const id = seq++;
  items = [...items, { id, kind, text }];
  emit();
  window.setTimeout(() => dismissToast(id), ttlMs);
}

export function dismissToast(id: number) {
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getToasts = () => items;

export const toast = {
  info: (t: string) => pushToast("info", t),
  ok: (t: string) => pushToast("ok", t),
  error: (t: string) => pushToast("error", t),
};
