import type { RunRequest } from "@sgz/shared";
import { openAlert } from "../notify/alert.js";

export class RunStoppedError extends Error {
  constructor() {
    super("run stopped by request");
    this.name = "RunStoppedError";
  }
}

export const isStop = (e: unknown): boolean => e instanceof Error && e.name === "RunStoppedError";

/** setTimeout-based sleep that resolves early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whole-word match (titles): "cto" must not hit "Artifactory", "лид" not "валидация". */
export function containsWord(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    const w = n.trim().toLowerCase();
    if (!w) continue;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\p{L}\\d])${esc}($|[^\\p{L}\\d])`, "iu").test(haystack)) return n;
  }
  return null;
}

export function containsAny(haystack: string, needles: string[]): string | null {
  const h = haystack.toLowerCase();
  for (const n of needles) {
    const w = n.trim().toLowerCase();
    if (w && h.includes(w)) return n;
  }
  return null;
}

/** "от 150 000 до 200 000 ₽" → {from:150000, to:200000, currency:"RUR"} */
export function parseSalary(raw: string): { from: number; to: number; currency: string } {
  const nums = (raw.match(/\d[\d\s ]*/g) ?? []).map((s) => Number(s.replace(/[\s ]/g, ""))).filter((n) => n > 0);
  const currency = /₽|руб|rur|rub/i.test(raw) ? "RUR" : /\$|usd/i.test(raw) ? "USD" : /€|eur/i.test(raw) ? "EUR" : "";
  const lower = raw.toLowerCase();
  const from = nums[0] ?? 0;
  const to = nums[1] ?? 0;
  if (nums.length === 1 && /^\s*до/.test(lower)) return { from: 0, to: from, currency };
  return { from, to, currency };
}

const BACKGROUND_STAGES = new Set(["rotate", "touch"]);
/** Longer than the touch cadence (TOUCH_EVERY_MS, 4h05m): an expired login must not alert on every touch. */
const REPEAT_ALERT_MS = 6 * 3600_000;

/** Autopilot runs repeat every few minutes: the same failure (e.g. an expired hh login) is reported
 * once per 6h instead of on every poll. Manual and full runs always report. Digits are ignored so
 * "run #51"/timings don't make the same error look new. */
export function repeatFailure(store: { getSetting(key: string): string | null; setSetting(key: string, value: string): void }, req: RunRequest, error: string, now: Date): boolean {
  if (req.trigger !== "schedule" || !BACKGROUND_STAGES.has(req.stage ?? "")) return false;
  return !openAlert(store, `alert_last:${error.replace(/\d+/g, "#").slice(0, 80)}`, { ttlMs: REPEAT_ALERT_MS, now });
}
