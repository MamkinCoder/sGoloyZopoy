// SberTech careers (sbertech.ru/career). sbertech.ru/career itself is a QRATOR-protected Next.js
// page (curl gets served a JS anti-bot challenge, no vacancy data in the HTML, verified live
// 2026-09) - not scrapable. SberTech vacancies are not published anywhere separately: they live
// inside Sber Group's own public JSON API (see sites/sber.ts), tagged with
// companyShortName: "AOSBT" (company: 'АО "СберТех"'), same shape and same canonical
// /search/{internalId}/ URLs as any other Sber Group vacancy. This client is that same API,
// filtered to AOSBT: GET /public/app-candidate-public-api-gateway/api/v1/publications?skip=&take=,
// max take=100 (server caps it silently). 41 open AOSBT vacancies out of ~3315 Sber Group total,
// verified live 2026-09.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";
import type { SberVacancy } from "./sber.js";

const ORIGIN = "https://rabota.sber.ru";
const LIST_API = `${ORIGIN}/public/app-candidate-public-api-gateway/api/v1/publications`;
const PAGE_SIZE = 100;
const COMPANY_SHORT_NAME = "AOSBT";
const COMPANY = "СберТех";

const SCHEDULES: Record<number, string> = {
  1: "Полный день",
  2: "Сменный график",
  3: "Гибкий график",
  4: "Удаленная работа",
  5: "Вахта",
};

// sbertech.ru/career itself has no ATS of its own (QRATOR-gated static page), so detect only
// matches the site's own host; the actual data comes from rabota.sber.ru regardless.
function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "sbertech.ru" ? { token: "sbertech.ru" } : null;
}

const vacancyUrl = (internalId: number): string => `${ORIGIN}/search/${internalId}/`;

const toDiscovered = (v: SberVacancy): Discovered => ({
  externalId: atsId("site:sbertech", v.internalId),
  url: vacancyUrl(v.internalId),
  title: v.title,
  company: COMPANY,
  location: v.city || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let skip = 0;
  for (;;) {
    const page = await getJson<{ data: { vacancies: (SberVacancy & { companyShortName?: string })[]; total: number } }>(
      `${LIST_API}?skip=${skip}&take=${PAGE_SIZE}`,
    );
    const items = page.data?.vacancies ?? [];
    out.push(...items.filter((v) => v.companyShortName === COMPANY_SHORT_NAME).map(toDiscovered));
    skip += items.length;
    if (items.length === 0 || skip >= (page.data?.total ?? 0)) break;
  }
  return out;
}

function descriptionOf(v: SberVacancy): string {
  const section = (title: string, text?: string) => (text?.trim() ? `${title}:\n${text.trim()}` : "");
  return [v.introduction ?? "", section("Обязанности", v.duties), section("Требования", v.requirements), section("Условия", v.conditions)]
    .filter(Boolean)
    .join("\n\n");
}

// Same trick as sber.ts: listJobs already fetched full descriptions, so fetchJob reuses the
// cached raw payload and only re-fetches by id as a fallback (e.g. raw missing).
async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as SberVacancy | undefined;
  const v =
    cached ??
    (await getJson<{ data: { vacancies: SberVacancy[] } }>(`${LIST_API}?skip=0&take=1&internalId=${rawId(d.externalId)}`)).data.vacancies[0];
  if (!v) throw new Error(`sbertech: vacancy ${d.externalId} not found`);
  return makeVacancy({
    source: "site:sbertech",
    externalId: d.externalId,
    url: d.url,
    title: v.title ?? d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.city || d.location || "",
    workFormat: v.workScheduleId ? (SCHEDULES[v.workScheduleId] ?? "") : "",
    salaryFrom: v.salary_min ?? 0,
    salaryTo: v.salary_max ?? 0,
    currency: v.salary_min || v.salary_max ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:sbertech",
  verified: true,
  notes:
    "sbertech.ru/career is QRATOR-gated (curl gets a JS anti-bot challenge, no data, verified live 2026-09) " +
    "-> not scrapable and not used. SberTech has no separate vacancy source: its openings live inside Sber " +
    "Group's own public JSON API (same one as site:sber), filtered to companyShortName='AOSBT' " +
    '(company=\'АО "СберТех"\'); 41 open AOSBT vacancies out of ~3315 Sber Group total as of 2026-09. Same ' +
    "endpoint, pagination, description assembly, canonical /search/{internalId}/ URL and no-extra-request " +
    "fetchJob as site:sber - this client only adds the company filter. Apply flow not confirmed beyond the " +
    "vacancy page (client-rendered form) -> agent flow only, no public apply API found.",
  jobsUrl: () => `${LIST_API}?skip=0&take=${PAGE_SIZE}`,
  detect,
  listJobs,
  fetchJob,
};
