import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as dodoEngineering } from "../../../src/career/ats/sites/dodo-engineering.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dodo-engineering ats client", () => {
  it("detects the Dodo Engineering host", () => {
    expect(dodoEngineering.detect("https://dodoengineering.ru/", "")).toEqual({ token: "https://dodoengineering.ru" });
    expect(dodoEngineering.detect("https://example.com/careers", "")).toBeNull();
    expect(dodoEngineering.detect("https://example.com/careers", 'href="https://dodoteam.ru/vacancies"')).toEqual({
      token: "https://dodoengineering.ru",
    });
  });

  it("lists only Engineering-brand jobs, unfiltered by anything else", async () => {
    const listJson = fixture("dodo-engineering-vacancies.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson);
      }),
    );

    const jobs = await dodoEngineering.listJobs("https://dodoengineering.ru");

    expect(calls).toEqual(["https://job-site-backend.dodo-ai-platform.io/api/v1/vacancies"]);
    // fixture has 6 Engineering items + 1 Finance (Dodo Pizza) item; only Engineering should survive
    expect(jobs).toHaveLength(6);
    expect(jobs.every((j) => j.company === "Dodo Engineering")).toBe(true);
    expect(jobs[0]).toMatchObject({
      externalId: "site:dodo-engineering:8068",
      url: "https://dodoteam.ru/vacancy?vacancyId=8068",
      title: "Аналитик данных",
      company: "Dodo Engineering",
      location: "Москва",
    });
    // last Engineering item in the fixture has no vacancy_location
    expect(jobs[5]).toMatchObject({
      externalId: "site:dodo-engineering:14979",
      title: "Фуллстек QA-инженер",
    });
    expect(jobs[5]?.location).toBeUndefined();
  });

  it("fetches a job's full text assembled from the typed content blocks", async () => {
    const detailJson = fixture("dodo-engineering-vacancy-8068.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:dodo-engineering:8068",
      url: "https://dodoteam.ru/vacancy?vacancyId=8068",
      title: "Аналитик данных",
      company: "Dodo Engineering",
      location: "Москва",
    };

    const vacancy = await dodoEngineering.fetchJob("https://dodoengineering.ru", discovered);

    expect(calls).toEqual(["https://job-site-backend.dodo-ai-platform.io/api/v1/pages/vacancy/8068"]);
    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Dodo Engineering");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Удалёнка");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
    expect(vacancy.descriptionText).toContain("Data-аналитика");
    expect(vacancy.descriptionText).toContain("мы ожидаем");
    expect(vacancy.descriptionText).toContain("тебе предстоит");
    expect(vacancy.descriptionText).toContain("мы предлагаем");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
