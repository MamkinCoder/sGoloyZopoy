import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as solar } from "../../../src/career/ats/sites/solar.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("solar ats client", () => {
  it("detects the Solar careers host", () => {
    expect(solar.detect("https://team.rt-solar.ru/vacancies/", "")).toEqual({ token: "https://team.rt-solar.ru" });
    expect(solar.detect("https://rt-solar.ru/career/", "")).toEqual({ token: "https://team.rt-solar.ru" });
    expect(solar.detect("https://example.com/careers", "")).toBeNull();
    expect(solar.detect("https://example.com/careers", "fetch from team.rt-solar.ru/vacancies/ here")).toEqual({
      token: "https://team.rt-solar.ru",
    });
  });

  it("lists all jobs across pages, stopping once no 'show more' button remains", async () => {
    const page1 = fixture("solar-vacancies-page1.html");
    const page2 = fixture("solar-vacancies-page2.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(url.includes("PAGEN_1=2") ? page2 : page1);
      }),
    );

    const jobs = await solar.listJobs("https://team.rt-solar.ru");

    expect(calls).toEqual([
      "https://team.rt-solar.ru/vacancies/?PAGEN_1=1",
      "https://team.rt-solar.ru/vacancies/?PAGEN_1=2",
    ]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:solar:874",
      url: "https://team.rt-solar.ru/vacancies/874/",
      title: "Стажер",
      company: "Solar",
      location: "Москва",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:solar:862",
      title: "Инженер технического расследования (ИБ, forensic)",
      location: "Россия",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:solar:870",
      url: "https://team.rt-solar.ru/vacancies/870/",
      title: "Ведущий инженер внедрения (сетевые СрЗИ)",
      location: "Москва",
    });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const detailHtml = fixture("solar-vacancy-870.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:solar:870",
      url: "https://team.rt-solar.ru/vacancies/870/",
      title: "Ведущий инженер внедрения (сетевые СрЗИ)",
      company: "Solar",
      location: "Москва",
    };
    const vacancy = await solar.fetchJob("https://team.rt-solar.ru", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Solar");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.descriptionText).toContain("Внедрение решений по информационной безопасности");
    expect(vacancy.descriptionText).toContain("Обязанности");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
