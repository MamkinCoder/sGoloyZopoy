// Dodo Engineering careers site (dodoengineering.ru), a landing page that links out to the shared
// Dodo Brands jobs site job-site-backend.dodo-ai-platform.io (served under dodoteam.ru), a Nuxt SPA.
// No docs; API base found in the SSR shell's window.__NUXT__.config.public.apiURL, endpoint paths in
// the SPA's JS chunks (pinia stores). Verified live 2026-09.
//   GET /api/v1/vacancies            -> list, grouped by speciality: {data:[{speciality,items:[{id,
//                                        brand,position,speciality,subspeciality,vacancy_location,
//                                        work_format:string[]}]}]}. Covers all Dodo Brands (Dodo Pizza,
//                                        Drinkit, Engineering) - we filter to brand === "Engineering"
//                                        since that's this client's identity.
//   GET /api/v1/pages/vacancy/{id}   -> detail; {id} is the numeric id from the list (not a slug).
//                                        Description is split across typed content blocks
//                                        (vacancy_text, vacancy_expectation, vacancy_you_will,
//                                        vacancy_benefits), each with an HTML `text` field we
//                                        concatenate; vacancy_main.money is null in practice (no
//                                        salary ever published), work_format is a single string here
//                                        (list has string[]).
// Apply is an in-page form (feedback_form block: name, email, phone, resume upload, "about yourself")
// - no public apply API found, so apply() is omitted; agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const SITE_ORIGIN = "https://dodoengineering.ru";
const API_ORIGIN = "https://job-site-backend.dodo-ai-platform.io";
const JOBS_SITE_ORIGIN = "https://dodoteam.ru";
const LIST_API = `${API_ORIGIN}/api/v1/vacancies`;
const DETAIL_API = `${API_ORIGIN}/api/v1/pages/vacancy`;
const COMPANY = "Dodo Engineering";
const BRAND = "Engineering";

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:dodo-engineering" is
// itself two colon-segments, so we peel our own known prefix instead (same fix as sites/beeline.ts).
const KIND_PREFIX = "site:dodo-engineering:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

interface DodoListItem {
  id: number;
  brand: string;
  position: string;
  vacancy_location?: string;
  work_format?: string[];
}

interface DodoListGroup {
  speciality: string;
  items: DodoListItem[];
}

interface DodoListResponse {
  data: DodoListGroup[];
}

interface DodoContentBlock {
  type: string;
  data: Record<string, unknown>;
}

interface DodoDetailResponse {
  data: {
    page: {
      content: DodoContentBlock[];
    };
  };
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "dodoengineering.ru") return { token: SITE_ORIGIN };
  return /dodoteam\.ru\/vacancies/i.test(html) ? { token: SITE_ORIGIN } : null;
}

const areaOf = (v: DodoListItem): string => v.vacancy_location ?? "";

const toDiscovered = (v: DodoListItem): Discovered => ({
  externalId: atsId("site:dodo-engineering", v.id),
  url: `${JOBS_SITE_ORIGIN}/vacancy?vacancyId=${v.id}`,
  title: v.position.trim(),
  company: COMPANY,
  location: areaOf(v) || undefined,
});

async function listJobs(): Promise<Discovered[]> {
  const res = await getJson<DodoListResponse>(LIST_API);
  return res.data
    .flatMap((g) => g.items)
    .filter((v) => v.brand === BRAND)
    .map(toDiscovered);
}

// Description is assembled from the HTML `text` fields of the typed content blocks, in the order
// the API returns them (roughly: intro, expectations, responsibilities, benefits).
const TEXT_BLOCK_TYPES = new Set(["vacancy_text", "vacancy_expectation", "vacancy_you_will", "vacancy_benefits"]);

function descriptionOf(blocks: DodoContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!TEXT_BLOCK_TYPES.has(block.type)) continue;
    const title = typeof block.data.title === "string" ? block.data.title : "";
    const text = typeof block.data.text === "string" ? block.data.text : "";
    if (!text) continue;
    const heading = title ? `${title}\n` : "";
    parts.push(heading + stripHtml(decodeEntities(text)));
  }
  return parts.join("\n\n");
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const res = await getJson<DodoDetailResponse>(`${DETAIL_API}/${localId(d.externalId)}`);
  const blocks = res.data.page.content;
  const main = blocks.find((b) => b.type === "vacancy_main")?.data as
    | { position?: string; vacancy_location?: string; work_format?: string }
    | undefined;
  return makeVacancy({
    source: "site:dodo-engineering",
    externalId: d.externalId,
    url: d.url,
    title: main?.position?.trim() || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(blocks),
    area: main?.vacancy_location || d.location || "",
    workFormat: main?.work_format || "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:dodo-engineering",
  verified: true,
  notes:
    "no public docs; dodoengineering.ru itself only links to the shared Dodo Brands jobs site " +
    "(dodoteam.ru); its JSON API at job-site-backend.dodo-ai-platform.io/api/v1/vacancies lists " +
    "all Dodo brands (Dodo Pizza, Drinkit, Engineering) grouped by speciality, filtered here to " +
    "brand === \"Engineering\" (6 of 17 on 2026-09); detail at /api/v1/pages/vacancy/{numeric id} " +
    "splits the description across typed HTML content blocks; no salary ever exposed (money is " +
    "always null); apply is an in-page form (name, email, phone, resume upload, about yourself), " +
    "no public apply API found -> agent flow only",
  jobsUrl: () => LIST_API,
  detect,
  listJobs,
  fetchJob,
};
