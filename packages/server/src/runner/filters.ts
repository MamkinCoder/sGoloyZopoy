// Cheap pre-LLM classification shared by the hh and career pipelines.
import { normalizeDedup, Status, type Profile, type Source, type Store, type User, type Vacancy } from "@sgz/shared";
import { containsAny } from "./util.js";

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

export type Classification = { kind: "candidate" } | { kind: "sent" } | { kind: "skip"; status: Status; detail: string };

export function classify(store: Store, user: User, profile: Profile, v: Vacancy, dedupSinceISO: string): Classification {
  if (store.hasSentApplication(user.id, v.id)) return { kind: "sent" };
  const word = containsAny(v.title, profile.exclude_words);
  if (word) return { kind: "skip", status: Status.SKIP_FILTER, detail: `exclude word: ${word}` };
  const company = containsAny(v.company, profile.company_blacklist);
  if (company) return { kind: "skip", status: Status.SKIP_FILTER, detail: `company blacklist: ${company}` };
  if (v.dedupHash && store.hasRecentApplicationByDedup(user.id, v.dedupHash, dedupSinceISO)) return { kind: "skip", status: Status.SKIP_DEDUP, detail: "same company+title applied recently" };
  return { kind: "candidate" };
}

export const isoDaysAgo = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();
