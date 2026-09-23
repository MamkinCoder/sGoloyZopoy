import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as sovcombank } from "../../../src/career/ats/sites/sovcombank.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sovcombank ats client", () => {
  it("detects the Sovcombank careers host", () => {
    expect(sovcombank.detect("https://people.sovcombank.ru/vacancies", "")).toEqual({ token: "https://people.sovcombank.ru" });
    expect(sovcombank.detect("https://example.com/careers", "")).toBeNull();
    expect(sovcombank.detect("https://sovcombank.ru/", "")).toBeNull();
    expect(sovcombank.detect("https://example.com/careers", "see people.sovcombank.ru/vacancies for openings")).toEqual({
      token: "https://people.sovcombank.ru",
    });
  });

  it("lists all jobs across pages, stopping at meta.last_page", async () => {
    const page1 = fixture("sovcombank-vacancies-page1.json");
    const page2 = fixture("sovcombank-vacancies-page2.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(url.includes("page=2") ? page2 : page1);
      }),
    );

    const jobs = await sovcombank.listJobs("https://people.sovcombank.ru");

    expect(calls).toEqual([
      "https://people.sovcombank.ru/api/v1/vacancies?page=1",
      "https://people.sovcombank.ru/api/v1/vacancies?page=2",
    ]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:sovcombank:15063",
      url: "https://people.sovcombank.ru/vacancies/15063",
      title: "Python-разработчик",
      company: "Совкомбанк Технологии",
      location: "Новосибирск",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:sovcombank:15106",
      title: "Кредитный менеджер",
      company: "Совкомбанк",
      location: "Москва",
    });
    expect(jobs[2]).toMatchObject({ externalId: "site:sovcombank:15071", title: "DevOps-инженер", company: "Совкомбанк Технологии" });
  });

  it("fetches a job's full plain-text description via the /show endpoint", async () => {
    const detailJson = fixture("sovcombank-vacancy-15063.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:sovcombank:15063",
      url: "https://people.sovcombank.ru/vacancies/15063",
      title: "Python-разработчик",
      company: "Совкомбанк Технологии",
      location: "Новосибирск",
    };
    const vacancy = await sovcombank.fetchJob("https://people.sovcombank.ru", discovered);

    expect(calls).toEqual(["https://people.sovcombank.ru/api/v1/vacancies/15063/show"]);
    expect(vacancy.title).toBe("Python-разработчик");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Совкомбанк Технологии");
    expect(vacancy.area).toBe("Новосибирск");
    expect(vacancy.workFormat).toBe("Полный рабочий день");
    expect(vacancy.descriptionText).toContain("Обязанности:");
    expect(vacancy.descriptionText).toContain("Разработка и поддержка бэкенд-сервисов");
    expect(vacancy.descriptionText).toContain("Требования:");
    expect(vacancy.descriptionText).toContain("Опыт коммерческой разработки на Python");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
    expect(vacancy.currency).toBe("");
  });

  it("fills salary and currency when the posting has one", async () => {
    const detailJson = fixture("sovcombank-vacancy-15106.json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(detailJson)),
    );

    const discovered = {
      externalId: "site:sovcombank:15106",
      url: "https://people.sovcombank.ru/vacancies/15106",
      title: "Кредитный менеджер",
      company: "Совкомбанк",
      location: "Москва",
    };
    const vacancy = await sovcombank.fetchJob("https://people.sovcombank.ru", discovered);

    expect(vacancy.salaryFrom).toBe(70000);
    expect(vacancy.salaryTo).toBe(100000);
    expect(vacancy.currency).toBe("RUB");
    expect(vacancy.area).toBe("Москва");
  });
});
