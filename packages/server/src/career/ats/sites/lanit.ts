// LANIT careers portal. lanit.ru itself has no /career page; the real career site is a SharePoint-hosted
// SPA at job.lanit.ru ("Карьера в ЛАНИТ", found via crt.sh cert-transparency search for *.lanit.ru — DNS
// for the base_url given in the brief, career.lanit.ru, does not resolve at all). SharePoint anonymous
// REST access is enabled: every open vacancy is a publishing page in the "Страницы" list of the /vacancy
// subsite, found by reading a helper script referenced from the SPA's app shell
// (/_layouts/15/lanit.job.vacancy.external/js/initnewexternalvacancybutton.js, which hardcodes
// /vacancy/Pages/Forms/AllItems.aspx). Verified live 2026-09 (65 open vacancies across LANIT group
// brands, e.g. bpm, ДКС).
//   GET /vacancy/_api/web/lists/getbytitle('Страницы')/items
//       ?$select=...&$filter=VacancyExt_Status eq 'Опубликовано'&$top=5000&$inlinecount=allpages
//     -> JSON (SharePoint OData v2 "verbose"), one row per open vacancy, no real pagination needed
//        (65 rows, well under the $top cap); VacancyExt_Status is a free-text choice field, exact
//        published value is "Опубликовано" ("Не опубликована" for drafts/closed).
//   GET /vacancy/_api/web/lists/getbytitle('Страницы')/items({id})
//     -> JSON; VacancyExt_JobResponsibilities / VacancyExt_Requirements / VacancyExt_SocialPackageNew
//        are HTML fragments (plain-text after stripping tags), VacancyExt_HuntflowCityName is the area,
//        VacancyExt_TopDivision is the LANIT group brand actually hiring (e.g. "bpm"). No salary field.
// Public detail page is job.lanit.ru/Pages/vacancy.aspx?ItemId={id} (canonical redirect target of
// /vacancy/Pages/{id}.aspx); apply is a SharePoint form at /hrportal/vacancy/Pages/Response.aspx?VacancyId=
// {guid} (name/contacts/resume upload, requires the site's own login flow) -> agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.lanit.ru";
const LIST_URL = `${ORIGIN}/vacancy/_api/web/lists/getbytitle('%D0%A1%D1%82%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D1%8B')/items`;
const PUBLISHED_FILTER = "VacancyExt_Status eq 'Опубликовано'";
const COMPANY = "LANIT";

interface LanitListItem {
  Id: number;
  Title: string;
  VacancyExt_HuntflowCityName?: string | null;
}

interface LanitListResponse {
  d: { results: LanitListItem[] };
}

interface LanitDetail {
  Id: number;
  Title: string;
  VacancyExt_JobResponsibilities?: string | null;
  VacancyExt_Requirements?: string | null;
  VacancyExt_SocialPackageNew?: string | null;
  VacancyExt_HuntflowCityName?: string | null;
}

interface LanitDetailResponse {
  d: LanitDetail;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (host === "job.lanit.ru" || (host === "lanit.ru" && /job\.lanit\.ru\/(vacancy|Pages\/vacancy)/i.test(html))) {
    return { token: ORIGIN };
  }
  return /job\.lanit\.ru\/vacancy\/_api\/web\/lists/i.test(html) ? { token: ORIGIN } : null;
}

const detailUrl = (id: number | string): string => `${ORIGIN}/Pages/vacancy.aspx?ItemId=${id}`;

const listUrl = (): string => `${LIST_URL}?$select=Id,Title,VacancyExt_HuntflowCityName&$filter=${encodeURIComponent(PUBLISHED_FILTER)}&$top=5000&$inlinecount=allpages`;

const toDiscovered = (v: LanitListItem): Discovered => ({
  externalId: atsId("site:lanit", v.Id),
  url: detailUrl(v.Id),
  title: v.Title.trim(),
  company: COMPANY,
  location: v.VacancyExt_HuntflowCityName || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const page = await getJson<LanitListResponse>(listUrl(), { headers: { accept: "application/json;odata=verbose" } });
  return (page.d?.results ?? []).map(toDiscovered);
}

function descriptionOf(d: LanitDetail): string {
  const section = (title: string, html?: string | null) => {
    const text = html ? stripHtml(decodeEntities(html)) : "";
    return text ? `${title}:\n${text}` : "";
  };
  return [
    section("Обязанности", d.VacancyExt_JobResponsibilities),
    section("Требования", d.VacancyExt_Requirements),
    section("Условия", d.VacancyExt_SocialPackageNew),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const id = d.externalId.replace(/^site:lanit:/, "");
  const res = await getJson<LanitDetailResponse>(`${LIST_URL}(${id})`, {
    headers: { accept: "application/json;odata=verbose" },
  });
  const v = res.d;
  return makeVacancy({
    source: "site:lanit",
    externalId: d.externalId,
    url: d.url,
    title: v.Title?.trim() || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.VacancyExt_HuntflowCityName || d.location || "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:lanit",
  verified: true,
  notes:
    "career.lanit.ru from the brief does not resolve; real site is the SharePoint SPA job.lanit.ru " +
    "(anonymous access enabled). List/detail are SharePoint's own OData REST API against the 'Страницы' " +
    "list under the /vacancy subsite, filtered to VacancyExt_Status eq 'Опубликовано'; no true pagination " +
    "needed (65 open jobs, well under the $top=5000 cap). No salary field exists in the schema. Public " +
    "detail page is /Pages/vacancy.aspx?ItemId={id}; apply is a SharePoint form at " +
    "/hrportal/vacancy/Pages/Response.aspx?VacancyId={guid} behind the site's own login -> agent flow only",
  jobsUrl: () => listUrl(),
  detect,
  listJobs,
  fetchJob,
};
