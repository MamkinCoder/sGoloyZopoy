import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as kode } from "../../../src/career/ats/sites/kode.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("kode ats client", () => {
  it("detects the KODE careers host", () => {
    expect(kode.detect("https://career.kode.ru/vacancy/ai-razrabotchik", "")).toEqual({ token: "https://career.kode.ru" });
    expect(kode.detect("https://kode.ru/career", "")).toEqual({ token: "https://career.kode.ru" });
    expect(kode.detect("https://example.com/careers", "")).toBeNull();
    expect(kode.detect("https://example.com/careers", "fetch('https://career.kode.ru/x')")).toEqual({
      token: "https://career.kode.ru",
    });
  });

  it("lists only published vacancies via the strapi graphql endpoint", async () => {
    const listJson = fixture("kode-list.json");
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: init.body as string });
        return jsonResponse(listJson);
      }),
    );

    const jobs = await kode.listJobs("https://career.kode.ru");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://strapi.kode.ru/graphql");
    const sentQuery = (JSON.parse(calls[0]!.body) as { query: string }).query;
    expect(sentQuery).toContain('status:"publish"');

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:kode:ai-razrabotchik",
      url: "https://career.kode.ru/vacancy/ai-razrabotchik",
      title: "AI-разработчик",
      company: "KODE",
      location: "Калининград, Удаленная работа",
    });
    // vacancy with no department/regions/conditions/levels is handled without throwing
    expect(jobs[2]).toMatchObject({ externalId: "site:kode:akkaunt-menedzher-1", location: undefined });
  });

  it("fetches a job's full text from graphql and cleans the markdown body", async () => {
    const detailJson = fixture("kode-detail.json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(detailJson)),
    );

    const discovered = {
      externalId: "site:kode:ai-razrabotchik",
      url: "https://career.kode.ru/vacancy/ai-razrabotchik",
      title: "AI-разработчик",
      company: "KODE",
      location: "Калининград, Удаленная работа",
    };
    const vacancy = await kode.fetchJob("https://career.kode.ru", discovered);

    expect(vacancy.source).toBe("site:kode");
    expect(vacancy.title).toBe("AI-разработчик");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("KODE");
    expect(vacancy.area).toBe("Калининград, Удаленная работа");
    expect(vacancy.workFormat).toBe("Полная занятость, Удаленная работа");
    expect(vacancy.descriptionText).toContain("Разрабатывать и поддерживать fullstack-решения на Node.js");
    expect(vacancy.descriptionText).toContain("Уверенное владение Python");
    expect(vacancy.descriptionText).toContain("Уровень: Middle, Senior");
    // markdown headers/emphasis markers are stripped
    expect(vacancy.descriptionText).not.toContain("####");
    expect(vacancy.descriptionText).not.toContain("**");
  });
});
