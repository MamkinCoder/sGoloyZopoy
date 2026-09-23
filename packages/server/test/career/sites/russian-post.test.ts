import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as russianPost } from "../../../src/career/ats/sites/russian-post.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("russian-post ats client", () => {
  it("detects the pochta.ru host", () => {
    expect(russianPost.detect("https://www.pochta.ru/vacancy-list", "")).toEqual({ token: "https://www.pochta.ru" });
    expect(russianPost.detect("https://example.com/careers", "")).toBeNull();
  });

  it("lists all jobs across pages", async () => {
    const page1 = fixture("russian-post-vacancies-page1.json");
    const page2 = fixture("russian-post-vacancies-page2.json");
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return url.includes("offset=100") ? jsonResponse(page2) : jsonResponse(page1);
      }),
    );

    const jobs = await russianPost.listJobs("https://www.pochta.ru");

    expect(calls.map((c) => c.url)).toEqual([
      "https://www.pochta.ru/api/jobs/api/v2/vacancies/filter?limit=100&offset=0",
      "https://www.pochta.ru/api/jobs/api/v2/vacancies/filter?limit=100&offset=100",
    ]);
    expect(calls[0]?.body).toEqual({ searchParams: [], query: "" });
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:russian-post:44876",
      url: "https://www.pochta.ru/vacancy-list/44876",
      title: "Оператор связи в отделение Почты",
      company: "Почта России",
      location: "обл. Московская, г. Жуковский, ул. Баженова, д. 3",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:russian-post:25956",
      title: "Специалист в группу технической поддержки пользователей",
    });
    expect(jobs[2]).toMatchObject({ externalId: "site:russian-post:44874" });
  });

  it("fetches a job's full text and salary from the detail endpoint", async () => {
    const detailJson = fixture("russian-post-vacancy-25956.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:russian-post:25956",
      url: "https://www.pochta.ru/vacancy-list/25956",
      title: "Специалист в группу технической поддержки пользователей",
      company: "Почта России",
    };
    const vacancy = await russianPost.fetchJob("https://www.pochta.ru", discovered);

    expect(calls).toEqual(["https://www.pochta.ru/api/jobs/api/v2/vacancies/25956"]);
    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Почта России");
    expect(vacancy.area).toBe("обл Оренбургская, г Оренбург, ул Кирова, д. 18");
    expect(vacancy.workFormat).toBe("Полный день");
    expect(vacancy.salaryFrom).toBe(24750);
    expect(vacancy.currency).toBe("RUB");
    expect(vacancy.descriptionText).toContain("Обязанности");
    expect(vacancy.descriptionText).toContain("Требования");
    expect(vacancy.descriptionText).toContain("Условия");
  });
});
