// Cheap pre-LLM classification shared by the hh and career pipelines.
import { blockedTech } from "../llm/guards.js";
import { companyKey, normalizeDedup, Status, type NewApplication, type Profile, type Source, type Store, type User, type Vacancy } from "@sgz/shared";
import { containsAny, containsWord } from "./util.js";

export type NewVacancy = Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt">;

export function skeletonVacancy(source: Source, externalId: string, url: string, title: string, company: string, salary?: { from: number; to: number; currency: string }): NewVacancy {
  return {
    source,
    externalId,
    url,
    title,
    company,
    salaryFrom: salary?.from ?? 0,
    salaryTo: salary?.to ?? 0,
    currency: salary?.currency ?? "",
    descriptionText: "",
    hasTest: false,
    requiresLetter: false,
    area: "",
    workFormat: "",
    publishedAt: null,
    archived: false,
    dedupHash: normalizeDedup(company, title),
  };
}

/** Existing row wins (so a search card never clobbers a fetched description); otherwise insert the skeleton. */
export function ensureVacancy(store: Store, v: NewVacancy): Vacancy {
  return store.findVacancyByExternal(v.source, v.externalId) ?? store.upsertVacancy(v);
}

export type Classification =
  | { kind: "candidate"; companyKey: string; lockedDirection: string }
  | { kind: "sent" }
  | { kind: "skip"; status: Status; detail: string };

/** Settings for the per-company spam limiter (packages/server/src/runner/hh.ts / career.ts read these). */
export interface CompanyLimitSettings {
  maxSent: number; // company_limit_max; 0 = disabled
  windowDays: number; // company_limit_window_days
  personaLockEnabled: boolean; // company_limit_persona_lock
}

/**
 * Tracks per-company counts and locked CV direction *within one run*, on top of what's already in the
 * DB, so e.g. a single search page returning 5 Ozon vacancies doesn't blow past the remaining quota
 * before any of them are persisted. One instance per user run.
 */
export interface RunCompanyTracker {
  /** Sent-or-about-to-send count so far this run for `key` (DB count is added by the caller). */
  count(key: string): number;
  /** Direction locked in this run for `key`, if any (DB lock is checked separately by the caller). */
  lockedDirection(key: string): string;
  /** Reserve one slot for `key`, optionally recording the CV direction used. Call once a candidate is approved. */
  reserve(key: string, direction: string): void;
}

export function createRunCompanyTracker(): RunCompanyTracker {
  const counts = new Map<string, number>();
  const directions = new Map<string, string>();
  return {
    count: (key) => counts.get(key) ?? 0,
    lockedDirection: (key) => directions.get(key) ?? "",
    reserve(key, direction) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (direction && !directions.has(key)) directions.set(key, direction);
    },
  };
}

export interface ClassifyOpts {
  dedupSinceISO: string;
  rejectSinceISO: string; // window for "LLM already rejected this vacancy" re-ask skip
  company: CompanyLimitSettings;
  companySinceISO: string;
  runTracker: RunCompanyTracker;
}

export function classify(store: Store, user: User, profile: Profile, v: Vacancy, o: ClassifyOpts): Classification {
  if (store.hasSentApplication(user.id, v.id)) return { kind: "sent" };
  const word = containsWord(v.title, profile.exclude_words);
  if (word) return { kind: "skip", status: Status.SKIP_FILTER, detail: `exclude word: ${word}` };
  const blacklisted = containsAny(v.company, profile.company_blacklist);
  if (blacklisted) return { kind: "skip", status: Status.SKIP_FILTER, detail: `company blacklist: ${blacklisted}` };
  if (v.dedupHash && store.hasRecentApplicationByDedup(user.id, v.dedupHash, o.dedupSinceISO)) return { kind: "skip", status: Status.SKIP_DEDUP, detail: "same company+title applied recently" };
  if (store.hasRecentRejection(user.id, v.id, o.rejectSinceISO)) return { kind: "skip", status: Status.SKIP_DEDUP, detail: "LLM already rejected this vacancy recently" };

  const key = companyKey(v.company);
  if (!key) return { kind: "candidate", companyKey: key, lockedDirection: "" };
  const lockedDirection = store.companyLockDirection(user.id, key, o.companySinceISO) || o.runTracker.lockedDirection(key);
  if (o.company.maxSent > 0) {
    const total = store.countRecentApplicationsByCompany(user.id, key, o.companySinceISO) + o.runTracker.count(key);
    if (total >= o.company.maxSent) return { kind: "skip", status: Status.SKIP_COMPANY_LIMIT, detail: `company limit reached: ${total}/${o.company.maxSent} sent in ${o.company.windowDays}d` };
  }
  return { kind: "candidate", companyKey: key, lockedDirection: o.company.personaLockEnabled ? lockedDirection : "" };
}

/** Rough title relevance, used to fetch the best candidates first when a site lists more than the budget:
 * +2 per search word of the profile (go, golang, backend...), -3 when the title names an unverified stack (C#, Java...). */
export function titleScore(title: string, profile: Pick<Profile, "hh_queries" | "verified_skills" | "never_claim_skills">): number {
  let score = 0;
  for (const q of profile.hh_queries) if (containsWord(title, [q])) score += 2;
  if (containsWord(title, blockedTech(profile))) score -= 3;
  return score;
}

/** Records a filter skip unless the vacancy's newest row already says the same: re-seen listings don't pile up rows. */
export function recordSkip(store: Store, a: NewApplication): void {
  const last = store.lastApplication(a.userId, a.vacancyId);
  if (last && last.status === a.status && last.reasonDetail === a.reasonDetail) return;
  store.insertApplication(a);
}

export const isoDaysAgo = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();

const settingInt = (store: Store, key: string, fallback: number): number => {
  const n = Number(store.getSetting(key));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** company_limit_max=10, company_limit_window_days=30, company_limit_persona_lock=on by default. */
export function companyLimitSettings(store: Store): CompanyLimitSettings {
  return {
    maxSent: settingInt(store, "company_limit_max", 10),
    windowDays: settingInt(store, "company_limit_window_days", 30),
    personaLockEnabled: store.getSetting("company_limit_persona_lock") !== "0",
  };
}

/** How long an LLM rejection of a specific vacancy blocks re-asking about it. Same window as dedup by default. */
export function rejectWindowDays(store: Store, fallback: number): number {
  return settingInt(store, "reject_window_days", fallback);
}
