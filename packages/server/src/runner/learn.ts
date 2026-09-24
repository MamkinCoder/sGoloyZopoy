// Outcome learning loop: advisory company / resume history for decide, and weekly letter lessons
// (invited vs. not invited letters → one haiku call → settings letter_lessons:<userId>).
import { companyKey, type DecideInput, type LLMClient, type LetterOutcome, type Store, type User, type Vacancy } from "@sgz/shared";
import { INTEL_MIN_SENT, RESUME_STATS_MIN_SENT, formatIntel, formatResumeStat } from "../db/intel.js";
import { blockedTech, enforceMax, normalizeProse, stripLinkSentences, stripNeverClaimSentences } from "../llm/guards.js";
import { kbForVacancy } from "../kb/context.js";
import { LessonsSchema } from "../llm/schemas.js";
import { renderPrompt } from "../llm/template.js";

export const LESSONS_MIN_INVITED = 5;
export const LESSONS_MIN_OTHER = 15;
const DAY_MS = 24 * 3600_000;
const REFRESH_MS = 7 * DAY_MS;
const SAMPLE_INVITED = 10;
const SAMPLE_OTHER = 15;
const LETTER_MAX = 700;

export const lessonsKey = (userId: number): string => `letter_lessons:${userId}`;

export interface StoredLessons {
  lessons: string[];
  /** Last refresh attempt (ISO), "" when never. A reset keeps it so lessons are not rebuilt at once. */
  at: string;
}

export function readLessons(store: Store, userId: number): StoredLessons {
  try {
    const v = JSON.parse(store.getSetting(lessonsKey(userId)) ?? "") as Partial<StoredLessons>;
    return { lessons: Array.isArray(v.lessons) ? v.lessons.filter((x) => typeof x === "string") : [], at: typeof v.at === "string" ? v.at : "" };
  } catch {
    return { lessons: [], at: "" };
  }
}

export const writeLessons = (store: Store, userId: number, v: StoredLessons): void => store.setSetting(lessonsKey(userId), JSON.stringify(v));

/** Enough outcomes on both sides to compare, or null. */
export function lessonSample(outcomes: LetterOutcome[]): { invited: LetterOutcome[]; other: LetterOutcome[] } | null {
  const invited = outcomes.filter((o) => o.invited);
  const other = outcomes.filter((o) => !o.invited);
  if (invited.length < LESSONS_MIN_INVITED || other.length < LESSONS_MIN_OTHER) return null;
  return { invited: invited.slice(0, SAMPLE_INVITED), other: other.slice(0, SAMPLE_OTHER) };
}

/** Style-only lessons: no links, nothing that names unverified or never-claim tech, ≤8 short lines. */
export function cleanLessons(raw: string[], profile: { verified_skills: string[]; never_claim_skills: string[] }): string[] {
  const blocked = blockedTech(profile);
  const out = raw.map((l) => enforceMax(stripNeverClaimSentences(stripLinkSentences(normalizeProse(l)), blocked), 200)).filter(Boolean);
  return [...new Set(out)].slice(0, 8);
}

/** Weekly: rebuild the user's letter lessons when enough outcomes exist. True when the LLM was called. */
export async function refreshLessons(store: Store, llm: LLMClient, user: User, now = new Date()): Promise<boolean> {
  const stored = readLessons(store, user.id);
  if (stored.at && now.getTime() - Date.parse(stored.at) < REFRESH_MS) return false;
  const profile = store.getProfile(user.id);
  const sample = profile && lessonSample(store.letterOutcomes(user.id, 300));
  if (!profile || !sample) return false;
  // ponytail: the attempt is stamped before the call, so a failed call retries next week, not every tick.
  writeLessons(store, user.id, { ...stored, at: now.toISOString() });
  const render = (xs: LetterOutcome[]) => xs.map((o) => `### ${o.title}\n${o.letter.slice(0, LETTER_MAX)}`).join("\n\n");
  const prompt = renderPrompt("learn_letters", {
    invited: render(sample.invited),
    invited_count: sample.invited.length,
    other: render(sample.other),
    other_count: sample.other.length,
  });
  const raw = await llm.json<unknown>("learn_letters", "fast", prompt, '{ "lessons": string[] }  // до 8 наблюдений');
  const lessons = cleanLessons(LessonsSchema.parse(raw).lessons, profile);
  writeLessons(store, user.id, { lessons, at: now.toISOString() });
  return true;
}

/** Telegram /company <name>: every active user's history with that employer. */
export function companyReport(store: Store, name: string): string {
  const key = companyKey(name);
  if (!key) return "Использование: /company <название компании>";
  const lines = store.listUsers(true).flatMap((u) => {
    const i = store.companyIntel(u.id, [key])[key];
    return i ? [`${u.name}: ${formatIntel(i)}`] : [];
  });
  return lines.length ? lines.join("\n") : `В «${name.trim()}» откликов ещё не было`;
}

/** Context for decide: employer history past the min-N gate, resume conversion, letter lessons, the KB per batch. */
export function decideExtras(store: Store, userId: number, vacancies: Vacancy[], now = new Date()): Pick<DecideInput, "companyHistory" | "resumeStats" | "lessons" | "kb"> {
  const intel = store.companyIntel(userId, vacancies.map((v) => companyKey(v.company)));
  const companyHistory = Object.fromEntries(Object.entries(intel).filter(([, i]) => i.sent >= INTEL_MIN_SENT).map(([k, i]) => [k, formatIntel(i)]));
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const resumeStats = store.resumeStats(userId, since).filter((r) => r.sent >= RESUME_STATS_MIN_SENT).map(formatResumeStat);
  return { companyHistory, resumeStats, lessons: readLessons(store, userId).lessons, kb: decideKb(store, userId) };
}

/** DecideInput.kb for this user: the KB block for each decide batch's vacancies. */
export const decideKb =
  (store: Store, userId: number): DecideInput["kb"] =>
  (vs) =>
    kbForVacancy(store, userId, vs);
