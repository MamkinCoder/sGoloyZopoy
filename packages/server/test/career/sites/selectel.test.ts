import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as selectel } from "../../../src/career/ats/sites/selectel.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selectel ats client", () => {
  it("detects the Selectel careers path", () => {
    expect(selectel.detect("https://selectel.ru/careers/", "")).toEqual({ token: "https://selectel.ru" });
    expect(selectel.detect("https://selectel.ru/careers/all/vacancy/1918/", "")).toEqual({ token: "https://selectel.ru" });
    expect(selectel.detect("https://example.com/careers", "")).toBeNull();
    expect(selectel.detect("https://example.com/", "goes to selectel.ru/careers/all/vacancy/1/")).toEqual({ token: "https://selectel.ru" });
  });

  it("lists all open jobs from the public vacancies API", async () => {
    const listJson = fixture("selectel-vacancies.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson);
      }),
    );

    const jobs = await selectel.listJobs("https://selectel.ru");

    expect(calls).toEqual(["https://api.selectel.ru/proxy/public/employee/api/public/vacancies?per_page=1000&page=1&brand=selectel"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:selectel:1918",
      url: "https://selectel.ru/careers/all/vacancy/1918/",
      title: "Младший системный инженер",
      company: "Selectel",
      location: "Москва",
    });
    expect(jobs[2]).toMatchObject({ externalId: "site:selectel:1896", title: "Fullstack-разработчик", location: "Санкт-Петербург" });
  });

  it("fetches a job's full text from the vacancy detail endpoint", async () => {
    const detailJson = fixture("selectel-vacancy-1918.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:selectel:1918",
      url: "https://selectel.ru/careers/all/vacancy/1918/",
      title: "Младший системный инженер",
      company: "Selectel",
      location: "Москва",
    };
    const vacancy = await selectel.fetchJob("https://selectel.ru", discovered);

    expect(calls).toEqual(["https://api.selectel.ru/proxy/public/employee/api/public/vacancies/1918"]);
    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Selectel");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Фиксированный");
    expect(vacancy.descriptionText).toContain("Монтаж серверного и сетевого оборудования");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
  });
});
