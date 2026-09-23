import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as itOne } from "../../../src/career/ats/sites/it-one.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("it-one ats client", () => {
  it("detects the www.it-one.ru careers host", () => {
    expect(itOne.detect("https://www.it-one.ru/career/", "")).toEqual({ token: "https://www.it-one.ru" });
    expect(itOne.detect("https://example.com/careers", "")).toBeNull();
    expect(itOne.detect("https://example.com/careers", "see it-one.ru/vacancies for openings")).toEqual({
      token: "https://example.com",
    });
  });

  it("lists jobs from the GET /api/entities/vacancy/ JSON", async () => {
    const page = fixture("it-one-vacancies.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(page);
      }),
    );

    const jobs = await itOne.listJobs("https://www.it-one.ru");

    expect(calls).toEqual(["https://www.it-one.ru/api/entities/vacancy/"]);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.externalId).sort()).toEqual(["site:it-one:53444", "site:it-one:53445", "site:it-one:53447"]);
    const dwh = jobs.find((j) => j.externalId === "site:it-one:53444");
    expect(dwh).toMatchObject({
      url: "https://www.it-one.ru/vacancies/56def3ee55e152bac91fb4e2b536ae91/",
      title: "Senior/Tech Lead Аналитик КХД",
      company: "IT_ONE",
      location: "Remote work",
    });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const detailHtml = fixture("it-one-job.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const job = await itOne.fetchJob("https://www.it-one.ru", {
      externalId: "site:it-one:53444",
      url: "https://www.it-one.ru/vacancies/56def3ee55e152bac91fb4e2b536ae91/",
      title: "Senior/Tech Lead Аналитик КХД",
      company: "IT_ONE",
    });

    expect(job.title).toBe("Senior/Tech Lead Аналитик КХД");
    expect(job.company).toBe("IT_ONE");
    expect(job.descriptionText).toContain("Обязанности");
    expect(job.descriptionText).toContain("проектирование новых витрин данных");
    expect(job.descriptionText).toContain("опыт работы с DWH от 5 лет");
    expect(job.area).toBe("Remote work");
    expect(job.workFormat).toBe("DWH Analyst");
    expect(job.salaryFrom).toBe(0);
  });
});
