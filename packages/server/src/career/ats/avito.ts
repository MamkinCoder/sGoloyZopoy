// Avito careers site (verified 2026-09 live against career.avito.com, which is where
// www.avito.ru/company/job redirects). No public JSON API: it's a server-rendered Bitrix site.
// /vacancies/ lists every open direction (section) with a per-section "show all" link at
// /vacancies/<slug>/ that renders the full unpaginated list of that section's jobs. We read
// /vacancies/ to discover the current section slugs, then fetch each section page.
// Job detail pages embed a schema.org JobPosting as JSON-LD with the full plain-ish description,
// city and posted date - no salary is ever published. Apply is a Bitrix form (firstName, lastName,
// phone, email, resume file-or-link, two required agreement checkboxes) posted to a template upload
// endpoint with no documented public JSON API, so apply() is omitted - the browser agent applies.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, originOf, stripHtml } from "../http.js";
import { makeVacancy, toISO } from "../vacancy.js";
import { atsId, type ATSClientImpl } from "./types.js";

const HOST_RE = /(^|\.)career\.avito\.(com|ru)$/;
const SECTION_LINK_RE = /<a href="(\/vacancies\/[a-z0-9-]+\/)"[^>]*data-show-all-link[^>]*>/gi;
const ITEM_START_RE = /data-vacancy-id="(\d+)"/gi;
const ITEM_LINK_RE = /<a href="([^"]+)" class="vacancies-section__item-name">([\s\S]*?)<\/a>/i;
const ITEM_GEO_RE = /data-vacancy-geo="([^"]*)"/i;

function parseSectionSlugs(html: string): string[] {
  const slugs = new Set<string>();
  for (const m of html.matchAll(SECTION_LINK_RE)) if (m[1]) slugs.add(m[1]);
  return [...slugs];
}

// Each job card is a run of text between one `data-vacancy-id="..."` and the next (or end of
// section). Splitting on that marker is far more robust against markup drift than balancing tags.
function parseSectionItems(html: string, origin: string): Discovered[] {
  const starts = [...html.matchAll(ITEM_START_RE)];
  const out: Discovered[] = [];
  for (let i = 0; i < starts.length; i++) {
    const id = starts[i]?.[1];
    const from = starts[i]?.index ?? 0;
    const to = starts[i + 1]?.index ?? html.length;
    const block = html.slice(from, to);
    const link = ITEM_LINK_RE.exec(block);
    if (!id || !link) continue;
    const url = new URL(link[1] ?? "", origin).toString();
    const title = stripHtml(decodeEntities(link[2] ?? "")).trim();
    const geo = decodeEntities(ITEM_GEO_RE.exec(block)?.[1] ?? "").trim();
    if (!title) continue;
    out.push({ externalId: atsId("avito", id), url, title, company: "Avito", location: geo || undefined });
  }
  return out;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  const origin = originOf(baseUrl);
  if (!origin) return null;
  if (HOST_RE.test(hostOf(baseUrl))) return { token: origin };
  return /career\.avito\.(com|ru)\/vacancies/i.test(html) ? { token: origin } : null;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const root = await getText(`${origin}/vacancies/`);
  const slugs = parseSectionSlugs(root);
  const seen = new Map<string, Discovered>();
  for (const path of slugs) {
    const html = await getText(`${origin}${path}`);
    for (const d of parseSectionItems(html, origin)) seen.set(d.externalId, d);
  }
  return [...seen.values()];
}

interface JobPostingLD {
  description?: string;
  title?: string;
  datePosted?: string;
  employmentType?: string;
  jobLocation?: { address?: { addressLocality?: string } };
}

function parseJobPosting(html: string): JobPostingLD | null {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1] ?? "") as { "@type"?: string };
      if (data["@type"] === "JobPosting") return data as JobPostingLD;
    } catch {
      // not JSON / not this block
    }
  }
  return null;
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const ld = parseJobPosting(html);
  const h1 = stripHtml(decodeEntities(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ""));
  const title = ld?.title ?? (h1 || d.title);
  const descriptionText = ld?.description ? stripHtml(decodeEntities(ld.description)) : "";
  return makeVacancy({
    source: "avito",
    externalId: d.externalId,
    url: d.url,
    title,
    company: "Avito",
    descriptionText,
    area: ld?.jobLocation?.address?.addressLocality ?? d.location ?? "",
    workFormat: ld?.employmentType === "FULL_TIME" ? "Полная занятость" : (ld?.employmentType ?? ""),
    publishedAt: toISO(ld?.datePosted),
  });
}

export const avito: ATSClientImpl = {
  kind: "avito",
  verified: true,
  notes:
    "no public JSON API; /vacancies/ discovers section slugs, /vacancies/<slug>/ lists all jobs unpaginated, " +
    "job pages carry a JobPosting JSON-LD (description/city/date, no salary). Apply is a Bitrix form " +
    "(name, phone, email, resume file-or-link, 2 required checkboxes) with no public JSON apply API → agent flow.",
  jobsUrl: (origin) => `${origin}/vacancies/`,
  detect,
  listJobs,
  fetchJob,
};
