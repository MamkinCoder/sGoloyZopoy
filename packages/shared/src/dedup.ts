import { createHash } from "node:crypto";

const LEGAL_PREFIX = /^(ооо|ао|зао|пао|ип|оао|ано|llc|ltd|inc)\s+/i;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;
const LOCATION_PAREN = /\((удал[её]нно|remote|hybrid|гибрид|москва|санкт-петербург|spb|msk)[^)]*\)/giu;

/** Same company + same title → same hash regardless of source. */
export function normalizeDedup(company: string, title: string): string {
  const c = company.trim().toLowerCase().replace(LEGAL_PREFIX, "").replace(NON_ALNUM, " ").trim();
  const t = title
    .trim()
    .toLowerCase()
    .replace(LOCATION_PAREN, " ")
    .replace(NON_ALNUM, " ")
    .trim();
  return createHash("sha1").update(`${c}|${t}`).digest("hex");
}

/** Canonical URL for career-site vacancies: lowercase host, no fragment, no utm, no trailing slash. */
export function canonicalUrl(raw: string, keepQuery: string[] = []): string {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const keep = new URLSearchParams();
  for (const k of [...keepQuery].sort()) {
    const v = u.searchParams.get(k);
    if (v !== null) keep.set(k, v);
  }
  u.search = keep.toString() ? `?${keep.toString()}` : "";
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.toString();
}
