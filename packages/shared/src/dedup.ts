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

// \b is ASCII-only, so legal-form/suffix words are matched as whole space-delimited tokens instead.
const LEGAL_FORM_WORDS = new Set(["ооо", "ао", "зао", "пао", "ип", "оао", "ано", "гк", "llc", "inc", "ltd"]);
const SUFFIX_WORDS = new Set(["tech", "технологии", "банк", "group", "групп"]);
const GROUP_PREFIX = /^группа компаний\s+/i;
const QUOTES = /[«»"'“”]/g;

/** Big employers with distinct RU/EN names or common short forms, keyed by their post-split token form. */
const COMPANY_ALIASES: Record<string, string> = {
  ozon: "ozon",
  озон: "ozon",
  avito: "avito",
  авито: "avito",
  "t bank": "tbank",
  tbank: "tbank",
  "т банк": "tbank",
  тбанк: "tbank",
  тинькофф: "tbank",
  tinkoff: "tbank",
  vk: "vk",
  вк: "vk",
  "mail ru": "vk",
  "mail ru group": "vk",
  wildberries: "wildberries",
  вайлдберриз: "wildberries",
  rwb: "wildberries",
  сбер: "sber",
  sber: "sber",
  сбербанк: "sber",
  sberbank: "sber",
  яндекс: "yandex",
  yandex: "yandex",
  мтс: "mts",
  mts: "mts",
  kaspersky: "kaspersky",
  "лаборатория касперского": "kaspersky",
  касперский: "kaspersky",
};

/**
 * Collapses a raw company name to one key so "Ozon", "ООО «Озон Технологии»", "OZON" all match.
 * Strips legal forms, quotes/punctuation and case; maps a small set of known RU/EN aliases.
 */
export function companyKey(company: string): string {
  const base = company.trim().replace(QUOTES, "").replace(GROUP_PREFIX, "").replace(NON_ALNUM, " ").trim().toLowerCase();
  const aliased = COMPANY_ALIASES[base];
  if (aliased) return aliased;
  const words = base.split(" ").filter(Boolean);
  const withoutLegal = words.filter((w) => !LEGAL_FORM_WORDS.has(w));
  const key0 = (withoutLegal.length ? withoutLegal : words).join(" ");
  const aliased0 = COMPANY_ALIASES[key0];
  if (aliased0) return aliased0;
  // Strip a trailing/standalone "tech"/"технологии"/"банк"-style suffix only when something remains,
  // so "Т-Банк" alone doesn't collapse to "".
  const withoutSuffix = withoutLegal.filter((w) => !SUFFIX_WORDS.has(w));
  const key = (withoutSuffix.length ? withoutSuffix : withoutLegal.length ? withoutLegal : words).join(" ");
  return COMPANY_ALIASES[key] ?? key;
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
