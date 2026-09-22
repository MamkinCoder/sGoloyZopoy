// SmartRecruiters Posting API (verified 2026-09 against developers.smartrecruiters.com + live API).
// Public read; applying goes through the hosted form (applyUrl) → agent flow.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, pathSegments, stripHtml } from "../http.js";
import { makeVacancy, toISO } from "../vacancy.js";
import { atsId, firstMatch, rawId, slugRe, type ATSClientImpl } from "./types.js";

const API = "https://api.smartrecruiters.com/v1/companies";
const PAGE = 100;

export interface SRPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean; fullLocation?: string };
  company?: { identifier?: string; name?: string };
  typeOfEmployment?: { label?: string };
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(hostOf(baseUrl))) {
    const seg = pathSegments(baseUrl)[0];
    if (seg) return { token: seg };
  }
  const token = firstMatch(html, [
    new RegExp(`api\\.smartrecruiters\\.com/v1/companies/(${slugRe})`, "i"),
    new RegExp(`(?:jobs|careers)\\.smartrecruiters\\.com/(${slugRe})`, "i"),
  ]);
  return token ? { token } : null;
}

const locationOf = (p: SRPosting): string =>
  p.location?.fullLocation ?? [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(", ");

async function listJobs(token: string): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let offset = 0, i = 0; i < 5; i++, offset += PAGE) {
    const data = await getJson<{ content?: SRPosting[]; totalFound?: number }>(`${API}/${token}/postings?limit=${PAGE}&offset=${offset}`);
    const items = data.content ?? [];
    for (const p of items) {
      out.push({
        externalId: atsId("smartrecruiters", p.id),
        url: p.postingUrl ?? `https://jobs.smartrecruiters.com/${p.company?.identifier ?? token}/${p.id}`,
        title: p.name,
        company: p.company?.name ?? "",
        location: locationOf(p) || undefined,
        raw: p,
      });
    }
    if (items.length < PAGE || offset + PAGE >= (data.totalFound ?? 0)) break;
  }
  return out;
}

async function fetchJob(token: string, d: Discovered) {
  const p = await getJson<SRPosting>(`${API}/${token}/postings/${rawId(d.externalId)}`);
  const sections = p.jobAd?.sections ?? {};
  const description = ["jobDescription", "qualifications", "additionalInformation", "companyDescription"]
    .map((k) => sections[k])
    .filter((s): s is { title?: string; text?: string } => !!s?.text)
    .map((s) => `${s.title ? `${s.title}\n` : ""}${stripHtml(s.text ?? "")}`)
    .join("\n\n");
  return makeVacancy({
    source: "smartrecruiters",
    externalId: d.externalId,
    url: p.postingUrl ?? d.url,
    title: p.name ?? d.title,
    company: p.company?.name ?? d.company,
    descriptionText: description,
    area: locationOf(p) || d.location || "",
    workFormat: p.location?.remote ? "remote" : "",
    publishedAt: toISO(p.releasedDate),
  });
}

export const smartrecruiters: ATSClientImpl = {
  kind: "smartrecruiters",
  verified: true,
  notes: "list/detail public; no public apply API → agent flow (applyUrl)",
  jobsUrl: (token) => `${API}/${token}/postings?limit=${PAGE}`,
  detect,
  listJobs,
  fetchJob,
};
