import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as ozonTech } from "../../../src/career/ats/sites/ozon-tech.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ozon-tech ats client", () => {
  it("detects the Ozon Tech careers hosts", () => {
    expect(ozonTech.detect("https://ozon.tech/vacancies", "")).toEqual({ token: "https://ozon.tech" });
    expect(ozonTech.detect("https://job.ozon.ru/vacancies", "")).toEqual({ token: "https://ozon.tech" });
    expect(ozonTech.detect("https://example.com/careers", "")).toBeNull();
    expect(ozonTech.detect("https://example.com/careers", "fetch('https://job-api.ozon.ru/vacancy')")).toEqual({
      token: "https://ozon.tech",
    });
  });

  it("lists all Ozon Tech jobs and stops at totalPages", async () => {
    const listJson = fixture("ozon-tech-vacancies.json"); // meta.totalPages is 1 in the fixture
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson);
      }),
    );

    const jobs = await ozonTech.listJobs("https://ozon.tech");

    expect(calls).toEqual(["https://job-api.ozon.ru/vacancy?department=Ozon%20Tech&limit=50&page=1"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:ozon-tech:135781631",
      url: "https://ozon.tech/vacancy/135781631",
      title: "C#-разработчик",
      company: "Ozon",
      location: "Москва",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:ozon-tech:137238259", title: "C#-разработчик, Ozon fresh" });
    // empty city in the fixture -> location left undefined, not an empty string
    expect(jobs[2]?.location).toBeUndefined();
  });

  it("paginates past the 50-item server cap using meta.totalPages", async () => {
    const page1 = JSON.stringify({
      items: [{ hhId: 1, title: "A" }],
      meta: { limit: 50, page: 1, perPage: 50, totalItems: 2, totalPages: 2 },
    });
    const page2 = JSON.stringify({
      items: [{ hhId: 2, title: "B" }],
      meta: { limit: 50, page: 2, perPage: 50, totalItems: 2, totalPages: 2 },
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(url.includes("page=2") ? page2 : page1);
      }),
    );

    const jobs = await ozonTech.listJobs("https://ozon.tech");

    expect(calls).toEqual([
      "https://job-api.ozon.ru/vacancy?department=Ozon%20Tech&limit=50&page=1",
      "https://job-api.ozon.ru/vacancy?department=Ozon%20Tech&limit=50&page=2",
    ]);
    expect(jobs.map((j) => j.externalId)).toEqual(["site:ozon-tech:1", "site:ozon-tech:2"]);
  });

  it("fetches a job's full text and uses the detail slug for the URL", async () => {
    const detailJson = fixture("ozon-tech-vacancy-135781631.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:ozon-tech:135781631",
      url: "https://ozon.tech/vacancy/135781631",
      title: "C#-разработчик",
      company: "Ozon",
      location: "Москва",
    };

    const vacancy = await ozonTech.fetchJob("https://ozon.tech", discovered);

    expect(calls).toEqual(["https://job-api.ozon.ru/vacancy/135781631"]);
    expect(vacancy.title).toBe("C#-разработчик");
    expect(vacancy.company).toBe("Ozon");
    expect(vacancy.url).toBe("https://ozon.tech/vacancy/c-razrabotchik-135781631");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Удалённо");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
    expect(vacancy.descriptionText).toContain("систему управления складом");
    expect(vacancy.descriptionText).toContain("Хорошее знание C# (.NET Core)");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
