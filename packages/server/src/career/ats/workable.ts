// Workable hosted careers (apply.workable.com). UNVERIFIED: the v3 listing is POST-only and could not
// be exercised from here; shapes below follow the public widget/v3 responses as known. Defensive parsing.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, pathSegments, postJson, stripHtml } from "../http.js";
import { makeVacancy, toISO } from "../vacancy.js";
import { atsId, firstMatch, rawId, slugRe, type ATSClientImpl } from "./types.js";

const BASE = "https://apply.workable.com";

interface WorkableJob {
  id?: string | number;
  shortcode: string;
  title: string;
  remote?: boolean;
  location?: { city?: string; country?: string; region?: string; workplaceType?: string } | null;
  published?: string;
  published_on?: string;
  description?: string;
  requirements?: string;
  benefits?: string;
  url?: string;
  workplace?: string;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (host === "apply.workable.com") {
    const seg = pathSegments(baseUrl)[0];
    if (seg && seg !== "api") return { token: seg };
  }
  const sub = /^([a-z0-9-]+)\.workable\.com$/.exec(host)?.[1];
  if (sub && !["apply", "www", "help", "resources"].includes(sub)) return { token: sub };
  const token = firstMatch(html, [
    new RegExp(`apply\\.workable\\.com/api/v\\d/(?:widget/)?accounts/(${slugRe})`, "i"),
    new RegExp(`workable\\.com/api/accounts/(${slugRe})`, "i"),
    new RegExp(`apply\\.workable\\.com/(${slugRe})/?["'/]`, "i"),
  ]);
  return token && token !== "api" ? { token } : null;
}

const jobUrl = (token: string, j: WorkableJob): string => j.url ?? `${BASE}/${token}/j/${j.shortcode}/`;

const locationOf = (j: WorkableJob): string =>
  [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(", ");

async function listJobs(token: string): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let page: string | null = null;
  for (let i = 0; i < 10; i++) {
    const body: Record<string, unknown> = { query: "", location: [], department: [], worktype: [], remote: [] };
    if (page) body.token = page;
    const data = await postJson<{ results?: WorkableJob[]; nextPage?: string | null }>(`${BASE}/api/v3/accounts/${token}/jobs`, body);
    for (const j of data.results ?? []) {
      out.push({
        externalId: atsId("workable", j.shortcode),
        url: jobUrl(token, j),
        title: j.title,
        company: "",
        location: locationOf(j) || undefined,
        raw: j,
      });
    }
    page = data.nextPage ?? null;
    if (!page || !(data.results ?? []).length) break;
  }
  return out;
}

async function fetchJob(token: string, d: Discovered) {
  const j = await getJson<WorkableJob>(`${BASE}/api/v2/accounts/${token}/jobs/${rawId(d.externalId)}`);
  const description = [j.description, j.requirements && `Requirements\n${j.requirements}`, j.benefits && `Benefits\n${j.benefits}`]
    .filter(Boolean)
    .map((s) => stripHtml(String(s)))
    .join("\n\n");
  return makeVacancy({
    source: "workable",
    externalId: d.externalId,
    url: d.url,
    title: j.title ?? d.title,
    company: d.company,
    descriptionText: description,
    area: locationOf(j) || d.location || "",
    workFormat: j.location?.workplaceType ?? j.workplace ?? (j.remote ? "remote" : ""),
    publishedAt: toISO(j.published ?? j.published_on),
  });
}

export const workable: ATSClientImpl = {
  kind: "workable",
  verified: false,
  notes: "v3 listing (POST) + v2 detail unverified from here; no apply API → agent flow",
  jobsUrl: (token) => `${BASE}/api/v3/accounts/${token}/jobs`,
  detect,
  listJobs,
  fetchJob,
};
