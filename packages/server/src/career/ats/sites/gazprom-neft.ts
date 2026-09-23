// Gazprom Neft careers site (career.gazprom-neft.ru), a server-rendered 1C-Bitrix site with a Vue
// widget on /vacancies/ that talks to the site's own public JSON API (found in
// /local/templates/career_new/js/vue/mixins.js). Verified live 2026-09:
//   POST /api2/v1/vacancies/list/  body {pagination,spec,cities,schedule,worktype,search,sort}
//                                  -> {success,data:[{id,title,detail,city,code,id_sap,...}],response:{count}}
//                                  10 items/page, pagination is a 1-based page number, spec:["213"] filters
//                                  to the "Разработка" (development) IT subcategory (id from /api2/v1/filter/lists/).
// listJobs queries every top-level IT subcategory (id 206's children: 207-218) merged and deduped, since
// the runner filters by keyword afterwards and unfiltered "all vacancies" is mostly non-IT oil & gas roles.
// Detail pages (/vacancies/<code>/) embed a schema.org JobPosting JSON-LD with the full description
// (HTML-escaped, decode+strip), city and posted date - same shape/pattern as avito.ts, no salary ever
// published. Apply is a Bitrix modal form (POST likely, fields unconfirmed) requiring resume upload, no
// public JSON apply API found -> apply() omitted, agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, postJson, stripHtml } from "../../http.js";
import { makeVacancy, toISO } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const KIND = "site:gazprom-neft";
const ORIGIN = "https://career.gazprom-neft.ru";
const LIST_API = `${ORIGIN}/api2/v1/vacancies/list/`;
const COMPANY = "Gazprom Neft";
// IT top-level category ("id":"206","code":"it") children from GET-equivalent /api2/v1/filter/lists/,
// spanning dev/QA/infra/security/data/product, not just "development" (id 213) alone.
const IT_SPEC_IDS = ["207", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217", "218"];

interface ListItem {
  id: string;
  title: string;
  detail: string;
  city?: string | false;
  code: string;
}

interface ListResponse {
  success: boolean;
  data: ListItem[] | false;
  response: { count: number };
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "career.gazprom-neft.ru") return { token: ORIGIN };
  return /career\.gazprom-neft\.ru\/(vacancies|api2\/v1\/vacancies)/i.test(html) ? { token: ORIGIN } : null;
}

const detailUrl = (code: string): string => `${ORIGIN}/vacancies/${code}/`;

const toDiscovered = (v: ListItem): Discovered => ({
  externalId: atsId(KIND, v.id),
  url: v.detail || detailUrl(v.code),
  title: v.title,
  company: COMPANY,
  location: v.city || undefined,
  raw: v,
});

async function listForSpec(spec: string): Promise<ListItem[]> {
  const out: ListItem[] = [];
  let page = 1;
  for (;;) {
    const res = await postJson<ListResponse>(LIST_API, { pagination: page, spec: [spec] });
    const items = res.data || [];
    out.push(...items);
    if (items.length === 0 || out.length >= res.response.count) break;
    page += 1;
  }
  return out;
}

async function listJobs(): Promise<Discovered[]> {
  const seen = new Map<string, Discovered>();
  for (const spec of IT_SPEC_IDS) {
    for (const item of await listForSpec(spec)) {
      const d = toDiscovered(item);
      seen.set(d.externalId, d);
    }
  }
  return [...seen.values()];
}

interface JobPostingLD {
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string;
  jobLocation?: { address?: { addressLocality?: string } };
}

function parseJobPosting(html: string): JobPostingLD | null {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse((m[1] ?? "").trim()) as { "@type"?: string };
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
  return makeVacancy({
    source: KIND,
    externalId: d.externalId,
    url: d.url,
    title: ld?.title ?? d.title,
    company: COMPANY,
    descriptionText: ld?.description ? stripHtml(decodeEntities(ld.description)) : "",
    area: ld?.jobLocation?.address?.addressLocality ?? d.location ?? "",
    workFormat: ld?.employmentType ?? "",
    publishedAt: toISO(ld?.datePosted),
  });
}

export const client: ATSClientImpl = {
  kind: KIND,
  verified: true,
  notes:
    "1C-Bitrix site with its own public JSON API: POST /api2/v1/vacancies/list/ (10/page, pagination is " +
    "a 1-based page number, spec:[ids] filters by /api2/v1/filter/lists/ subcategory) - listJobs queries " +
    "the 12 IT subcategory ids (development, infra, security, data, product, etc.) and merges/dedupes, " +
    "since unfiltered results are mostly non-IT oil & gas roles. Detail pages carry a JobPosting JSON-LD " +
    "(description/city/date, no salary field anywhere). Apply is a Bitrix modal form with resume upload, " +
    "no public JSON apply API found -> agent flow only.",
  jobsUrl: () => LIST_API,
  detect,
  listJobs,
  fetchJob,
};
