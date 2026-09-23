// Kaspersky careers site (careers.kaspersky.ru), a Next.js app. No public JSON API: data ships
// embedded in the server-rendered HTML as a React Server Components "flight" payload
// (`self.__next_f.push([1,"<id>:[...]"])` chunks) - same shape as wb.ts/vk.ts's SPA data, but here
// it's present on every plain GET, no extra headers needed. Verified live 2026-09.
//   GET /vacancies?pageSize=<n>  -> HTML; one flight chunk holds `"vacancies":[{jobReqId,titles,
//                                   skills,cities,categories}, ...]`. Default pageSize is 13; the
//                                   full list (76 on 2026-09) needs an explicit larger pageSize -
//                                   values above ~300 return an empty page, so we ask for a safely
//                                   large-but-under-that number instead of paging.
//   GET /vacancy/{jobReqId}      -> HTML; full description (responsibilities + requirements) is
//                                   plain sanitized HTML inside `data-testid="vacancy-body"`.
// No salary anywhere in list or detail payloads. Apply is a client-rendered modal form (name,
// phone, email, resume upload, ref code) behind the "Откликнуться" button - no public apply API
// found, so apply() is omitted; agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://careers.kaspersky.ru";
const LIST_PAGE_SIZE = 250;

interface KLabel {
  code: string;
  name: string;
  engName?: string;
}

interface KVacancy {
  jobReqId: string;
  titles: { title: string; locale: string }[];
  skills?: KLabel[];
  cities?: KLabel[];
  categories?: KLabel[];
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "careers.kaspersky.ru" ? { token: ORIGIN } : null;
}

// Flight chunks are JSON string literals `self.__next_f.push([1,"<text>"])`; the ones we care about
// are `"<id>:<json>"` (list page) - decode each candidate and skip ones that aren't valid JSON strings.
function flightChunks(html: string): string[] {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,(".*?")\]\)/gs)].flatMap((m) => {
    try {
      return [JSON.parse(m[1] ?? "") as string];
    } catch {
      return [];
    }
  });
}

// Extract a balanced JSON array/object starting right after `"<key>":` in a larger JS-string blob.
function extractJsonValueAfter(text: string, key: string): unknown {
  const marker = `"${key}":`;
  const start = text.indexOf(marker);
  if (start === -1) return undefined;
  let i = start + marker.length;
  const openChar = text[i];
  if (openChar !== "[" && openChar !== "{") return undefined;
  const closeChar = openChar === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start + marker.length, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function parseVacancies(html: string): KVacancy[] {
  for (const chunk of flightChunks(html)) {
    const value = extractJsonValueAfter(chunk, "vacancies");
    if (Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null && "jobReqId" in v)) {
      return value as KVacancy[];
    }
  }
  return [];
}

const titleOf = (v: KVacancy): string => v.titles[0]?.title ?? "";
const cityOf = (v: KVacancy): string => v.cities?.[0]?.name ?? "";

const toDiscovered = (v: KVacancy): Discovered => ({
  externalId: atsId("site:kaspersky", v.jobReqId),
  url: `${ORIGIN}/vacancy/${v.jobReqId}`,
  title: titleOf(v),
  company: "Kaspersky",
  location: cityOf(v) || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(`${ORIGIN}/vacancies?pageSize=${LIST_PAGE_SIZE}`);
  return parseVacancies(html).filter((v) => titleOf(v)).map(toDiscovered);
}

// The description lives as raw sanitized HTML right inside data-testid="vacancy-body"; it contains
// only inline/list markup (no nested <div>), so the first following </div> closes the block.
function descriptionOf(html: string): string {
  const start = html.indexOf('data-testid="vacancy-body"');
  if (start === -1) return "";
  const bodyStart = html.indexOf(">", start) + 1;
  const bodyEnd = html.indexOf("</div>", bodyStart);
  if (bodyEnd === -1) return "";
  return stripHtml(decodeEntities(html.slice(bodyStart, bodyEnd)));
}

function cityFromDetail(html: string): string {
  const m = /vacancy-tag-city-[^"]*"[^>]*>([^<]*)</.exec(html);
  return m?.[1]?.trim() ?? "";
}

async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as KVacancy | undefined;
  const html = await getText(d.url);
  return makeVacancy({
    source: "site:kaspersky",
    externalId: d.externalId,
    url: d.url,
    title: cached ? titleOf(cached) : d.title,
    company: "Kaspersky",
    descriptionText: descriptionOf(html),
    area: cityFromDetail(html) || cached?.cities?.[0]?.name || d.location || "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:kaspersky",
  verified: true,
  notes:
    "no public JSON API; list is a Next.js flight payload embedded in GET /vacancies?pageSize=250 HTML " +
    "(default pageSize is 13, values above ~300 return an empty list); detail description is plain " +
    "sanitized HTML inside data-testid=\"vacancy-body\" on GET /vacancy/{jobReqId}; no salary ever exposed; " +
    "apply is a client-rendered modal form (name, phone, email, resume upload, optional referral code) " +
    "behind the \"Откликнуться\" button, no public apply API found -> agent flow only",
  jobsUrl: () => `${ORIGIN}/vacancies?pageSize=${LIST_PAGE_SIZE}`,
  detect,
  listJobs,
  fetchJob,
};
