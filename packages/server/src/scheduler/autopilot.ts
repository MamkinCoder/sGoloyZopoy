// What the serve loop starts next when the runner is idle: chats first (employers are waiting), then the
// 4-hourly resume raise, then a short career chunk. One job per tick keeps the single runner shared.
export type AutopilotJob = { kind: "chats" } | { kind: "touch" } | { kind: "career"; userSlug: string } | null;

export const TOUCH_EVERY_MS = 4 * 3600_000 + 5 * 60_000;

export interface AutopilotState {
  now: number;
  lastChatPoll: number;
  chatPollMs: number;
  /** ISO of the last touch run, "" if never. */
  touchLastAt: string;
  careerOn: boolean;
  /** First user with career budget and unvisited sites today, or null. Called only when needed. */
  careerDue: () => string | null;
}

export function nextJob(s: AutopilotState): AutopilotJob {
  if (s.now - s.lastChatPoll >= s.chatPollMs) return { kind: "chats" };
  if (s.now - Date.parse(s.touchLastAt || "1970-01-01") >= TOUCH_EVERY_MS) return { kind: "touch" };
  if (!s.careerOn) return null;
  const userSlug = s.careerDue();
  return userSlug ? { kind: "career", userSlug } : null;
}
