import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { paths, type CareerSite, type Store } from "@sgz/shared";
import { ensureDirs, loadConfig } from "../config/index.js";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { runOnce } from "./run.js";

const USAGE = "usage: sgz site <list|add|import|onboard> --user <slug> [--csv <file>] [--url <https://...>] [--name <name>] [--slug <slug>] [--id <id>]";

const CSV_HEADERS = ["slug", "name", "category", "base_url", "note"] as const;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface CareerSiteCsvRow {
  slug: string;
  name: string;
  category: string;
  baseUrl: string;
  note: string;
}

/** Parse RFC 4180-style CSV, including quoted commas, quotes, CRLF and newlines. */
export function parseCareerSitesCsv(input: string): CareerSiteCsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  const text = input.replace(/^\uFEFF/, "");
  const pushRow = () => {
    if (row.length === 0 && field.trim() === "") {
      row = [];
      field = "";
      return;
    }
    rows.push([...row, field]);
    row = [];
    field = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (afterQuote) {
      if (ch === ",") {
        row.push(field);
        field = "";
        afterQuote = false;
      } else if (ch === "\n") {
        pushRow();
        afterQuote = false;
      } else if (ch === "\r" && text[i + 1] === "\n") {
        pushRow();
        i += 1;
        afterQuote = false;
      } else if (ch.trim() !== "") {
        throw new Error(`invalid CSV: unexpected character after closing quote at byte ${i}`);
      }
      continue;
    }
    if (ch === '"') {
      if (field !== "") throw new Error(`invalid CSV: quote in unquoted field at byte ${i}`);
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r" && text[i + 1] === "\n") {
      pushRow();
      i += 1;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error("invalid CSV: unterminated quoted field");
  if (afterQuote || field !== "" || row.length > 0) pushRow();
  if (rows.length === 0) throw new Error("CSV is empty");
  const header = rows[0]!.map((v) => v.trim());
  if (header.length !== CSV_HEADERS.length || header.some((v, i) => v !== CSV_HEADERS[i])) {
    throw new Error(`CSV header must be ${CSV_HEADERS.join(",")}`);
  }
  const seen = new Set<string>();
  return rows.slice(1).map((values, index) => {
    if (values.length !== CSV_HEADERS.length) throw new Error(`CSV row ${index + 2} must have ${CSV_HEADERS.length} fields`);
    const [rawSlug, rawName, rawCategory, rawBaseUrl, rawNote] = values;
    const slug = rawSlug!.trim();
    const name = rawName!.trim();
    const category = rawCategory!.trim();
    const baseUrl = rawBaseUrl!.trim();
    const note = rawNote!.trim();
    if (!SLUG_RE.test(slug)) throw new Error(`CSV row ${index + 2}: invalid slug ${JSON.stringify(slug)}`);
    if (seen.has(slug)) throw new Error(`CSV row ${index + 2}: duplicate slug ${slug}`);
    seen.add(slug);
    if (!name) throw new Error(`CSV row ${index + 2}: name is required`);
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    } catch {
      throw new Error(`CSV row ${index + 2}: base_url must be an http(s) URL`);
    }
    return { slug, name, category, baseUrl, note };
  });
}

export function importCareerSites(store: Pick<Store, "listCareerSites" | "upsertCareerSite">, userId: number, rows: CareerSiteCsvRow[]): { created: number; updated: number } {
  const existing = new Map(store.listCareerSites(userId).map((site) => [site.slug, site]));
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const old = existing.get(row.slug);
    const site: Omit<CareerSite, "id"> & { id?: number } = old
      ? { id: old.id, userId, slug: old.slug, name: row.name, baseUrl: row.baseUrl, ats: old.ats, profile: old.profile, enabled: old.enabled, lastRunAt: old.lastRunAt }
      : { userId, slug: row.slug, name: row.name, baseUrl: row.baseUrl, ats: "custom", profile: { notes: [row.category && `Категория: ${row.category}`, row.note].filter(Boolean).join("\n") }, enabled: false, lastRunAt: null };
    store.upsertCareerSite(site);
    if (old) updated += 1;
    else created += 1;
  }
  return { created, updated };
}

export async function site(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || !["list", "add", "import", "onboard"].includes(sub)) throw new Error(USAGE);
  const { values } = parseArgs({ args: rest, strict: true, options: {
    user: { type: "string", short: "u" }, csv: { type: "string" }, url: { type: "string" },
    name: { type: "string" }, slug: { type: "string" }, id: { type: "string" },
  } });
  if (!values.user) throw new Error(`--user is required\n${USAGE}`);
  if (sub === "import" && !values.csv) throw new Error("--csv is required");
  let url: URL | undefined;
  if (sub === "add") {
    if (!values.url) throw new Error("--url is required");
    url = new URL(values.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("--url must use http or https");
  }
  const id = Number(values.id);
  if (sub === "onboard" && (!Number.isSafeInteger(id) || id <= 0)) throw new Error("--id must be a positive integer");
  const csvRows = sub === "import" ? parseCareerSitesCsv(readFileSync(resolve(values.csv!), "utf8")) : null;
  const cfg = loadConfig();
  ensureDirs(cfg);
  const store = openStore(paths.db(cfg));
  try {
    seedDefaultUsers(store);
    const user = store.getUserBySlug(values.user);
    if (!user) throw new Error(`unknown user: ${values.user}`);
    if (sub === "list") {
      console.log(JSON.stringify(store.listCareerSites(user.id), null, 2));
      return;
    }
    if (sub === "add") {
      const slug = values.slug ?? url!.hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-");
      if (!SLUG_RE.test(slug)) throw new Error("--slug must contain lowercase letters, digits and hyphens");
      if (store.listCareerSites(user.id).some((s) => s.slug === slug)) throw new Error(`site ${slug} already exists; edit it in the panel`);
      console.log(JSON.stringify(store.upsertCareerSite({ userId: user.id, slug, name: values.name ?? url!.hostname,
        baseUrl: url!.href, ats: "custom", profile: {}, enabled: true, lastRunAt: null }), null, 2));
      return;
    }
    if (sub === "import") {
      console.log(JSON.stringify(importCareerSites(store, user.id, csvRows!), null, 2));
      return;
    }
    const existing = store.getCareerSite(id);
    if (!existing || existing.userId !== user.id) throw new Error(`site ${id} not found for ${user.slug}`);
    if (!existing.enabled) throw new Error(`site ${id} is disabled; enable it in the panel first`);
  } finally {
    store.close();
  }
  process.exitCode = await runOnce({ userSlug: values.user, source: "career", stage: `onboard:${id}`, dryRun: false, limit: 0 });
}
