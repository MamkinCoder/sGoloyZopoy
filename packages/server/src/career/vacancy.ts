import { normalizeDedup } from "@sgz/shared";
import type { Vacancy } from "@sgz/shared";
import { truncate } from "./http.js";

export type VacancyDraft = Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt">;

export const DESCRIPTION_MAX = 8000;

type RequiredKeys = "source" | "externalId" | "url" | "title" | "company";

/** Fill defaults, cap the description and compute dedupHash from the final company+title. */
export function makeVacancy(p: Pick<VacancyDraft, RequiredKeys> & Partial<Omit<VacancyDraft, RequiredKeys | "dedupHash">>): VacancyDraft {
  const title = p.title.trim();
  const company = p.company.trim();
  return {
    source: p.source,
    externalId: p.externalId,
    url: p.url,
    title,
    company,
    salaryFrom: p.salaryFrom ?? 0,
    salaryTo: p.salaryTo ?? 0,
    currency: p.currency ?? "",
    descriptionText: truncate((p.descriptionText ?? "").trim(), DESCRIPTION_MAX),
    hasTest: p.hasTest ?? false,
    requiresLetter: p.requiresLetter ?? false,
    area: p.area ?? "",
    workFormat: p.workFormat ?? "",
    publishedAt: p.publishedAt ?? null,
    archived: p.archived ?? false,
    dedupHash: normalizeDedup(company, title),
  };
}

export function toISO(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
