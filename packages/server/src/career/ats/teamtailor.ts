// Teamtailor career sites (verified 2026-09: https://<site>/jobs.rss is a public RSS feed with
// tt:department / tt:locations extensions; /jobs HTML lists <a href="/jobs/<id>-<slug>">).
// The token is the site origin so custom domains work too. No apply API → agent flow.
import type { Discovered } from "@sgz/shared";
import { extractLinks, getText, hostOf, originOf, stripHtml, tagText } from "../http.js";
import { makeVacancy, toISO } from "../vacancy.js";
import { atsId, type ATSClientImpl } from "./types.js";

const JOB_PATH = /\/jobs\/(\d+)(?:-[^/?#]*)?\/?$/;

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (/^[a-z0-9-]+\.teamtailor\.com$/.test(host) && !/^(www|app|api|cdn|developers|career)\.teamtailor\.com$/.test(host)) {
    return { token: originOf(baseUrl) };
  }
  const marker = /teamtailor\.com\/|data-teamtailor|<meta[^>]+content=["']teamtailor["']|["']teamtailor["']/i;
  return marker.test(html) && originOf(baseUrl) ? { token: originOf(baseUrl) } : null;
}

interface RssItem {
  id: string;
  title: string;
  link: string;
  description: string;
  pubDate: string;
  department: string;
  location: string;
}

function parseRss(xml: string): RssItem[] {
  const out: RssItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = m[1] ?? "";
    const link = tagText(item, "link") || tagText(item, "guid");
    const id = JOB_PATH.exec(link)?.[1] ?? link;
    if (!link) continue;
    const locBlock = tagText(item, "tt:locations");
    const location = [tagText(locBlock, "tt:city"), tagText(locBlock, "tt:country")].filter(Boolean).join(", ");
    out.push({
      id,
      title: stripHtml(tagText(item, "title")),
      link,
      description: stripHtml(tagText(item, "description")),
      pubDate: tagText(item, "pubDate"),
      department: tagText(item, "tt:department"),
      location,
    });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  try {
    const xml = await getText(`${origin}/jobs.rss`);
    const items = parseRss(xml);
    if (items.length) {
      return items.map((it) => ({
        externalId: atsId("teamtailor", it.id),
        url: it.link,
        title: it.title,
        company: "",
        location: it.location || undefined,
        raw: it,
      }));
    }
  } catch {
    // fall through to the HTML listing
  }
  const html = await getText(`${origin}/jobs`);
  const seen = new Set<string>();
  const out: Discovered[] = [];
  for (const l of extractLinks(html, `${origin}/jobs`)) {
    const id = JOB_PATH.exec(l.href)?.[1];
    if (!id || seen.has(id) || !l.text) continue;
    seen.add(id);
    out.push({ externalId: atsId("teamtailor", id), url: l.href, title: l.text, company: "" });
  }
  return out;
}

async function fetchJob(_origin: string, d: Discovered) {
  const cached = d.raw as RssItem | undefined;
  const description = cached?.description ?? stripHtml(await getText(d.url));
  return makeVacancy({
    source: "teamtailor",
    externalId: d.externalId,
    url: d.url,
    title: cached?.title ?? d.title,
    company: d.company,
    descriptionText: description,
    area: cached?.location ?? d.location ?? "",
    publishedAt: toISO(cached?.pubDate),
  });
}

export const teamtailor: ATSClientImpl = {
  kind: "teamtailor",
  verified: true,
  notes: "jobs.rss feed public (token = site origin); no apply API → agent flow",
  jobsUrl: (origin) => `${origin}/jobs.rss`,
  detect,
  listJobs,
  fetchJob,
};
