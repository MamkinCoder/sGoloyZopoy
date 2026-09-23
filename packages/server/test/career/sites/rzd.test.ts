import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as rzd } from "../../../src/career/ats/sites/rzd.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rzd ats client", () => {
  it("detects the RZD careers host", () => {
    expect(rzd.detect("https://team.rzd.ru/career/vacancies", "")).toEqual({ token: "https://team.rzd.ru" });
    expect(rzd.detect("https://example.com/careers", "")).toBeNull();
  });

  it("lists all jobs across pages", async () => {
    const page1 = fixture("rzd-vacancies-page1.json");
    const page2 = fixture("rzd-vacancies-page2.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return url.includes("page=2") ? jsonResponse(page2) : jsonResponse(page1);
      }),
    );

    const jobs = await rzd.listJobs("https://team.rzd.ru");

    expect(calls).toEqual([
      "https://team.rzd.ru/api/v1/career/vacancies?page=1&per_page=100",
      "https://team.rzd.ru/api/v1/career/vacancies?page=2&per_page=100",
    ]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:rzd:1893938",
      url: "https://team.rzd.ru/career/vacancies/1893938",
      title: "Дежурный по переезду",
      company: "РЖД",
      location: "Издревая",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:rzd:1693094",
      title: "Инструктор по лечебной физкультуре",
    });
  });

  it("fetches a job's full text and salary from the detail endpoint", async () => {
    const detailJson = fixture("rzd-vacancy-1893938.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:rzd:1893938",
      url: "https://team.rzd.ru/career/vacancies/1893938",
      title: "Дежурный по переезду",
      company: "РЖД",
    };
    const vacancy = await rzd.fetchJob("https://team.rzd.ru", discovered);

    expect(calls).toEqual(["https://team.rzd.ru/api/v1/career/vacancies/1893938"]);
    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("РЖД");
    expect(vacancy.area).toBe("Железнодорожная станция Издревая");
    expect(vacancy.workFormat).toBe("Сменный график");
    expect(vacancy.salaryFrom).toBe(48000);
    expect(vacancy.salaryTo).toBe(56000);
    expect(vacancy.currency).toBe("RUB");
    expect(vacancy.descriptionText).toContain("Обязанности");
    expect(vacancy.descriptionText).toContain("дежурным по переезду");
    expect(vacancy.descriptionText).toContain("Требования");
    expect(vacancy.descriptionText).toContain("Что мы предлагаем");
  });
});
