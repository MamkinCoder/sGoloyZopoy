// Lever Postings API (verified 2026-09 against github.com/lever/postings-api + live board).
// Listing is public; POSTing an application requires the site's Postings API key (?key=),
// so `apply` runs only when LEVER_API_KEY is set; otherwise the agent flow applies.
import { Status } from "@sgz/shared";
import type { CareerApplyRequest, CareerApplyResult, Discovered } from "@sgz/shared";
import { getJson, hostOf, httpFetch, pathSegments, stripHtml } from "../http.js";
import { makeVacancy, toISO } from "../vacancy.js";
import { fileFromPath } from "./apply-common.js";
import { atsId, firstMatch, rawId, slugRe, type ATSClientImpl } from "./types.js";

const API = "https://api.lever.co/v0/postings";

export interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  categories?: { commitment?: string; location?: string; team?: string; department?: string; allLocations?: string[] };
  descriptionPlain?: string;
  description?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
  createdAt?: number;
  workplaceType?: string;
  country?: string;
  salaryRange?: { min?: number; max?: number; currency?: string };
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (/^jobs(\.eu)?\.lever\.co$/.test(hostOf(baseUrl))) {
    const seg = pathSegments(baseUrl)[0];
    if (seg) return { token: seg };
  }
  const token = firstMatch(html, [
    new RegExp(`api\\.lever\\.co/v0/postings/(${slugRe})`, "i"),
    new RegExp(`jobs(?:\\.eu)?\\.lever\\.co/(${slugRe})`, "i"),
  ]);
  return token ? { token } : null;
}

const toDiscovered = (p: LeverPosting): Discovered => ({
  externalId: atsId("lever", p.id),
  url: p.hostedUrl,
  title: p.text,
  company: "",
  location: p.categories?.location ?? undefined,
  raw: p,
});

async function listJobs(token: string): Promise<Discovered[]> {
  const data = await getJson<LeverPosting[]>(`${API}/${token}?mode=json`);
  return (Array.isArray(data) ? data : []).map(toDiscovered);
}

export function leverDescription(p: LeverPosting): string {
  const parts = [p.descriptionPlain ?? stripHtml(p.description ?? "")];
  for (const l of p.lists ?? []) parts.push(`${l.text}\n${stripHtml(l.content)}`);
  if (p.additionalPlain) parts.push(p.additionalPlain);
  return parts.filter(Boolean).join("\n\n");
}

async function fetchJob(token: string, d: Discovered) {
  const cached = d.raw as LeverPosting | undefined;
  const p = cached?.text ? cached : await getJson<LeverPosting>(`${API}/${token}/${rawId(d.externalId)}`);
  return makeVacancy({
    source: "lever",
    externalId: d.externalId,
    url: p.hostedUrl ?? d.url,
    title: p.text ?? d.title,
    company: d.company,
    descriptionText: leverDescription(p),
    area: p.categories?.location ?? d.location ?? "",
    workFormat: p.workplaceType ?? "",
    salaryFrom: p.salaryRange?.min ?? 0,
    salaryTo: p.salaryRange?.max ?? 0,
    currency: p.salaryRange?.currency ?? "",
    publishedAt: toISO(p.createdAt),
  });
}

async function apply(token: string, req: CareerApplyRequest): Promise<CareerApplyResult | null> {
  const key = process.env.LEVER_API_KEY ?? "";
  if (!key) return null;
  const fd = new FormData();
  fd.append("name", req.profile.full_name);
  fd.append("email", req.profile.email);
  if (req.profile.phone) fd.append("phone", req.profile.phone);
  fd.append("resume", await fileFromPath(req.resumePdfPath));
  if (req.coverLetter) fd.append("comments", req.coverLetter);
  if (req.dryRun) return { status: Status.SKIP_DRY_RUN, reasonDetail: "lever api dry run", questions: [], answers: [] };

  const res = await httpFetch(`${API}/${token}/${rawId(req.vacancy.externalId)}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    body: fd,
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; applicationId?: string; error?: string };
  if (!res.ok || body.ok === false) {
    return { status: Status.FAILED_NO_CONFIRMATION, reasonDetail: `lever api HTTP ${res.status}: ${body.error ?? ""}` };
  }
  return { status: Status.SENT, reasonDetail: `lever api applicationId=${body.applicationId ?? "?"}` };
}

export const lever: ATSClientImpl = {
  kind: "lever",
  verified: true,
  notes: "list/detail public; apply via API needs LEVER_API_KEY (?key=), else agent flow",
  jobsUrl: (token) => `${API}/${token}?mode=json`,
  detect,
  listJobs,
  fetchJob,
  apply,
};
