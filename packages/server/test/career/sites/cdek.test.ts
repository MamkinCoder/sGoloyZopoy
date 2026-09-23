import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as cdek } from "../../../src/career/ats/sites/cdek.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cdek ats client", () => {
  it("detects the rabota.cdek.ru careers host", () => {
    expect(cdek.detect("https://rabota.cdek.ru/vacancies", "")).toEqual({ token: "https://rabota.cdek.ru" });
    expect(cdek.detect("https://example.com/careers", "")).toBeNull();
    expect(cdek.detect("https://example.com/careers", "see rabota.cdek.ru/vacancies for openings")).toEqual({
      token: "https://rabota.cdek.ru",
    });
  });

  it("lists jobs from the POST /api/vacancies HTML fragment", async () => {
    const page = fixture("cdek-vacancies-it.json");
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return jsonResponse(page);
      }),
    );

    const jobs = await cdek.listJobs();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://rabota.cdek.ru/api/vacancies");
    expect(calls[0]?.body).toMatchObject({ page: 1, subdirections: [] });
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.externalId).sort()).toEqual(["site:cdek:12406", "site:cdek:12938", "site:cdek:13096"]);
    const backend = jobs.find((j) => j.externalId === "site:cdek:12406");
    expect(backend).toMatchObject({
      url: "https://rabota.cdek.ru/vacancies/item/12406",
      title: "Senior Backend developer (PHP) CDEK.Shopping",
      company: "CDEK",
      location: "Москва, пр. Завода Серп и Молот, 3, корп. 2, Москва",
    });
    const kladovshchik = jobs.find((j) => j.externalId === "site:cdek:13096");
    expect(kladovshchik?.title).toBe("Кладовщик");
  });

  it("stops paginating once currentPage reaches totalPages", async () => {
    const onePage = JSON.stringify({ vacancies: "", pagination: { currentPage: 1, totalPages: 1 } });
    const calls: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { page: number };
        calls.push(body.page);
        return jsonResponse(onePage);
      }),
    );

    await cdek.listJobs();

    expect(calls).toEqual([1]);
  });

  it("fetches a job's full text with salary parsed from free-form price", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(fixture("cdek-vacancy-12406.html"))),
    );

    const v = await cdek.fetchJob("https://rabota.cdek.ru", {
      externalId: "site:cdek:12406",
      url: "https://rabota.cdek.ru/vacancies/item/12406",
      title: "Senior Backend developer (PHP) CDEK.Shopping",
      company: "CDEK",
    });

    expect(v.title).toBe("Senior Backend developer (PHP) CDEK.Shopping");
    expect(v.company).toBe("CDEK");
    expect(v.descriptionText).toContain("Разрабатывать микросервисы");
    expect(v.descriptionText).toContain("ElasticSearch");
    expect(v.descriptionText).not.toContain("<");
    expect(v.area).toBe("Москва, пр. Завода Серп и Молот, 3, корп. 2, Москва");
    expect(v.workFormat).toBe("можно удалённо, полный день");
    expect(v.salaryFrom).toBe(0);
    expect(v.salaryTo).toBe(0);
    expect(v.currency).toBe("");
  });

  it("parses a 'от N Руб.' price into salaryFrom with no salaryTo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(fixture("cdek-vacancy-13096.html"))),
    );

    const v = await cdek.fetchJob("https://rabota.cdek.ru", {
      externalId: "site:cdek:13096",
      url: "https://rabota.cdek.ru/vacancies/item/13096",
      title: "Кладовщик",
      company: "CDEK",
    });

    expect(v.salaryFrom).toBe(103600);
    expect(v.salaryTo).toBe(0);
    expect(v.currency).toBe("RUR");
    expect(v.area).toBe("Санкт-Петербург, Софийская 118");
    expect(v.workFormat).toBe("сменный график");
  });
});
