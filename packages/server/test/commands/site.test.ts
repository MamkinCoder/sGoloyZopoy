import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type SqliteStore } from "../../src/db/index.js";
import { importCareerSites, parseCareerSitesCsv } from "../../src/commands/site.js";

const dirs: string[] = [];
const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("career site CSV import", () => {
  it("parses quoted commas, quotes, CRLF and multiline notes", () => {
    const csv = [
      "slug,name,category,base_url,note",
      'acme,"Acme, Inc.",Tech,https://acme.example/careers,"line one',
      'line ""two"""',
      "",
    ].join("\r\n");
    expect(parseCareerSitesCsv(csv)).toEqual([
      {
        slug: "acme",
        name: "Acme, Inc.",
        category: "Tech",
        baseUrl: "https://acme.example/careers",
        note: 'line one\r\nline "two"',
      },
    ]);
  });

  it("rejects invalid rows before any store mutation", () => {
    const store = openStore(":memory:");
    stores.push(store);
    const user = store.upsertUser({
      slug: "a",
      name: "A",
      tgChatId: "",
      dailyLimitHH: 1,
      dailyLimitCareer: 1,
      active: true,
      allowOtherCountry: false,
      poolExpandPerDay: 0,
      opusEnabled: false,
    });
    expect(() => parseCareerSitesCsv("slug,name,category,base_url,note\na,Name,Tech,ftp://a.example,\n")).toThrow(/base_url/);
    expect(store.listCareerSites(user.id)).toHaveLength(0);
  });

  it("upserts rows while preserving existing state", () => {
    const store = openStore(":memory:");
    stores.push(store);
    const user = store.upsertUser({
      slug: "a",
      name: "A",
      tgChatId: "",
      dailyLimitHH: 1,
      dailyLimitCareer: 1,
      active: true,
      allowOtherCountry: false,
      poolExpandPerDay: 0,
      opusEnabled: false,
    });
    const old = store.upsertCareerSite({
      userId: user.id,
      slug: "acme",
      name: "Old name",
      baseUrl: "https://old.example",
      ats: "custom",
      profile: { filters: ["go"], notes: "keep me" },
      enabled: false,
      lastRunAt: "2026-01-01T00:00:00.000Z",
    });
    const dir = mkdtempSync(join(tmpdir(), "sgz-site-csv-"));
    dirs.push(dir);
    const path = join(dir, "sites.csv");
    writeFileSync(path, "slug,name,category,base_url,note\nacme,New name,Tech,https://new.example,new note\nnew-site,New,Startup,https://new.example/careers,hello\n");
    const rows = parseCareerSitesCsv(readFileSync(path, "utf8"));
    expect(importCareerSites(store, user.id, rows)).toEqual({ created: 1, updated: 1 });
    expect(store.getCareerSite(old.id)).toMatchObject({
      id: old.id,
      name: "New name",
      baseUrl: "https://new.example",
      enabled: false,
      lastRunAt: "2026-01-01T00:00:00.000Z",
      profile: { filters: ["go"], notes: "keep me" },
    });
    expect(store.listCareerSites(user.id).find((site) => site.slug === "new-site")).toMatchObject({
      name: "New",
      profile: { notes: "Категория: Startup\nhello" },
      enabled: true,
      lastRunAt: null,
    });
  });
});
