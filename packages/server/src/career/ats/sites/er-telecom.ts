// ER-Telecom (Dom.ru) careers site (job.ertelecom.ru), a plain server-rendered React (CRA) app.
// No embedded data / flight payload; the SPA calls a public same-origin DRF-style JSON API found in
// the bundle's /static/js/main.*.js ("/api" + "/vacancy/list/" / "/vacancy/"+id). Verified live 2026-09
// (120 open vacancies across the holding's subsidiaries, incl. dev/QA/DBA/sysadmin roles).
//   GET /api/vacancy/list/?page=<n> -> {count,next,previous,results:[{id,name,company:{name},
//                                       city:[{name}],employment:[{name}],experience:[{name}],...}]}
//                                      DRF PageNumberPagination; `next` is the full next-page URL.
// Listing items carry only a short preview; company on each item is the actual hiring subsidiary
// (e.g. "ООО \"Эр-1\""), but we report company "ER-Telecom" per the holding brand as instructed.
//   GET /api/vacancy/{id}/          -> same shape plus full `content` (sanitized HTML description).
// No salary field anywhere in list or detail payloads. Apply is a client-rendered "Откликнуться" form
// on the vacancy page (name/phone/email/resume upload) - no public apply API found -> agent flow only.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.ertelecom.ru";
const LIST_API = `${ORIGIN}/api/vacancy/list/`;
const DETAIL_API = `${ORIGIN}/api/vacancy`;
const COMPANY = "ER-Telecom";
const MAX_PAGES = 30;

interface ERLabel {
  id: number;
  name: string;
}

interface ERVacancy {
  id: number;
  name: string;
  city?: ERLabel[];
  employment?: ERLabel[];
  experience?: ERLabel[];
  content?: string;
}

interface ERListPage {
  count: number;
  next: string | null;
  results: ERVacancy[];
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "job.ertelecom.ru" ? { token: ORIGIN } : null;
}

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:er-telecom" is itself
// two colon-segments, so we peel our own known prefix instead (same fix as sites/mts-bank.ts).
const KIND_PREFIX = "site:er-telecom:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

const vacancyUrl = (id: number | string): string => `${ORIGIN}/vacancy/${id}`;
const cityOf = (v: ERVacancy): string => v.city?.[0]?.name ?? "";

const toDiscovered = (v: ERVacancy): Discovered => ({
  externalId: atsId("site:er-telecom", v.id),
  url: vacancyUrl(v.id),
  title: v.name.trim(),
  company: COMPANY,
  location: cityOf(v) || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let url: string | null = `${LIST_API}?page=1`;
  for (let i = 0; url && i < MAX_PAGES; i++) {
    const page: ERListPage = await getJson<ERListPage>(url);
    out.push(...page.results.map(toDiscovered));
    url = page.next;
  }
  return out;
}

const workFormatOf = (v: ERVacancy): string => v.employment?.map((e) => e.name).join(", ") ?? "";

async function fetchJob(_token: string, d: Discovered) {
  const v = await getJson<ERVacancy>(`${DETAIL_API}/${localId(d.externalId)}/`);
  return makeVacancy({
    source: "site:er-telecom",
    externalId: d.externalId,
    url: d.url,
    title: v.name?.trim() ?? d.title,
    company: COMPANY,
    descriptionText: stripHtml(v.content ?? ""),
    area: cityOf(v) || d.location || "",
    workFormat: workFormatOf(v),
  });
}

export const client: ATSClientImpl = {
  kind: "site:er-telecom",
  verified: true,
  notes:
    "no docs; public DRF JSON API GET /api/vacancy/list/?page=<n> (PageNumberPagination, `next` is " +
    "the full next-page URL); detail via GET /api/vacancy/{id}/ with full sanitized-HTML `content`; " +
    "listing items report the hiring subsidiary as company, we report the holding brand instead; " +
    "no salary ever populated; apply is a client-rendered form (name, phone, email, resume upload) " +
    "on the vacancy page, no public apply API found -> agent flow only",
  jobsUrl: () => `${LIST_API}?page=1`,
  detect,
  listJobs,
  fetchJob,
};
