import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as skyeng } from "../../../src/career/ats/sites/skyeng.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("skyeng ats client", () => {
  it("detects the Skyeng careers hosts or html mentioning them", () => {
    expect(skyeng.detect("https://vacancies.skyeng.ru/rukovoditel-gruppi-prodaz", "")).toEqual({
      token: "https://vacancies.skyeng.ru",
    });
    expect(skyeng.detect("https://job.skyeng.ru/", "")).toEqual({ token: "https://vacancies.skyeng.ru" });
    expect(skyeng.detect("https://example.com/", "")).toBeNull();
    expect(skyeng.detect("https://example.com/", 'see vacancies.skyeng.ru/some-role')).toEqual({
      token: "https://vacancies.skyeng.ru",
    });
  });

  it("lists all jobs across pages", async () => {
    const page1 = fixture("skyeng-vacancies-page1.json");
    const page2 = fixture("skyeng-vacancies-page2.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url.toString());
        return url.toString().includes("page=2") ? jsonResponse(page2) : jsonResponse(page1);
      }),
    );

    const jobs = await skyeng.listJobs("https://vacancies.skyeng.ru");

    expect(calls).toEqual([
      "https://api-employee-career-storage.skyeng.ru/api/vacancies?page=1",
      "https://api-employee-career-storage.skyeng.ru/api/vacancies?page=2",
    ]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:skyeng:713",
      url: "https://vacancies.skyeng.ru/rukovoditel-gruppi-prodaz",
      title: "Руководитель группы продаж",
      company: "Skyeng",
    });
    expect(jobs[2]).toMatchObject({ externalId: "site:skyeng:306", url: "https://vacancies.skyeng.ru/menedzher-vvodnogo-uroka-eng" });
  });

  it("fetches a job from the cached list item without a second request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const page1 = JSON.parse(fixture("skyeng-vacancies-page1.json")) as { results: unknown[] };
    const raw = page1.results[0];
    const vacancy = await skyeng.fetchJob("https://vacancies.skyeng.ru", {
      externalId: "site:skyeng:713",
      url: "https://vacancies.skyeng.ru/rukovoditel-gruppi-prodaz",
      title: "Руководитель группы продаж",
      company: "Skyeng",
      raw,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(vacancy.source).toBe("site:skyeng");
    expect(vacancy.title).toBe("Руководитель группы продаж");
    expect(vacancy.company).toBe("Skyeng");
    expect(vacancy.workFormat).toBe("Продажи");
    expect(vacancy.descriptionText).toContain("EdTech-компания");
    expect(vacancy.descriptionText).toContain("Обязанности");
    expect(vacancy.descriptionText).toContain("Строить дисциплину");
    expect(vacancy.descriptionText).toContain("Требования");
    expect(vacancy.descriptionText).toContain("Условия");
    expect(vacancy.descriptionText).toContain("Удалённая работа");
    expect(vacancy.descriptionText).not.toContain("<");
  });

  it("falls back to a detail GET when raw is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(fixture("skyeng-vacancy-713.json"))),
    );

    const vacancy = await skyeng.fetchJob("https://vacancies.skyeng.ru", {
      externalId: "site:skyeng:713",
      url: "https://vacancies.skyeng.ru/rukovoditel-gruppi-prodaz",
      title: "Руководитель группы продаж",
      company: "Skyeng",
    });

    expect(vacancy.title).toBe("Руководитель группы продаж");
    expect(vacancy.descriptionText).toContain("Опыт управления командой продаж");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
