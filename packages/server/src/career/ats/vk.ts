// VK careers site (team.vk.company). No docs; endpoint found by reading the Next.js page chunk
// (module exporting "qE" calls GET /career/api/v2/vacancies/ with {limit,offset,...filters}, DRF-style
// {count,next,previous,results}). Verified live 2026-09. Listing items carry no description/salary;
// full text (Задачи/Требования/...) and level tags live only in the server-rendered detail page HTML
// at /vacancy/{id}/, so fetchJob scrapes that. No public JSON apply API found — apply is a classic HTML
// POST form at /feedback/{id}/ (first_name, last_name, email, phone, description, resume_link, resume
// file, social_links, agree, csrfmiddlewaretoken) gated by VK SmartCaptcha → agent flow only.
import type { Discovered } from "@sgz/shared";
import { getJson, getText, hostOf, originOf, stripHtml } from "../http.js";
import { makeVacancy } from "../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "./types.js";

const LIMIT = 50;

export interface VKVacancy {
  id: number;
  title: string;
  group?: { id: number; name: string } | null;
  town?: { id: number; name: string } | null;
  work_format?: string;
  remote?: boolean;
  specialty?: { id: number; name: string } | null;
}

interface VKListPage {
  count: number;
  next: string | null;
  results: VKVacancy[];
}

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (host === "team.vk.company" || /career\/api\/v2\/vacancies/.test(html)) {
    return { token: originOf(baseUrl) || "https://team.vk.company" };
  }
  return null;
}

const vacancyUrl = (origin: string, id: number | string): string => `${origin}/vacancy/${id}/`;

const toDiscovered = (origin: string, v: VKVacancy): Discovered => ({
  externalId: atsId("vk", v.id),
  url: vacancyUrl(origin, v.id),
  title: v.title,
  company: v.group?.name ?? "VK",
  location: v.town?.name ?? undefined,
  raw: v,
});

async function listJobs(origin: string): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let offset = 0;
  for (;;) {
    const page = await getJson<VKListPage>(`${origin}/career/api/v2/vacancies/?limit=${LIMIT}&offset=${offset}`);
    out.push(...page.results.map((v) => toDiscovered(origin, v)));
    if (!page.next || page.results.length === 0) break;
    offset += LIMIT;
  }
  return out;
}

const ARTICLE_RE = /<div class="article"[^>]*itemprop="description">([\s\S]*?)<\/div>\s*<div class="page-control">/i;
const LEVEL_HEADING_RE = /<h4 class="vacancy-title">Уровень<\/h4>/i;
const NEXT_HEADING_RE = /<h4 class="vacancy-title">/i;
const TAG_RE = /<div class="vacancy-tag">([^<]*)<\/div>/g;

function descriptionOf(html: string): string {
  const article = ARTICLE_RE.exec(html)?.[1] ?? "";
  return stripHtml(article);
}

// Level tags sit in a sibling block after the "Уровень" <h4>, with variable nesting depth around
// them, so take everything up to the next <h4 class="vacancy-title"> (or end) and pull tags from that.
function levelOf(html: string): string {
  const start = LEVEL_HEADING_RE.exec(html);
  if (!start) return "";
  const from = start.index + start[0].length;
  const rest = html.slice(from);
  const nextIdx = NEXT_HEADING_RE.exec(rest)?.index ?? rest.length;
  const section = rest.slice(0, nextIdx);
  const tags = [...section.matchAll(TAG_RE)].map((m) => m[1]?.trim()).filter(Boolean);
  return tags.join(", ");
}

async function fetchJob(origin: string, d: Discovered) {
  const cached = d.raw as VKVacancy | undefined;
  const id = rawId(d.externalId);
  const html = await getText(vacancyUrl(origin, id));
  const level = levelOf(html);
  const description = [descriptionOf(html), level && `Уровень: ${level}`].filter(Boolean).join("\n\n");
  return makeVacancy({
    source: "vk",
    externalId: d.externalId,
    url: vacancyUrl(origin, id),
    title: cached?.title ?? d.title,
    company: cached?.group?.name ?? d.company,
    descriptionText: description,
    area: cached?.town?.name ?? d.location ?? "",
    workFormat: cached?.work_format ?? "",
  });
}

export const vk: ATSClientImpl = {
  kind: "vk",
  verified: true,
  notes:
    "list via GET /career/api/v2/vacancies/?limit&offset (public JSON, DRF pagination); " +
    "detail scraped from server-rendered /vacancy/{id}/ HTML (listing/detail API has no description/salary); " +
    "apply is an HTML POST form at /feedback/{id}/ (name/email/phone/resume file/links) behind VK SmartCaptcha, no public API → agent flow",
  jobsUrl: (origin) => `${origin}/career/api/v2/vacancies/?limit=${LIMIT}&offset=0`,
  detect,
  listJobs,
  fetchJob,
};
