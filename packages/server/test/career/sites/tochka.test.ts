import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as tochka } from "../../../src/career/ats/sites/tochka.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const emptyCategoryHtml = "<!DOCTYPE html><html><body></body></html>";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tochka ats client", () => {
  it("detects the Tochka HR host", () => {
    expect(tochka.detect("https://hr.tochka.com/vacancies/", "")).toEqual({ token: "https://hr.tochka.com" });
    expect(tochka.detect("https://tochka.com/hr/", "")).toBeNull();
    expect(tochka.detect("https://example.com/careers", "")).toBeNull();
  });

  it("lists jobs by unioning every department category page, deduped by slug", async () => {
    const listHtml = fixture("tochka-vacancies-it.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(url === "https://hr.tochka.com/vacancies/it/" ? listHtml : emptyCategoryHtml);
      }),
    );

    const jobs = await tochka.listJobs("https://hr.tochka.com");

    // one GET per department category from the fixed nav list
    expect(calls).toContain("https://hr.tochka.com/vacancies/it/");
    expect(calls.length).toBeGreaterThan(1);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:tochka:aiengineer",
      url: "https://hr.tochka.com/vacancies/catalog/aiengineer/",
      title: "Мидл+ AI-инженер",
      company: "Tochka",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:tochka:data-analytics", title: "Аналитик данных" });
    expect(jobs[2]).toMatchObject({ externalId: "site:tochka:it-auditor", title: "IT-аудитор" });
    // no city on any fixture job -> location left undefined, not a placeholder string
    expect(jobs[0]!.location).toBeUndefined();
  });

  it("fetches a job's full text from the canonical /vacancies/catalog/{slug}/ detail page, resolving flight refs", async () => {
    const detailHtml = fixture("tochka-vacancy-aiengineer.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:tochka:aiengineer",
      url: "https://hr.tochka.com/vacancies/catalog/aiengineer/",
      title: "Мидл+ AI-инженер",
      company: "Tochka",
    };
    const vacancy = await tochka.fetchJob("https://hr.tochka.com", discovered);

    expect(vacancy.title).toBe("Мидл+ AI/промпт-инженер");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Tochka");
    expect(vacancy.workFormat).toBe("Удалённо");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(470000);
    expect(vacancy.currency).toBe("RUB");
    expect(vacancy.descriptionText).toContain("Ищем AI/промпт-инженера в Точка Банк.");
    expect(vacancy.descriptionText).toContain("Строить пайплайн генерации и контроля качества промптов.");
    expect(vacancy.descriptionText).toContain("Есть опыт построения систем с LLM от 3 лет.");
    // "expectation" field arrives as a "$1f" React Flight back-reference in the fixture, not inline
    // HTML - this line only appears if resolveRefs actually spliced the separate 1f:T... chunk in.
    expect(vacancy.descriptionText).toContain("Официальная зарплата до 470 000");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.descriptionText).not.toContain("$1f");
  });
});
