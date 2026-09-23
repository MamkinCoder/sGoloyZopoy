// Sber careers site (rabota.sber.ru), a Next.js SPA. The homepage is a static promo page; the
// real listing lives client-side on /search and calls a public JSON API found in the SPA's JS
// bundles (chunk with the vacancy-card component, verified live 2026-09):
//   GET /public/app-candidate-public-api-gateway/api/v1/publications?skip=&take=  -> paginated list,
//     max take=100 (server caps it silently), full descriptions already inline (no detail call
//     needed - fetchJob just re-reads the cached raw payload from listJobs).
// Canonical vacancy URLs are /search/{slug}-{internalId}/ per https://rabota.sber.ru/sitemap/; the
// SPA route only cares about the trailing internalId, so a slug-less /search/{internalId}/ 200s too.
// workScheduleId is a small closed enum from GET .../api/v1/schedules (1 Полный день, 2 Сменный
// график, 3 Гибкий график, 4 Удаленная работа, 5 Вахта) - hardcoded here rather than fetched.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://rabota.sber.ru";
const LIST_API = `${ORIGIN}/public/app-candidate-public-api-gateway/api/v1/publications`;
const PAGE_SIZE = 100;

const SCHEDULES: Record<number, string> = {
  1: "Полный день",
  2: "Сменный график",
  3: "Гибкий график",
  4: "Удаленная работа",
  5: "Вахта",
};

export interface SberVacancy {
  requisitionId: string;
  internalId: number;
  title: string;
  introduction?: string;
  duties?: string;
  requirements?: string;
  conditions?: string;
  city?: string;
  region?: string;
  salary_min?: number | null;
  salary_max?: number | null;
  workScheduleId?: number;
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "rabota.sber.ru" ? { token: "rabota.sber.ru" } : null;
}

const vacancyUrl = (internalId: number): string => `${ORIGIN}/search/${internalId}/`;

const toDiscovered = (v: SberVacancy): Discovered => ({
  externalId: atsId("site:sber", v.internalId),
  url: vacancyUrl(v.internalId),
  title: v.title,
  company: "Sber",
  location: v.city || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let skip = 0;
  for (;;) {
    const page = await getJson<{ data: { vacancies: SberVacancy[]; total: number } }>(`${LIST_API}?skip=${skip}&take=${PAGE_SIZE}`);
    const items = page.data?.vacancies ?? [];
    out.push(...items.map(toDiscovered));
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

// The list payload already carries full descriptions, so fetchJob needs no extra HTTP call when
// listJobs's Discovered.raw is available; it only re-fetches by id as a fallback (e.g. raw missing).
async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as SberVacancy | undefined;
  const v =
    cached ??
    (await getJson<{ data: { vacancies: SberVacancy[] } }>(`${LIST_API}?skip=0&take=1&internalId=${rawId(d.externalId)}`)).data.vacancies[0];
  if (!v) throw new Error(`sber: vacancy ${d.externalId} not found`);
  return makeVacancy({
    source: "site:sber",
    externalId: d.externalId,
    url: d.url,
    title: v.title ?? d.title,
    company: "Sber",
    descriptionText: descriptionOf(v),
    area: v.city || d.location || "",
    workFormat: v.workScheduleId ? (SCHEDULES[v.workScheduleId] ?? "") : "",
    salaryFrom: v.salary_min ?? 0,
    salaryTo: v.salary_max ?? 0,
    currency: v.salary_min || v.salary_max ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:sber",
  verified: true,
  notes:
    "public JSON API, no auth: GET /public/app-candidate-public-api-gateway/api/v1/publications?skip=&take= " +
    "(take capped at 100 server-side; ~3300 open vacancies across all of Sber Group as of 2026-09, listJobs " +
    "returns all unfiltered); list items already include full description (introduction/duties/requirements/" +
    "conditions) so fetchJob reuses the cached payload from listJobs and makes no extra request; canonical " +
    "url is /search/{internalId}/ per the sitemap, confirmed the SPA route ignores the slug text; apply is a " +
    "client-rendered form on the vacancy page (resume upload, contact fields, no visible captcha in the HTML " +
    "but not confirmed past that point) -> agent flow only, no public apply API found",
  jobsUrl: () => `${LIST_API}?skip=0&take=${PAGE_SIZE}`,
  detect,
  listJobs,
  fetchJob,
};
