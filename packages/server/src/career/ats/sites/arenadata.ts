// Arenadata careers site (arenadata.tech/ru/career; the given base_url and career.arenadata.tech
// both 301-redirect there). Next.js App Router, server-rendered. No separate JSON API and no
// client-side pagination request either: the full vacancies array (all jobs, "10 на странице"
// pager is cosmetic/client-only) is embedded as JSON inside a self.__next_f.push(...) RSC flight
// chunk on the listing page itself - one GET gets everything. Verified live 2026-09 (15 vacancies).
// Detail pages are plain server-rendered HTML with stable <section id="vacancy-..."> blocks; we
// read O продукте+Стек, the tasks/expectations copy and Чем мы занимаемся (skip the boilerplate
// Этапы найма / Заботимся о команде sections, identical on every job). No salary is ever published;
// location isn't per-job either (only a Moscow HQ address in the footer, not vacancy-specific).
// Apply is a client-rendered dialog POSTing FormData to /api/cms/subscriptions/vacancy-apply
// (fields incl. lastName, city, vacancySlug, vacancyName, resume) - no public read API for it,
// and it's a write endpoint anyway, so apply() is omitted; agent flow only.
import type { Discovered } from "@sgz/shared";
import { getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://arenadata.tech";
const LISTING_URL = `${ORIGIN}/ru/career`;

interface ADVacancy {
  slug: string;
  position: string;
  positionGrade: string | null;
  product: string;
  department: string;
  company: string;
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "arenadata.tech" || hostOf(baseUrl) === "career.arenadata.tech" ? { token: ORIGIN } : null;
}

// The listing page embeds `"vacancies":[{...}]` as a JSON array inside an RSC flight <script> chunk
// (a JS string, so real quotes are escaped as \"). Slice out the balanced [...] and unescape it.
function parseVacancies(html: string): ADVacancy[] {
  const key = html.indexOf('\\"vacancies\\":[');
  if (key === -1) return [];
  const start = html.indexOf("[", key);
  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "\\" && html[i + 1] === '"') {
      i++;
      continue;
    }
    if (html[i] === "[") depth++;
    else if (html[i] === "]" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) return [];
  try {
    return JSON.parse(html.slice(start, end).replace(/\\"/g, '"')) as ADVacancy[];
  } catch {
    return [];
  }
}

const toDiscovered = (v: ADVacancy): Discovered => ({
  externalId: atsId("site:arenadata", v.slug),
  url: `${LISTING_URL}/${v.slug}`,
  title: v.position,
  company: v.company || "Arenadata",
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(LISTING_URL);
  return parseVacancies(html).map(toDiscovered);
}

// Sections don't nest, so a non-greedy match up to the matching closing tag is safe.
function section(html: string, id: string): string {
  const m = new RegExp(`<section id="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html);
  return m?.[1] ? stripHtml(m[1]) : "";
}

async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as ADVacancy | undefined;
  const html = await getText(d.url);
  const descriptionText = [section(html, "vacancy-product"), section(html, "vacancy-description"), section(html, "vacancy-department")]
    .filter(Boolean)
    .join("\n\n");
  return makeVacancy({
    source: "site:arenadata",
    externalId: d.externalId,
    url: d.url,
    title: d.title,
    company: cached?.company || "Arenadata",
    descriptionText,
  });
}

export const client: ATSClientImpl = {
  kind: "site:arenadata",
  verified: true,
  notes:
    "no separate JSON API; the full vacancies list (all jobs, client-side-only pager) is embedded as JSON " +
    "in an RSC flight chunk on GET /ru/career - one request gets everything; detail pages are server-rendered " +
    "HTML with stable <section id=\"vacancy-...\"> blocks (product+stack, tasks+expectations, team blurb); " +
    "no salary and no per-vacancy location ever published; apply is a client dialog POSTing FormData to " +
    "/api/cms/subscriptions/vacancy-apply (name, city, resume) - write-only, no public read API -> agent flow",
  jobsUrl: () => LISTING_URL,
  detect,
  listJobs,
  fetchJob,
};
