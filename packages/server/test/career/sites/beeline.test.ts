import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as beeline } from "../../../src/career/ats/sites/beeline.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("beeline ats client", () => {
  it("detects the Beeline careers host", () => {
    expect(beeline.detect("https://job.beeline.ru/vacancies", "")).toEqual({ token: "https://job.beeline.ru" });
    expect(beeline.detect("https://example.com/careers", "")).toBeNull();
    expect(beeline.detect("https://example.com/careers", "fetch('https://job.beeline.ru/api/v1/vacancies/')")).toEqual({
      token: "https://job.beeline.ru",
    });
  });

  it("lists all jobs across pages", async () => {
    const page1 = fixture("beeline-vacancies-page1.json");
    const page2 = fixture("beeline-vacancies-page2.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return url.includes("offset=200") ? jsonResponse(page2) : jsonResponse(page1);
      }),
    );

    const jobs = await beeline.listJobs("https://job.beeline.ru");

    expect(calls).toEqual([
      "https://job.beeline.ru/api/v1/vacancies/?limit=200&offset=0",
      "https://job.beeline.ru/api/v1/vacancies/?limit=200&offset=200",
    ]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:beeline:d180561e-8b97-41a3-bda9-d3f633c7dfac",
      url: "https://job.beeline.ru/vacancies/d180561e-8b97-41a3-bda9-d3f633c7dfac",
      title: "AI Engineer / Разработчик агентских систем в ИБ",
      company: "Beeline",
    });
    expect(jobs[0]?.location).toBeUndefined();
    expect(jobs[2]).toMatchObject({
      externalId: "site:beeline:3ec4e2cc-f6e6-452f-9843-e886c87e200e",
      location: "Москва",
    });
  });

  it("fetches a job's full text and salary from the detail endpoint", async () => {
    const detailJson = fixture("beeline-vacancy-3ec4e2cc.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:beeline:3ec4e2cc-f6e6-452f-9843-e886c87e200e",
      url: "https://job.beeline.ru/vacancies/3ec4e2cc-f6e6-452f-9843-e886c87e200e",
      title: "Backend-разработчик Python",
      company: "Beeline",
    };
    const vacancy = await beeline.fetchJob("https://job.beeline.ru", discovered);

    expect(calls).toEqual(["https://job.beeline.ru/api/v1/vacancies/3ec4e2cc-f6e6-452f-9843-e886c87e200e"]);
    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Beeline");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Гибридный");
    expect(vacancy.salaryFrom).toBe(220000);
    expect(vacancy.salaryTo).toBe(300000);
    expect(vacancy.currency).toBe("RUR");
    expect(vacancy.descriptionText).toContain("Разрабатывать backend-сервисы на Python");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
