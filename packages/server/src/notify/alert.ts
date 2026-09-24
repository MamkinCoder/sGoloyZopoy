// One "alert once" for every repeating failure (agent job kinds, heartbeat, chat stall, autopilot run
// failures, Habr blocks). The open alert is a setting under `key`: an ISO time, "" = closed.
import type { Notifier, Store } from "@sgz/shared";

type Settings = Pick<Store, "getSetting" | "setSetting">;

export interface AlertWindow {
  /** Open for this long after it fired (then the next failure alerts again). Default: until closeAlert. */
  ttlMs?: number;
  /** Open until the UTC day ends. */
  day?: boolean;
  now?: Date;
}

/** Marks the alert under `key` open; false when it already is (deduped). */
export function openAlert(store: Settings, key: string, w: AlertWindow = {}): boolean {
  const now = w.now ?? new Date();
  const was = store.getSetting(key) ?? "";
  if (was) {
    if (w.day ? was.slice(0, 10) === now.toISOString().slice(0, 10) : w.ttlMs === undefined) return false;
    const at = Date.parse(was);
    if (w.ttlMs !== undefined && Number.isFinite(at) && now.getTime() - at < w.ttlMs) return false;
  }
  store.setSetting(key, now.toISOString());
  return true;
}

/** Sends `title`/`body` unless the alert under `key` is open. A failed send reopens nothing: the next call retries. */
export async function alertOnce(store: Settings, notifier: Pick<Notifier, "alert">, key: string, o: AlertWindow & { title: string; body: string }): Promise<boolean> {
  const was = store.getSetting(key) ?? "";
  if (!openAlert(store, key, o)) return false;
  try {
    await notifier.alert(o.title, o.body);
  } catch (e) {
    store.setSetting(key, was);
    throw e;
  }
  return true;
}

/** Closes an open alert; `recovery(openedAt)` is sent only when one was open. Returns whether it was. */
export async function closeAlert(store: Settings, key: string, notifier?: Pick<Notifier, "alert">, recovery?: (openedAt: string) => { title: string; body: string }): Promise<boolean> {
  const was = store.getSetting(key) ?? "";
  if (!was) return false;
  if (notifier && recovery) {
    const r = recovery(was);
    await notifier.alert(r.title, r.body);
  }
  store.setSetting(key, "");
  return true;
}

export const alertIsOpen = (store: Pick<Store, "getSetting">, key: string): boolean => !!store.getSetting(key);
