// Lamoda careers site (job.lamoda.ru), a Next.js app-router site with no public JSON API.
// listJobs reads /sitemap.xml, which lists every open vacancy at /vacancies/<city-slug>/<title-slug>--<id>
// (confirmed live 2026-09: 163 URLs, matching robots.txt's allowed /vacancies?... crawl paths). The
// /vacancies search page itself renders its list client-side (no embedded data), so the sitemap is the
// only deterministic index. Each detail page is server-rendered and embeds a full vacancy object in a
// React Server Components flight stream (the `self.__next_f.push([1,"..."])` chunks in the HTML) - the
// same technique as __NEXT_DATA__ but React's newer streaming format: text chunks are `<id>:T<hexlen>,<utf8 bytes>`
// and the JSON tree references them by id as `"$<id>"` strings. hrSystem.name (huntflow/estaff) in that
// object is only the *apply* backend selector, not a public listing API, so it isn't used here.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy, toISO } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.lamoda.ru";
const COMPANY = "Lamoda";
const SITEMAP_URL = `${ORIGIN}/sitemap.xml`;

const SITEMAP_LOC_RE = /<loc>(https:\/\/job\.lamoda\.ru\/vacancies\/[^<]+)<\/loc>/gi;
const VACANCY_ID_RE = /--(\d+)$/;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "job.lamoda.ru") return { token: ORIGIN };
  return /job\.lamoda\.ru\/vacancies\//i.test(html) ? { token: ORIGIN } : null;
}

function parseSitemap(xml: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of xml.matchAll(SITEMAP_LOC_RE)) {
    const url = decodeEntities(m[1] ?? "");
    const id = VACANCY_ID_RE.exec(url)?.[1];
    if (!id) continue;
    // The sitemap has no titles; the transliterated slug ("backend-razrabotchik--123") stands in until fetchJob.
    const slug = url.split("/").pop()?.replace(VACANCY_ID_RE, "") ?? "";
    out.push({ externalId: atsId("site:lamoda", id), url, title: slug.replace(/-/g, " "), company: COMPANY });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const xml = await getText(`${origin}/sitemap.xml`);
  return parseSitemap(xml);
}

// --- React Flight stream parsing (see file header) ---

/** Concatenate every `self.__next_f.push([1,"..."])` payload in the page into one flight buffer. */
function flightBuffer(html: string): string {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      out += JSON.parse(m[1] ?? '""') as string;
    } catch {
      // malformed chunk, skip
    }
  }
  return out;
}

/** Map of flight chunk id -> decoded text, for every `<id>:T<hexlen>,<utf8 bytes>` line in the buffer. */
function flightTextChunks(buf: string): Map<string, string> {
  const chunks = new Map<string, string>();
  const bytes = Buffer.from(buf, "utf8");
  for (const m of buf.matchAll(/(?:^|\n)([0-9a-f]+):T([0-9a-f]+),/g)) {
    const id = m[1];
    const len = parseInt(m[2] ?? "0", 16);
    if (!id || !Number.isFinite(len)) continue;
    const startChar = (m.index ?? 0) + m[0].length;
    const startByte = Buffer.byteLength(buf.slice(0, startChar), "utf8");
    chunks.set(id, bytes.subarray(startByte, startByte + len).toString("utf8"));
  }
  return chunks;
}

/** Text from a flight field value: either an inline string, or a "$<id>" reference into textChunks. */
function resolveField(value: unknown, textChunks: Map<string, string>): string {
  if (typeof value !== "string") return "";
  const ref = /^\$([0-9a-f]+)$/.exec(value)?.[1];
  return ref ? (textChunks.get(ref) ?? "") : value;
}

/** First balanced {...} starting at the '{' right after `needle` in `text`, or null. */
function balancedObjectAfter(text: string, needle: string): string | null {
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const start = at + needle.length;
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

interface LamodaVacancy {
  id: number;
  name: string;
  externalPublicationDate?: string | null;
  introduction?: unknown;
  duties?: unknown;
  requirements?: unknown;
  conditions?: unknown;
  common?: unknown;
  shortInfo?: unknown;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  address?: string | null;
  location?: { name?: string } | null;
  department?: { name?: string; conditions?: string | null } | null;
  direction?: { name?: string } | null;
}

function parseVacancy(html: string): LamodaVacancy | null {
  const buf = flightBuffer(html);
  const block = balancedObjectAfter(buf, '"context":{"vacancy":') ?? balancedObjectAfter(buf, '"vacancy":');
  if (!block) return null;
  try {
    return JSON.parse(block) as LamodaVacancy;
  } catch {
    return null;
  }
}

function descriptionOf(v: LamodaVacancy, textChunks: Map<string, string>): string {
  const html = (field: unknown) => stripHtml(decodeEntities(resolveField(field, textChunks)));
  const section = (title: string, body: string) => (body ? `${title}:\n${body}` : "");
  const parts = [
    html(v.introduction),
    html(v.common),
    section("Чем предстоит заниматься", html(v.duties)),
    section("Мы ожидаем", html(v.requirements)),
    section("Мы предлагаем", html(v.conditions) || (v.department?.conditions ?? "")),
  ].filter(Boolean);
  if (parts.length > 0) return parts.join("\n\n");
  // Some listings only carry the plain-text shortInfo summary.
  return html(v.shortInfo);
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const v = parseVacancy(html);
  if (!v) {
    return makeVacancy({ source: "site:lamoda", externalId: d.externalId, url: d.url, title: d.title, company: COMPANY });
  }
  const buf = flightBuffer(html);
  const textChunks = flightTextChunks(buf);
  return makeVacancy({
    source: "site:lamoda",
    externalId: d.externalId,
    url: d.url,
    title: v.name || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v, textChunks),
    area: v.location?.name || v.address || "",
    workFormat: v.direction?.name || "",
    salaryFrom: v.salaryFrom ?? 0,
    salaryTo: v.salaryTo ?? 0,
    publishedAt: toISO(v.externalPublicationDate ?? null),
  });
}

export const client: ATSClientImpl = {
  kind: "site:lamoda",
  verified: true,
  notes:
    "no public JSON API; /sitemap.xml lists every open vacancy URL (/vacancies/<city>/<slug>--<id>), confirmed " +
    "live 2026-09 (163 jobs); the /vacancies search page itself is client-rendered with no embedded list. " +
    "Detail pages are server-rendered Next.js: full vacancy object (duties/requirements/conditions/salary/location) " +
    "embedded in the page's React Flight stream (self.__next_f.push chunks), some fields inline HTML and some " +
    "referenced text chunks - both resolved by fetchJob. hrSystem (huntflow or estaff) only selects the apply " +
    "backend for the on-page response form (name/email/phone/comment/resume file), no public apply API -> agent flow.",
  jobsUrl: () => SITEMAP_URL,
  detect,
  listJobs,
  fetchJob,
};
