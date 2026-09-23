import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as maximumEducation } from "../../../src/career/ats/sites/maximum-education.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("maximum-education ats client", () => {
  it("detects the MAXIMUM Education careers host", () => {
    expect(maximumEducation.detect("https://career.maximumacademy.ru/vacancies", "")).toEqual({
      token: "https://career.maximumacademy.ru",
    });
    expect(maximumEducation.detect("https://example.com/careers", "")).toBeNull();
    expect(maximumEducation.detect("https://example.com/careers", "fetch('/api/v1/vacancy-sections')")).toBeNull();
    expect(
      maximumEducation.detect("https://example.com/careers", "fetch('https://career.maximumacademy.ru/api/v1/vacancy-sections')"),
    ).toEqual({ token: "https://career.maximumacademy.ru" });
  });

  it("lists all jobs flattened from vacancy sections in one call", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(fixture("maximum-education-vacancy-sections.json"));
      }),
    );

    const jobs = await maximumEducation.listJobs("https://career.maximumacademy.ru");

    expect(calls).toEqual(["https://career.maximumacademy.ru/api/v1/vacancy-sections"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:maximum-education:sale-1",
      url: "https://career.maximumacademy.ru/vacancies/sale-1",
      title: "Оператор call-центра",
      company: "Maximum Education",
      location: "Удаленно",
    });
    expect(jobs[2]).toMatchObject({ externalId: "site:maximum-education:back-office2", location: "Москва" });
  });

  it("fetches a job's full text and parses a salary range from the detail endpoint", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(fixture("maximum-education-vacancy-back-office2.json"));
      }),
    );

    const discovered = {
      externalId: "site:maximum-education:back-office2",
      url: "https://career.maximumacademy.ru/vacancies/back-office2",
      title: "Финансовый аналитик",
      company: "Maximum Education",
      location: "Москва",
    };
    const vacancy = await maximumEducation.fetchJob("https://career.maximumacademy.ru", discovered);

    expect(calls).toEqual(["https://career.maximumacademy.ru/api/v1/vacancies/back-office2"]);
    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Maximum Education");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Полная занятость");
    expect(vacancy.salaryFrom).toBe(130000);
    expect(vacancy.salaryTo).toBe(160000);
    expect(vacancy.currency).toBe("RUR");
    expect(vacancy.descriptionText).toContain("Готовить финансовую отчётность");
    expect(vacancy.descriptionText).toContain("Требования");
  });

  it("parses an open-ended salary ('от N') as salaryFrom only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(fixture("maximum-education-vacancy-sale-1.json"))),
    );

    const discovered = {
      externalId: "site:maximum-education:sale-1",
      url: "https://career.maximumacademy.ru/vacancies/sale-1",
      title: "Оператор call-центра",
      company: "Maximum Education",
    };
    const vacancy = await maximumEducation.fetchJob("https://career.maximumacademy.ru", discovered);
    expect(vacancy.salaryFrom).toBe(70000);
    expect(vacancy.salaryTo).toBe(0);
    expect(vacancy.currency).toBe("RUR");
  });
});
