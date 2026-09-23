import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as aeroflot } from "../../../src/career/ats/sites/aeroflot.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("aeroflot ats client", () => {
  it("detects the vacancy.aeroflot.ru host", () => {
    expect(aeroflot.detect("https://vacancy.aeroflot.ru/ru-ru/search", "")).toEqual({ token: "https://vacancy.aeroflot.ru" });
    expect(aeroflot.detect("https://example.com/career", "")).toBeNull();
    expect(aeroflot.detect("https://example.com/career", "fetch('/api/PublicVacancies/items')")).toEqual({
      token: "https://vacancy.aeroflot.ru",
    });
  });

  it("lists jobs across every category and merges, sending the RU LanguageId header each call", async () => {
    const calls: { url: string; body: unknown; languageId: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        calls.push({ url, body: JSON.parse(String(init.body)), languageId: headers.get("languageid") });
        if (url.endsWith("/PublicDictionaries/Categories")) return jsonResponse(fixture("aeroflot-categories.json"));
        const body = JSON.parse(String(init.body)) as { data: { categoriesIds: number[] } };
        const categoryId = body.data.categoriesIds[0];
        if (categoryId === 1) return jsonResponse(fixture("aeroflot-items-cat1.json"));
        if (categoryId === 6) return jsonResponse(fixture("aeroflot-items-cat6.json"));
        if (categoryId === 8) return jsonResponse(fixture("aeroflot-items-cat8.json"));
        throw new Error(`unexpected categoryId ${categoryId}`);
      }),
    );

    const jobs = await aeroflot.listJobs("https://vacancy.aeroflot.ru");

    expect(calls).toHaveLength(4); // 1 categories call + 3 per-category items calls
    expect(calls.every((c) => c.languageId === "RU")).toBe(true);
    expect(calls[0]?.url).toBe("https://vacancy.aeroflot.ru/api/PublicDictionaries/Categories");
    expect(calls[1]?.url).toBe("https://vacancy.aeroflot.ru/api/PublicVacancies/items");

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:aeroflot:440",
      url: "https://vacancy.aeroflot.ru/ru-ru/view?id=440&categoryId=1",
      title: "Заполнение анкеты для рассмотрения в резерв на лётные должности",
      company: "Aeroflot",
      location: "Москва",
    });
    expect(jobs.map((j) => j.externalId)).toEqual(["site:aeroflot:440", "site:aeroflot:553", "site:aeroflot:477"]);
  });

  it("fetches a job's full text from getById", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return jsonResponse(fixture("aeroflot-getbyid-477.json"));
      }),
    );

    const discovered = {
      externalId: "site:aeroflot:477",
      url: "https://vacancy.aeroflot.ru/ru-ru/view?id=477&categoryId=8",
      title: "Стажер",
      company: "Aeroflot",
      location: "Москва",
    };
    const vacancy = await aeroflot.fetchJob("https://vacancy.aeroflot.ru", discovered);

    expect(calls).toEqual([
      { url: "https://vacancy.aeroflot.ru/api/PublicVacancies/getById", body: { data: { vacancyId: 477 } } },
    ]);
    expect(vacancy.title).toBe("Стажер");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Aeroflot");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.descriptionText).toContain("Департамент «Корпоративный университет»");
    expect(vacancy.descriptionText).toContain("Неоконченное высшее образование");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
  });
});
