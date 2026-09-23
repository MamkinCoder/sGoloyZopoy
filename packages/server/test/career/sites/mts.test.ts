import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as mts } from "../../../src/career/ats/sites/mts.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mts ats client", () => {
  it("detects the MTS careers host", () => {
    expect(mts.detect("https://job.mts.ru/vacancies", "")).toEqual({ token: "https://job.mts.ru" });
    expect(mts.detect("https://example.com/careers", "")).toBeNull();
    expect(mts.detect("https://mts.ru/", "")).toBeNull();
  });

  it("detects by embedded API URL when the host differs", () => {
    expect(mts.detect("https://example.com/", 'apiBase:"https://job.mts.ru/api/v2/vacancies"')).toEqual({ token: "https://job.mts.ru" });
  });

  it("lists all live jobs from the Strapi-style API and stops at pageCount", async () => {
    const listJson = fixture("mts-vacancies.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson); // meta.pagination.pageCount is 1 in the fixture
      }),
    );

    const jobs = await mts.listJobs("https://job.mts.ru");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/v2/vacancies?pagination[page]=1&pagination[pageSize]=100");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:mts:706475146520559715",
      url: "https://job.mts.ru/vacancy/706475146520559715",
      title: "Ведущий разработчик Java (Платформа ЮЛ)",
      company: "ПАО МТС-Банк",
      location: "Москва",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:mts:699151891048693831", company: "ПАО МТС", location: "Санкт-Петербург" });
    // no region in the fixture -> location left undefined, not an empty string
    expect(jobs[2]?.location).toBeUndefined();
  });

  it("fetches a job's full text via the detail API", async () => {
    const detailJson = fixture("mts-vacancy-706475146520559715.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:mts:706475146520559715",
      url: "https://job.mts.ru/vacancy/706475146520559715",
      title: "Ведущий разработчик Java (Платформа ЮЛ)",
      company: "ПАО МТС-Банк",
      location: "Москва",
    };
    const vacancy = await mts.fetchJob("https://job.mts.ru", discovered);

    expect(calls).toEqual(["https://job.mts.ru/api/v2/vacancies/706475146520559715"]);
    expect(vacancy.title).toBe("Ведущий разработчик Java (Платформа ЮЛ)");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("ПАО МТС-Банк");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Полный");
    expect(vacancy.descriptionText).toContain("МТС Банк развивает цифровые финансовые сервисы");
    expect(vacancy.descriptionText).toContain("Требования:");
    expect(vacancy.descriptionText).toContain("Условия:");
    expect(vacancy.descriptionText).toContain("Spring");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
  });
});
