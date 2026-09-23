// 2GIS careers site (job.2gis.ru), a server-rendered React app (SSR, no client fetch needed).
// No public JSON API: /vacancies?page=<n> server-renders the list accumulated up to page n*15 items
// (page=1 -> 15, page=2 -> 30, ...); requesting a large page number (e.g. 100) reliably returns the
// full list in one request (101 jobs on 2026-09), capped, no error. Each <li> card carries the job
// url (/vacancies/<category>/<id>), title, a short teaser and category/location chips.
// Job detail pages (GET the card url) embed a schema.org JobPosting as JSON-LD with the full
// description, jobLocation.address.addressLocality (city) or jobLocationType: TELECOMMUTE (remote).
// No salary ever published. Apply is a client-rendered HTML form on the same page (firstName,
// lastName, email, phone, messengerUsername, resume file pdf/doc/docx <=10MB, optional cover
// letter) - no public apply API found, so apply() is omitted; agent flow only. Verified live 2026-09.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, originOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.2gis.ru";
const LIST_PAGE = 100; // 15 jobs/page server-side; a page far beyond the real count returns everything

const CARD_START_RE = /<li><a href="(\/vacancies\/[a-z0-9_-]+\/\d+)"/g;
const TITLE_RE = /<h4[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h4>/i;
const CHIP_RE = /<span class="chipLabel-[^"]*">([^<]*)<\/span>/g;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "job.2gis.ru") return { token: ORIGIN };
  return /job\.2gis\.ru\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

// Cards are <li><a href="/vacancies/.../ID">...chips...<h4>title</h4><p>teaser</p></a></li>; split on
// the next card start (or end of list) rather than balancing tags. Chips run
// [category, ...subcategory?, location-or-"Удалённо"] - the last chip is always the location/format.
function parseListing(html: string): Discovered[] {
  const starts = [...html.matchAll(CARD_START_RE)];
  const out = new Map<string, Discovered>();
  for (let i = 0; i < starts.length; i++) {
    const path = starts[i]?.[1];
    const from = starts[i]?.index ?? 0;
    const to = starts[i + 1]?.index ?? html.length;
    if (!path) continue;
    const block = html.slice(from, to);
    const title = stripHtml(decodeEntities(TITLE_RE.exec(block)?.[1] ?? "")).trim();
    if (!title) continue;
    const chips = [...block.matchAll(CHIP_RE)].map((m) => decodeEntities(m[1] ?? "").trim());
    const id = path.split("/").pop() ?? path;
    out.set(id, {
      externalId: atsId("site:2gis", id),
      url: `${ORIGIN}${path}`,
      title,
      company: "2GIS",
      location: chips[chips.length - 1] || undefined,
    });
  }
  return [...out.values()];
}

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(`${ORIGIN}/vacancies?page=${LIST_PAGE}`);
  return parseListing(html);
}

interface JobPostingLD {
  title?: string;
  description?: string;
  jobLocationType?: string;
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

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const ld = parseJobPosting(html);
  const area = ld?.jobLocation?.address?.addressLocality ?? (ld?.jobLocationType === "TELECOMMUTE" ? "Удалённо" : d.location ?? "");
  return makeVacancy({
    source: "site:2gis",
    externalId: d.externalId,
    url: d.url,
    title: ld?.title ?? d.title,
    company: "2GIS",
    descriptionText: ld?.description ? stripHtml(decodeEntities(ld.description)) : "",
    area,
    workFormat: ld?.jobLocationType === "TELECOMMUTE" ? "Удалённо" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:2gis",
  verified: true,
  notes:
    "no public JSON API; server-rendered GET /vacancies?page=100 returns the full accumulated list " +
    "(15 jobs/page, large page number caps at the real count, ~101 jobs on 2026-09); detail pages carry " +
    "a JobPosting JSON-LD (description, city or TELECOMMUTE, no salary ever exposed). Apply is a " +
    "client-rendered HTML form on the job page (name, email, phone, messenger, resume file pdf/doc/docx " +
    "<=10MB, optional cover letter), no public apply API found -> agent flow only",
  jobsUrl: () => `${ORIGIN}/vacancies?page=${LIST_PAGE}`,
  detect,
  listJobs,
  fetchJob,
};
