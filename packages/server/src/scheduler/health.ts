// Dead-man heartbeat for `sgz serve`: alert once when no run has finished "done" for too long,
// and once more when one does again. Covers failure modes nothing else reports (scheduler silent,
// every run failing for a new reason, runner wedged).
import type { Notifier, Store } from "@sgz/shared";
import { alertIsOpen, alertOnce, closeAlert } from "../notify/alert.js";
import { shortStamp } from "./tz.js";

const HEARTBEAT_STALE_MS = 26 * 3600_000;
const KEY = "alert_open:heartbeat";

const heartbeatStale = (store: Pick<Store, "lastRunAt">, bootAt: Date, now: Date): boolean => {
  const last = store.lastRunAt("done");
  return now.getTime() - (last ? Date.parse(last) : bootAt.getTime()) > HEARTBEAT_STALE_MS;
};

/** True when checkHeartbeat would alert or recover (the agent enqueues the check only then). */
export const heartbeatChanged = (store: Pick<Store, "lastRunAt" | "getSetting">, bootAt: Date, now: Date): boolean => heartbeatStale(store, bootAt, now) !== alertIsOpen(store, KEY);

/** `bootAt` is the baseline only when no run ever finished, so a fresh install gets a full window. */
export async function checkHeartbeat(store: Store, notifier: Notifier, bootAt: Date, tz: string, now = new Date()): Promise<void> {
  const last = store.lastRunAt("done");
  if (heartbeatStale(store, bootAt, now))
    await alertOnce(store, notifier, KEY, { now, title: "Нет успешных прогонов", body: last ? `последний успешный: ${shortStamp(new Date(last), tz)}` : "успешных прогонов ещё не было" });
  else await closeAlert(store, KEY, notifier, () => ({ title: "✅ Прогоны снова в норме", body: `последний успешный: ${shortStamp(new Date(last ?? now), tz)}` }));
}

export const CHAT_STALL_MS = 20 * 60_000;
const CHAT_KEY = "alert_open:chats";

/** True when checkChatStall would alert or recover (the agent enqueues the check only then). */
export const chatStallChanged = (store: Pick<Store, "getSetting">, lastDoneAt: number, now: number): boolean => now - lastDoneAt > CHAT_STALL_MS !== alertIsOpen(store, CHAT_KEY);

/** Chat bot stall: one alert when no chat poll finished `done` for 20 min, one more when polls resume.
 *  `lastDoneAt` = end of the last successful poll (or boot, when none yet). */
export async function checkChatStall(store: Store, notifier: Notifier, lastDoneAt: number, tz: string, now = Date.now()): Promise<void> {
  if (now - lastDoneAt > CHAT_STALL_MS)
    await alertOnce(store, notifier, CHAT_KEY, { now: new Date(now), title: `Чаты не проверялись ${Math.round((now - lastDoneAt) / 60_000)} мин`, body: "бот не отвечает работодателям, проверь логи и вход в hh.ru" });
  else await closeAlert(store, CHAT_KEY, notifier, (open) => ({ title: "✅ Чаты снова проверяются", body: `тревога была с ${shortStamp(new Date(open), tz)}` }));
}
