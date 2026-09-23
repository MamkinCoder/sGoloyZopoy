// Samolet careers site (career.samolet.ru), a Django-backed React SPA. No docs; the real data
// source is the public Skillaz integration JSON API the SPA's own bundles call (found via
// /api/schema/, a public drf-spectacular OpenAPI schema the site itself serves), verified live
// 2026-09:
//   GET /api/integrations/skillaz/vacancies/?limit=&page=  -> DRF-paginated list (count/next/results),
//     no auth required despite the schema listing cookieAuth/tokenAuth as options.
// There is no separate detail-by-id endpoint (the SPA detail page at /vakansii/view/{uuid}/ is
// itself client-rendered from the same list data), so fetchJob reuses the cached raw payload from
// listJobs. List items carry only structured taxonomy fields (specialization/region/experience/
// schedule/workplace/employment type) plus a generic "whySamolet" company-values blurb that is
// identical boilerplate across vacancies, not a job-specific description - there is no
// responsibilities/requirements text anywhere in this API.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://career.samolet.ru";
const LIST_API = `${ORIGIN}/api/integrations/skillaz/vacancies/`;
const PAGE_SIZE = 100;
const KIND_PREFIX = /^site:samolet:/;

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:samolet" is itself two
// segments, so it would only strip "site:" and leave "samolet:53404" - use our own full-prefix strip.
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

interface SamoletDictItem {
  id: number;
  skillazId: string;
  name: string;
  isActive: boolean;
}

export interface SamoletVacancy {
  id: number;
  uuid: string;
  name: string;
  education?: SamoletDictItem;
  workExperiences?: SamoletDictItem;
  specialization?: SamoletDictItem;
  region?: SamoletDictItem;
  workplaceType?: SamoletDictItem;
  workSchedule?: SamoletDictItem;
  employmentType?: SamoletDictItem;
  externalUrl?: string;
  whySamolet?: string;
}

interface SamoletListPage {
  count: number;
  next: string | null;
  results: SamoletVacancy[];
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "career.samolet.ru" ? { token: ORIGIN } : null;
}

const vacancyUrl = (v: SamoletVacancy): string => v.externalUrl || `${ORIGIN}/vakansii/view/${v.uuid}/`;

const toDiscovered = (v: SamoletVacancy): Discovered => ({
  externalId: atsId("site:samolet", v.id),
  url: vacancyUrl(v),
  title: v.name,
  company: "Samolet",
  location: v.region?.name || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let page = 1;
  for (;;) {
    const data = await getJson<SamoletListPage>(`${LIST_API}?limit=${PAGE_SIZE}&page=${page}`);
    out.push(...data.results.map(toDiscovered));
    if (!data.next || data.results.length === 0) break;
    page += 1;
  }
  return out;
}

function descriptionOf(v: SamoletVacancy): string {
  const fields = [
    v.specialization?.name && `Специализация: ${v.specialization.name}`,
    v.workExperiences?.name && `Опыт: ${v.workExperiences.name}`,
    v.education?.name && `Образование: ${v.education.name}`,
  ].filter(Boolean);
  return [fields.join("\n"), stripHtml(v.whySamolet ?? "")].filter(Boolean).join("\n\n");
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const cached = d.raw as SamoletVacancy | undefined;
  const v =
    cached ??
    (await getJson<SamoletListPage>(`${LIST_API}?limit=${PAGE_SIZE}&page=1`)).results.find(
      (r) => String(r.id) === localId(d.externalId),
    );
  if (!v) throw new Error(`site:samolet: vacancy ${d.externalId} not found`);
  return makeVacancy({
    source: "site:samolet",
    externalId: d.externalId,
    url: vacancyUrl(v),
    title: v.name ?? d.title,
    company: "Samolet",
    descriptionText: descriptionOf(v),
    area: v.region?.name || d.location || "",
    workFormat: [v.workplaceType?.name, v.workSchedule?.name, v.employmentType?.name].filter(Boolean).join(", "),
  });
}

export const client: ATSClientImpl = {
  kind: "site:samolet",
  verified: true,
  notes:
    "public JSON API, no auth: GET /api/integrations/skillaz/vacancies/?limit=&page= (DRF pagination via " +
    "count/next; schema claims cookieAuth/tokenAuth but it works unauthenticated live); ~72 open vacancies " +
    "across all of Samolet as of 2026-09, listJobs returns all unfiltered. No detail-by-id endpoint exists - " +
    "the SPA detail page is client-rendered from the same list payload, so fetchJob reuses the raw item cached " +
    "by listJobs. Items have no job-specific responsibilities/requirements text, only structured taxonomy " +
    "fields (specialization/experience/education/region/workplace/schedule/employment type) and a generic, " +
    "identical-across-vacancies 'whySamolet' company-values blurb - descriptionText is built from those. " +
    "No salary field in the payload. Apply is POST /api/integrations/skillaz/vacancies/{id}/response/ " +
    "(multipart, resume + contact fields per VacancyResponseSerialzier) -> agent flow only, apply() omitted.",
  jobsUrl: () => `${LIST_API}?limit=${PAGE_SIZE}&page=1`,
  detect,
  listJobs,
  fetchJob,
};
