import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as lanit } from "../../../src/career/ats/sites/lanit.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lanit ats client", () => {
  it("detects the job.lanit.ru careers host", () => {
    expect(lanit.detect("https://job.lanit.ru/", "")).toEqual({ token: "https://job.lanit.ru" });
    expect(lanit.detect("https://job.lanit.ru/vacancy/Pages/3758.aspx", "")).toEqual({ token: "https://job.lanit.ru" });
    expect(lanit.detect("https://example.com/careers", "")).toBeNull();
    expect(lanit.detect("https://lanit.ru/", "")).toBeNull();
  });

  it("lists all published jobs from the SharePoint OData list", async () => {
    const listJson = fixture("lanit-vacancies.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson);
      }),
    );

    const jobs = await lanit.listJobs("https://job.lanit.ru");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("getbytitle(");
    expect(calls[0]).toContain("%D0%9E%D0%BF%D1%83%D0%B1%D0%BB%D0%B8%D0%BA%D0%BE%D0%B2%D0%B0%D0%BD%D0%BE"); // 'Опубликовано'
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:lanit:3713",
      url: "https://job.lanit.ru/Pages/vacancy.aspx?ItemId=3713",
      title: "Системный аналитик",
      company: "LANIT",
      location: "Москва",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:lanit:3758", title: "AI инженер" });
    expect(jobs[2]).toMatchObject({ externalId: "site:lanit:3775", title: "Стажировка ML-разработчика (LLM / AI Agents)" });
  });

  it("fetches a job's full text from the SharePoint item detail JSON", async () => {
    const detailJson = fixture("lanit-vacancy-3758.json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(detailJson)),
    );

    const discovered = {
      externalId: "site:lanit:3758",
      url: "https://job.lanit.ru/Pages/vacancy.aspx?ItemId=3758",
      title: "AI инженер",
      company: "LANIT",
      location: "Россия",
    };
    const vacancy = await lanit.fetchJob("https://job.lanit.ru", discovered);

    expect(vacancy.title).toBe("AI инженер");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("LANIT");
    expect(vacancy.area).toBe("Россия");
    expect(vacancy.descriptionText).toContain("Обязанности:");
    expect(vacancy.descriptionText).toContain("Внедрение agent-assisted");
    expect(vacancy.descriptionText).toContain("Требования:");
    expect(vacancy.descriptionText).toContain("Уверенная работа с Git");
    expect(vacancy.descriptionText).toContain("Условия:");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
