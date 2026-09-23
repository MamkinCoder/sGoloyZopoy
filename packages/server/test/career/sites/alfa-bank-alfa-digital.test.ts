import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as alfaDigital } from "../../../src/career/ats/sites/alfa-bank-alfa-digital.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alfa-bank-alfa-digital ats client", () => {
  it("detects the Alfa Digital careers host", () => {
    expect(alfaDigital.detect("https://digital.alfabank.ru/vacancies", "")).toEqual({ token: "https://digital.alfabank.ru" });
    expect(alfaDigital.detect("https://example.com/careers", "")).toBeNull();
    expect(alfaDigital.detect("https://alfabank.ru/", "")).toBeNull();
  });

  it("lists all jobs from the embedded __NEXT_DATA__ payload", async () => {
    const listHtml = fixture("alfa-bank-alfa-digital-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await alfaDigital.listJobs("https://digital.alfabank.ru");

    expect(calls).toEqual(["https://digital.alfabank.ru/vacancies"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:alfa-bank-alfa-digital:sistemnii_analitik__105584",
      url: "https://digital.alfabank.ru/vacancies/sistemnii_analitik__105584",
      title: "Системный аналитик",
      company: "Alfa-Bank / Alfa Digital",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:alfa-bank-alfa-digital:prompt-inzhener--237632", title: "Промпт-инженер" });
    expect(jobs[2]).toMatchObject({
      externalId: "site:alfa-bank-alfa-digital:produktovii-analitik--platezhi-i-perevodi---239220",
      title: "Продуктовый аналитик (Платежи и переводы)",
    });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const detailHtml = fixture("alfa-bank-alfa-digital-vacancy-sistemnii_analitik__105584.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:alfa-bank-alfa-digital:sistemnii_analitik__105584",
      url: "https://digital.alfabank.ru/vacancies/sistemnii_analitik__105584",
      title: "Системный аналитик",
      company: "Alfa-Bank / Alfa Digital",
      raw: { id: "255", name: "Системный аналитик", slug: "sistemnii_analitik__105584" },
    };

    const vacancy = await alfaDigital.fetchJob("https://digital.alfabank.ru", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Alfa-Bank / Alfa Digital");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.descriptionText).toContain("Обязанности");
    expect(vacancy.descriptionText).toContain("Требования");
    expect(vacancy.descriptionText).toContain("Релевантный опыт работы в должности системного аналитика от 3х лет");
    expect(vacancy.descriptionText).toContain("Условия");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
