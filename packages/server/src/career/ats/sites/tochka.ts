// Tochka Bank careers site (hr.tochka.com; tochka.com/hr/ redirects there but is itself gated by a
// Variti antibot 307-redirect loop over plain HTTP - the hr.tochka.com host works fine unblocked).
// Next.js App Router, server-rendered (SSR), no client-callable JSON API. Verified live 2026-09.
//
//   GET /vacancies/{category}/ for each department slug (it, finance, sales, hr, marketing-i-pr,
//     editor, legal, support, infosec, ved-zakupki-i-logistika, riski-komplaens-i-audit,
//     sozdanie-i-upravlenie-processami - the nav's fixed department list) embeds that department's
//     full vacancy list (metadata only: title/slug/category/salary/format/experience/city, no
//     description) as `"initialVacancies":{"meta":{...},"items":[...]}` inside a React Server
//     Component flight payload (`self.__next_f.push([1,"..."])` chunks - concat and JSON.parse the
//     pushed strings to get one big flight text). Each category's total fits on one page (max seen
//     ~10), so no pagination needed; listJobs unions all categories deduped by slug. There is no
//     "all vacancies, paginated" JSON endpoint (the /vacancies/ page's own unfiltered list is capped
//     at pageSize=20 of 35 with no working page/offset param), so per-category pages are the only
//     reliable way to enumerate every job over plain HTTP.
//   GET /vacancies/catalog/{slug}/ (canonical path per /sitemap.xml, NOT /vacancies/{category}/{slug}/
//     which just re-renders the whole list) embeds one `"vacancy":{...}` object per flight payload
//     with the real detail/aboutTeam/requirement/responsibility/expectation HTML fields. Fields are
//     inlined as HTML strings OR, when the RSC payload dedupes long text, replaced with a `"$1f"`-style
//     back-reference to a separate `1f:T<hexlen>,<utf8 bytes>` chunk earlier in the same flight text -
//     resolveRefs splices those in by their declared byte length (the actual React Flight wire format)
//     before parsing the vacancy JSON, so both shapes come out the same either way.
// No salary on ~1/3 of postings. Apply is a client-rendered form (resume upload) behind the same
// hydration - no public apply API found, so apply() is omitted; agent flow only.
import type { Discovered } from "@sgz/shared";
import { getText, hostOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://hr.tochka.com";
const COMPANY = "Tochka";
const CATEGORIES = [
  "it",
  "finance",
  "sales",
  "hr",
  "marketing-i-pr",
  "editor",
  "legal",
  "support",
  "infosec",
  "ved-zakupki-i-logistika",
  "riski-komplaens-i-audit",
  "sozdanie-i-upravlenie-processami",
];

interface TochkaCategory {
  title: string;
  slug: string;
}

interface TochkaListItem {
  mainCategory: TochkaCategory;
  title: string;
  slug: string;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  workFormatInRussian?: string;
  city?: { name: string } | null;
}

interface TochkaVacancyDetail extends TochkaListItem {
  detail?: string; // intro paragraph
  aboutTeam?: string;
  requirement?: string; // HTML, despite the name this is the "what you'll do" block on this site
  responsibility?: string; // HTML, "what we expect from you"
  expectation?: string; // HTML, conditions/benefits
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "hr.tochka.com" ? { token: ORIGIN } : null;
}

/** Concats every `self.__next_f.push([1,"..."])` payload string into one RSC flight text. */
function flightText(html: string): string {
  let out = "";
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (const m of html.matchAll(re)) {
    try {
      out += JSON.parse(m[1]!) as string;
    } catch {
      // skip malformed chunk
    }
  }
  return out;
}

// Flight text dedupes repeated long strings behind numbered chunks like `1f:T8da,<utf8 bytes>`
// and references them elsewhere as `"$1f"`. Splice every such chunk's text in place of its
// reference before parsing JSON. The hex length after "T" is a UTF-8 BYTE count (React Flight's
// wire format), so we measure/slice through a Buffer rather than JS string (UTF-16) indices.
function resolveRefs(flight: string): string {
  const buf = Buffer.from(flight, "utf8");
  const refs = new Map<string, string>();
  const chunkRe = /(^|\n)([0-9a-f]+):T([0-9a-f]+),/g;
  for (const m of flight.matchAll(chunkRe)) {
    const id = m[2]!;
    const byteLen = parseInt(m[3]!, 16);
    const byteStart = Buffer.byteLength(flight.slice(0, m.index! + m[0].length), "utf8");
    refs.set(id, JSON.stringify(buf.subarray(byteStart, byteStart + byteLen).toString("utf8")));
  }
  return flight.replace(/"\$([0-9a-f]+)"/g, (whole, id: string) => refs.get(id) ?? whole);
}

/** Balanced-bracket slice of a JSON value starting at `openChar` right after `afterKey`. */
function sliceBalanced(text: string, afterKey: string, openChar: "{" | "[", closeChar: "}" | "]"): string | null {
  const key = text.indexOf(afterKey);
  if (key === -1) return null;
  const start = text.indexOf(openChar, key);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // skip over a JSON string (handles escaped quotes) so brackets inside it don't count
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

async function listCategory(slug: string): Promise<TochkaListItem[]> {
  const html = await getText(`${ORIGIN}/vacancies/${slug}/`);
  const flight = resolveRefs(flightText(html));
  const arr = sliceBalanced(flight, '"initialVacancies":{"meta"', "[", "]");
  if (!arr) return [];
  try {
    return JSON.parse(arr) as TochkaListItem[];
  } catch {
    return [];
  }
}

const vacancyUrl = (slug: string): string => `${ORIGIN}/vacancies/catalog/${slug}/`;

const toDiscovered = (v: TochkaListItem): Discovered => ({
  externalId: atsId("site:tochka", v.slug),
  url: vacancyUrl(v.slug),
  title: v.title,
  company: COMPANY,
  location: v.city?.name || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const seen = new Map<string, Discovered>();
  for (const cat of CATEGORIES) {
    const items = await listCategory(cat);
    for (const v of items) if (!seen.has(v.slug)) seen.set(v.slug, toDiscovered(v));
  }
  return [...seen.values()];
}

function descriptionOf(v: TochkaVacancyDetail): string {
  const strip = (html?: string): string =>
    (html ?? "")
      .replace(/<\/(p|li|ul|ol)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]*\n/g, "\n")
      .replace(/^[ \t]+/gm, "")
      .trim();
  const section = (title: string, html?: string) => {
    const text = strip(html);
    return text ? `${title}:\n${text}` : "";
  };
  return [
    strip(v.detail),
    strip(v.aboutTeam),
    section("Чем предстоит заниматься", v.requirement),
    section("Ожидания от кандидата", v.responsibility),
    section("Условия", v.expectation),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(vacancyUrl(rawId(d.externalId)));
  const flight = resolveRefs(flightText(html));
  const raw = sliceBalanced(flight, '"vacancy":{', "{", "}");
  const v: TochkaVacancyDetail = raw
    ? (JSON.parse(raw) as TochkaVacancyDetail)
    : ((d.raw as TochkaListItem | undefined) ?? { mainCategory: { title: "", slug: "" }, title: d.title, slug: rawId(d.externalId) });
  return makeVacancy({
    source: "site:tochka",
    externalId: d.externalId,
    url: d.url,
    title: v.title ?? d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.city?.name || d.location || "",
    workFormat: v.workFormatInRussian ?? "",
    salaryFrom: v.salaryFrom ?? 0,
    salaryTo: v.salaryTo ?? 0,
    currency: v.salaryFrom || v.salaryTo ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:tochka",
  verified: true,
  notes:
    "no public JSON API; hr.tochka.com is a server-rendered Next.js app, all data embedded as JSON in RSC " +
    "flight chunks (self.__next_f.push). listJobs unions GET /vacancies/{category}/ for the fixed set of " +
    "department slugs from the site nav (each category's full list fits on one page, no working pagination " +
    "param found for the unfiltered /vacancies/ list, so per-category enumeration is the only complete path); " +
    "fetchJob reads GET /vacancies/catalog/{slug}/ (canonical detail URL per /sitemap.xml) for the real " +
    "description (intro, team blurb, tasks, requirements, conditions), resolving React Flight back-references " +
    "when the payload dedupes long text; note tochka.com/hr/ itself loops behind a Variti antibot redirect " +
    "over plain HTTP, use hr.tochka.com directly. No salary on ~1/3 of postings. Apply is a client-rendered " +
    "resume-upload form on the same page, no public apply API found -> agent flow only.",
  jobsUrl: () => `${ORIGIN}/vacancies/it/`,
  detect,
  listJobs,
  fetchJob,
};
