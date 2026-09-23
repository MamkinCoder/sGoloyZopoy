// Etazhi careers site (job.etagi.com -> redirects to a geo city subdomain, e.g. www.etagi.com or
// msk.etagi.com; verified live 2026-09 against www.etagi.com). It's a server-rendered custom
// Next.js-ish CMS (esoft.digital / "plugin.etagi" build) with no public REST API: every page ships
// a big inline `var data={...}` blob holding the page's already-fetched state. On /job/vacancies/
// that's data.objects.initialVacancies.vacancies (the full open list for that city, unpaginated -
// no "next page" in the wild). On a job's own page /job/<slug>-<officeId>-<positionId>/ the same
// shape reappears at data.objects.singleVacancy, so fetchJob re-requests the detail page rather than
// trusting the (possibly stale) listing snapshot. Confirmed the exact same object shape both places.
// Etazhi is a real-estate agency franchise, not a software company: vacancies are realtor/sales/HR/
// legal/marketing roles per city office, no dev/IT postings were found across several sampled
// cities - that's expected, not a bug in this client.
// No salary is guaranteed: `details.wages.moneyRange.amountRange` is `[from, to|null]` when present,
// absent entirely for "по итогам собеседования" roles.
// Apply is a client-rendered form on the vacancy page (name/phone + resume file upload), no public
// apply API found -> agent flow only, apply() omitted.
import type { Discovered } from "@sgz/shared";
import { getText, hostOf, originOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const DEFAULT_ORIGIN = "https://www.etagi.com";
const COMPANY = "Этажи";

interface EtazhiWages {
  moneyRange?: {
    amountRange?: [number | null, number | null];
    currencyAbbreviation?: string;
  };
}

interface EtazhiVacancy {
  id: number;
  details: {
    officeId: number;
    positionId: number;
    responsibilities?: string[];
    requirementsForCandidate?: string[];
    weOffer?: string[];
    workFormat?: { label?: string };
    wages?: EtazhiWages;
  };
  officeName?: string;
  departmentName?: string;
  positionName: string;
  transliteratedPositionName: string;
}

interface EtazhiPageData {
  objects: {
    initialVacancies?: { vacancies: EtazhiVacancy[] };
    singleVacancy?: EtazhiVacancy;
  };
}

// The whole SPA state ships as `var data={...};` in an inline <script>, ending right before
// </script>. No DOM/JS needed: JSON.parse the slice directly (server-rendered, not JS-computed).
function extractPageData(html: string): EtazhiPageData | null {
  const start = html.indexOf("var data=");
  if (start === -1) return null;
  const from = start + "var data=".length;
  const end = html.indexOf("</script>", from);
  if (end === -1) return null;
  const raw = html.slice(from, end).trim().replace(/;$/, "");
  try {
    return JSON.parse(raw) as EtazhiPageData;
  } catch {
    return null;
  }
}

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (/(^|\.)etagi\.com$/.test(host)) return { token: originOf(baseUrl) || DEFAULT_ORIGIN };
  return /etagi\.com\/job\/vacancies/i.test(html) ? { token: DEFAULT_ORIGIN } : null;
}

const vacancyUrl = (origin: string, v: Pick<EtazhiVacancy, "transliteratedPositionName" | "details">): string =>
  `${origin}/job/${v.transliteratedPositionName}-${v.details.officeId}-${v.details.positionId}/`;

const toDiscovered = (origin: string, v: EtazhiVacancy): Discovered => ({
  externalId: atsId("site:etazhi", v.id),
  url: vacancyUrl(origin, v),
  title: v.positionName,
  company: COMPANY,
  location: v.officeName ?? undefined,
  raw: v,
});

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}/job/vacancies/`);
  const data = extractPageData(html);
  const vacancies = data?.objects.initialVacancies?.vacancies ?? [];
  return vacancies.map((v) => toDiscovered(origin, v));
}

function descriptionOf(v: EtazhiVacancy): string {
  const d = v.details;
  const section = (heading: string, items: string[] | undefined): string =>
    items && items.length > 0 ? `${heading}:\n${items.map((i) => `- ${i}`).join("\n")}` : "";
  return [
    section("Обязанности", d.responsibilities),
    section("Требования", d.requirementsForCandidate),
    section("Компания предлагает", d.weOffer),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function salaryOf(v: EtazhiVacancy): { from: number; to: number; currency: string } {
  const range = v.details.wages?.moneyRange;
  const [from, to] = range?.amountRange ?? [null, null];
  return { from: from ?? 0, to: to ?? 0, currency: range?.currencyAbbreviation ?? "" };
}

async function fetchJob(origin: string, d: Discovered) {
  const html = await getText(d.url);
  const data = extractPageData(html);
  const v = data?.objects.singleVacancy ?? (d.raw as EtazhiVacancy | undefined);
  if (!v) throw new Error(`etazhi: vacancy data not found at ${d.url}`);
  const salary = salaryOf(v);
  return makeVacancy({
    source: "site:etazhi",
    externalId: d.externalId,
    url: vacancyUrl(origin, v),
    title: v.positionName,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    salaryFrom: salary.from,
    salaryTo: salary.to,
    currency: salary.currency,
    area: v.officeName ?? d.location ?? "",
    workFormat: v.details.workFormat?.label ?? "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:etazhi",
  verified: true,
  notes:
    "no public REST API; every page (list and detail) ships its already-fetched state inline as `var data={...}` " +
    "(esoft.digital CMS, 'plugin.etagi' internal protocol) - /job/vacancies/ has data.objects.initialVacancies.vacancies " +
    "(full open list for that city subdomain, unpaginated), a job's own /job/<slug>-<officeId>-<positionId>/ page has the " +
    "same shape at data.objects.singleVacancy; real-estate franchise, vacancies are realtor/sales/HR/legal/marketing roles " +
    "(no dev/IT postings found in sampled cities); salary optional ('по итогам собеседования' when absent); " +
    "apply is a client-rendered form (name/phone, resume file upload) with no public API -> agent flow only",
  jobsUrl: (origin) => `${origin}/job/vacancies/`,
  detect,
  listJobs,
  fetchJob,
};
