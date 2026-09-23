import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as megafon } from "../../../src/career/ats/sites/megafon.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("megafon ats client", () => {
  it("detects the MegaFon careers host", () => {
    expect(megafon.detect("https://job.megafon.ru/", "")).toEqual({ token: "https://job.megafon.ru" });
    expect(megafon.detect("https://example.com/careers", "")).toBeNull();
    expect(megafon.detect("https://megafon.ru/", "")).toBeNull();
  });

  it("lists jobs, paginating until page.pages is reached", async () => {
    const listJson = fixture("megafon-vacancies.json"); // pages: 2, one page of items reused for both calls
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson);
      }),
    );

    const jobs = await megafon.listJobs("https://job.megafon.ru");

    expect(calls).toEqual([`https://job.megafon.ru/api/v1/vacancies?page=1`, `https://job.megafon.ru/api/v1/vacancies?page=2`]);
    expect(jobs).toHaveLength(6); // 3 items x 2 pages (fixture reused)
    expect(jobs[0]).toMatchObject({
      externalId: "site:megafon:produktovyj-analitik-4767",
      url: "https://job.megafon.ru/vacancy/produktovyj-analitik-4767",
      title: "Продуктовый аналитик",
      company: "МегаФон",
      location: "Москва",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:megafon:android-razrabotchik-4763",
      title: "Android-разработчик",
      location: "Санкт-Петербург",
    });
  });

  it("fetches a job's full text using the cached cityId from listJobs", async () => {
    const detailJson = fixture("megafon-vacancy-4766.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:megafon:application-devops-engineer-4766",
      url: "https://job.megafon.ru/vacancy/application-devops-engineer-4766",
      title: "Application DevOps Engineer",
      company: "МегаФон",
      location: "Москва",
      raw: { id: 4766, title: "Application DevOps Engineer", slug: "application-devops-engineer-4766", city: { id: 1, title: "Москва" } },
    };
    const vacancy = await megafon.fetchJob("https://job.megafon.ru", discovered);

    expect(calls).toEqual(["https://job.megafon.ru/api/v1/vacancies/application-devops-engineer-4766?cityId=1"]);
    expect(vacancy.title).toBe("Application DevOps Engineer");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("МегаФон");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("5/2 полный рабочий день");
    expect(vacancy.descriptionText).toContain("Развитие CI/CD пайплайнов");
    expect(vacancy.descriptionText).toContain("Требования:");
    expect(vacancy.descriptionText).toContain("Опыт с Kubernetes");
    expect(vacancy.descriptionText).toContain("Условия:");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
  });

  it("falls back to an empty cityId when no cached list item is present", async () => {
    const detailJson = fixture("megafon-vacancy-4766.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:megafon:application-devops-engineer-4766",
      url: "https://job.megafon.ru/vacancy/application-devops-engineer-4766",
      title: "Application DevOps Engineer",
      company: "МегаФон",
    };
    await megafon.fetchJob("https://job.megafon.ru", discovered);

    expect(calls).toEqual(["https://job.megafon.ru/api/v1/vacancies/application-devops-engineer-4766?cityId="]);
  });
});
