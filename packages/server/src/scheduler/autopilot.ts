// What the serve loop starts next when the main runner slot is idle: the 4-hourly resume raise, then a short
// career chunk. Chat polls run in their own lane (commands/serve.ts), not here.
export type AutopilotJob = { kind: "touch" } | { kind: "career"; userSlug: string } | null;

export const TOUCH_EVERY_MS = 4 * 3600_000 + 5 * 60_000;

export interface AutopilotState {
  now: number;
  /** ISO of the last touch run, "" if never. */
  touchLastAt: string;
  careerOn: boolean;
  /** First user with career budget and unvisited sites today, or null. Called only when needed. */
  careerDue: () => string | null;
}

export function nextJob(s: AutopilotState): AutopilotJob {
  if (s.now - Date.parse(s.touchLastAt || "1970-01-01") >= TOUCH_EVERY_MS) return { kind: "touch" };
  if (!s.careerOn) return null;
  const userSlug = s.careerDue();
  return userSlug ? { kind: "career", userSlug } : null;
}
