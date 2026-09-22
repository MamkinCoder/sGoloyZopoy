// Ashby public posting API (verified 2026-09 against developers.ashbyhq.com + live board).
// No documented public apply endpoint → apply is left to the agent flow.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, pathSegments, stripHtml } from "../http.js";
import { makeVacancy, toISO } from "../vacancy.js";
import { atsId, firstMatch, rawId, slugRe, type ATSClientImpl } from "./types.js";

const API = "https://api.ashbyhq.com/posting-api/job-board";

export interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  department?: string;
  team?: string;
  jobUrl: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  employmentType?: string;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "jobs.ashbyhq.com") {
    const seg = pathSegments(baseUrl)[0];
    if (seg) return { token: seg };
  }
  const token = firstMatch(html, [
    new RegExp(`api\\.ashbyhq\\.com/posting-api/job-board/(${slugRe})`, "i"),
    new RegExp(`jobs\\.ashbyhq\\.com/(${slugRe})`, "i"),
  ]);
  return token ? { token } : null;
}

const toDiscovered = (j: AshbyJob): Discovered => ({
  externalId: atsId("ashby", j.id),
  url: j.jobUrl,
  title: j.title,
  company: "",
  location: j.location ?? undefined,
  raw: j,
});

async function loadBoard(token: string): Promise<AshbyJob[]> {
  const data = await getJson<{ jobs: AshbyJob[] }>(`${API}/${token}`);
  return (data.jobs ?? []).filter((j) => j.isListed !== false);
}

async function listJobs(token: string): Promise<Discovered[]> {
  return (await loadBoard(token)).map(toDiscovered);
}

async function fetchJob(token: string, d: Discovered) {
  const cached = d.raw as AshbyJob | undefined;
  let job = cached?.title ? cached : undefined;
  if (!job) {
    const id = rawId(d.externalId);
    job = (await loadBoard(token)).find((j) => j.id === id);
    if (!job) throw new Error(`ashby: job ${id} not found on board ${token}`);
  }
  return makeVacancy({
    source: "ashby",
    externalId: d.externalId,
    url: job.jobUrl ?? d.url,
    title: job.title,
    company: d.company,
    descriptionText: job.descriptionPlain ?? stripHtml(job.descriptionHtml ?? ""),
    area: job.location ?? d.location ?? "",
    workFormat: job.workplaceType ?? (job.isRemote ? "remote" : ""),
    publishedAt: toISO(job.publishedAt),
  });
}

export const ashby: ATSClientImpl = {
  kind: "ashby",
  verified: true,
  notes: "list/detail public (job-board endpoint); no public apply API → agent flow",
  jobsUrl: (token) => `${API}/${token}`,
  detect,
  listJobs,
  fetchJob,
};
