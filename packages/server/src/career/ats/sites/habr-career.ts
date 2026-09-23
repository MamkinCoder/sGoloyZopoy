// Habr Career (career.habr.com): an all-IT job board, not one company's site. Thousands of open
// vacancies, so instead of listing everything we run a few fixed searches matching the seeker's stack
// against the JSON endpoint the site's own frontend calls (confirmed live 2026-09, no auth):
//   GET /api/frontend/vacancies?q=<query>&sort=date&type=all&page=<n>
//     -> {list:[{id,href:"/vacancies/<id>",title,remoteWork,company:{title},locations:[{title}]|null,
//         salary:{from,to,currency:"rur"|...}}], meta:{totalResults,perPage:25,currentPage,totalPages}}
// `q` appears to match mostly titles/skills (golang -> ~30 results, python -> ~450). Newest first,
// capped at MAX_PAGES per query, deduped by id, sequential with a pause between requests.
// Detail: the vacancy page (/vacancies/<id>) is server-rendered and carries a schema.org JobPosting
// JSON-LD block (title, HTML description, hiringOrganization, jobLocation, jobLocationType, baseSalary);
// there is no JSON detail endpoint (/api/frontend/vacancies/<id> -> 404).
// Apply requires the seeker's Habr account -> no apply(); the review-queue card links the vacancy page.
// 403/429 on the listing stops listing cleanly with what was collected so far (no bypass).
import type { Discovered } from "@sgz/shared";
import { hostOf, httpFetch, getText, stripHtml } from "../../http.js";
import { makeVacancy, toISO } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://career.habr.com";
const KIND = "site:habr-career";
export const QUERIES = ["golang", "go", "backend", "fullstack", "frontend", "react", "node.js", "python", "devops"];
const MAX_PAGES = 3;
const PAUSE_MS = process.env.VITEST ? 0 : 700;

interface HabrListItem {
  id: number;
  href: string;
  title: string;
  remoteWork?: boolean;
  company?: { title?: string };
  locations?: { title: string }[] | null;
  salary?: { from: number | null; to: number | null; currency: string | null };
}

interface HabrListResponse {
  list: HabrListItem[];
  meta: { totalPages: number; currentPage: number };
}

interface JobPosting {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: string }[];
  jobLocationType?: string;
  baseSalary?: { currency?: string; value?: { minValue?: number; maxValue?: number } };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const listUrl = (q: string, page: number): string =>
  `${ORIGIN}/api/frontend/vacancies?q=${encodeURIComponent(q)}&sort=date&type=all&page=${page}`;

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "career.habr.com" ? { token: ORIGIN } : null;
}

function location(v: HabrListItem): string | undefined {
  const parts = (v.locations ?? []).map((l) => l.title.trim()).filter(Boolean);
  if (v.remoteWork) parts.push("удалённо");
  return parts.join(", ") || undefined;
}

async function listJobs(): Promise<Discovered[]> {
  const seen = new Map<number, Discovered>();
  let first = true;
  for (const q of QUERIES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (!first) await sleep(PAUSE_MS);
      first = false;
      const url = listUrl(q, page);
      const res = await httpFetch(url);
      if (res.status === 403 || res.status === 429) return [...seen.values()]; // blocked/rate-limited: stop, keep what we have
      if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
      const data = (await res.json()) as HabrListResponse;
      for (const v of data.list ?? []) {
        if (seen.has(v.id)) continue;
        seen.set(v.id, {
          externalId: atsId(KIND, v.id),
          url: `${ORIGIN}/vacancies/${v.id}`,
          title: v.title.trim(),
          company: v.company?.title?.trim() || "",
          location: location(v),
          raw: v,
        });
      }
      if (!data.list?.length || page >= (data.meta?.totalPages ?? 0)) break;
    }
  }
  return [...seen.values()];
}

/** The schema.org JobPosting JSON-LD block of a vacancy page, or null. */
export function jobPosting(html: string): JobPosting | null {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1] ?? "") as JobPosting;
      if (j["@type"] === "JobPosting") return j;
    } catch {
      /* not JSON, try next */
    }
  }
  return null;
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const html = await getText(d.url);
  const j = jobPosting(html) ?? {};
  const cur = j.baseSalary?.currency ?? "";
  return makeVacancy({
    source: KIND,
    externalId: d.externalId,
    url: d.url,
    title: j.title?.trim() || d.title,
    company: j.hiringOrganization?.name?.trim() || d.company,
    descriptionText: j.description ? stripHtml(j.description) : "",
    area: (j.jobLocation ?? []).map((l) => l.address ?? "").filter(Boolean).join(", ") || d.location || "",
    workFormat: j.jobLocationType === "TELECOMMUTE" ? "Удалённо" : "",
    salaryFrom: j.baseSalary?.value?.minValue ?? 0,
    salaryTo: j.baseSalary?.value?.maxValue ?? 0,
    currency: cur.toUpperCase(),
    publishedAt: toISO(j.datePosted),
  });
}

export const client: ATSClientImpl = {
  kind: KIND,
  verified: true,
  notes:
    "IT job board, not a company site. Lists via the frontend JSON /api/frontend/vacancies?q=&sort=date " +
    `for fixed queries (${QUERIES.join(", ")}), max ${MAX_PAGES} pages x 25 per query, deduped by id, ` +
    "sequential with a pause; stops on 403/429. Detail from the vacancy page's JSON-LD JobPosting " +
    "(description, salary, location). Apply needs the seeker's Habr login -> no apply(), human applies " +
    "from the review queue via the vacancy URL.",
  jobsUrl: () => listUrl(QUERIES[0]!, 1),
  detect,
  listJobs,
  fetchJob,
};
