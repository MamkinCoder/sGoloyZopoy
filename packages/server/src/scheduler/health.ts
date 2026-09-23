// Dead-man heartbeat for `sgz serve`: alert once when no run has finished "done" for too long,
// and once more when one does again. Covers failure modes nothing else reports (scheduler silent,
// every run failing for a new reason, runner wedged).
import type { Notifier, Store } from "@sgz/shared";
import { shortStamp } from "./tz.js";

export const HEARTBEAT_STALE_MS = 26 * 3600_000;
const KEY = "alert_open:heartbeat";

/** `bootAt` is the baseline only when no run ever finished, so a fresh install gets a full window. */
export async function checkHeartbeat(store: Store, notifier: Notifier, bootAt: Date, tz: string, now = new Date()): Promise<void> {
  const last = store.lastRunAt("done");
  const since = last ? Date.parse(last) : bootAt.getTime();
  const stale = now.getTime() - since > HEARTBEAT_STALE_MS;
  const open = store.getSetting(KEY) ?? "";
  if (stale && !open) {
    await notifier.alert("Нет успешных прогонов", last ? `последний успешный: ${shortStamp(new Date(last), tz)}` : "успешных прогонов ещё не было");
    store.setSetting(KEY, now.toISOString());
  } else if (!stale && open) {
    await notifier.alert("✅ Прогоны снова в норме", `последний успешный: ${shortStamp(new Date(last ?? now), tz)}`);
    store.setSetting(KEY, "");
  }
}
