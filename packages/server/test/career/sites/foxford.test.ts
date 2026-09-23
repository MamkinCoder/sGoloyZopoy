import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as foxford } from "../../../src/career/ats/sites/foxford.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

const ORIGIN = "https://jobs.foxford.ru";

describe("foxford ats client", () => {
  it("detects the jobs.foxford.ru host", () => {
    expect(foxford.detect(`${ORIGIN}/vacancies`, "")).toEqual({ token: ORIGIN });
    expect(foxford.detect("https://foxford.ru/about/career", "")).toBeNull();
    expect(foxford.detect("https://example.com/careers", "fetch('https://jobs.foxford.ru/vacancies')")).toEqual({ token: ORIGIN });
  });

  it("lists all jobs from the server-rendered listing page", async () => {
    const listHtml = fixture("foxford-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await foxford.listJobs(ORIGIN);

    expect(calls).toEqual([`${ORIGIN}/vacancies`]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:foxford:bdm-high-school",
      url: `${ORIGIN}/vacancies/bdm-high-school`,
      title: "Product Owner / Бизнес-лид сегмента 7-11 классов",
      company: "Foxford",
      location: "удалённо",
    });
    const analyst = jobs.find((j) => j.externalId === "site:foxford:produktoviy-analitik");
    expect(analyst).toMatchObject({ title: "Продуктовый аналитик", location: "удалённо, офис в Москве" });
    const sales = jobs.find((j) => j.externalId === "site:foxford:menedzher-po-prodazham");
    expect(sales).toMatchObject({ title: "Менеджер по продажам в Домашнюю школу", location: "2/2, удалённо" });
  });

  it("fetches a job with no published salary", async () => {
    const html = fixture("foxford-vacancy-produktoviy-analitik.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );

    const discovered = {
      externalId: "site:foxford:produktoviy-analitik",
      url: `${ORIGIN}/vacancies/produktoviy-analitik`,
      title: "Продуктовый аналитик",
      company: "Foxford",
      location: "удалённо, офис в Москве",
    };
    const v = await foxford.fetchJob(ORIGIN, discovered);

    expect(v.title).toBe("Продуктовый аналитик");
    expect(v.company).toBe("Foxford");
    expect(v.area).toBe("Удалённо Офис в Москве");
    expect(v.descriptionText).toContain("продуктового аналитика");
    expect(v.descriptionText).not.toContain("<");
    expect(v.salaryFrom).toBe(0);
    expect(v.salaryTo).toBe(0);
    expect(v.currency).toBe("");
  });

  it("fetches a job's salary (free-text 'от N ₽') and work format", async () => {
    const html = fixture("foxford-vacancy-menedzher-po-prodazham.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );

    const discovered = {
      externalId: "site:foxford:menedzher-po-prodazham",
      url: `${ORIGIN}/vacancies/menedzher-po-prodazham`,
      title: "Менеджер по продажам в Домашнюю школу",
      company: "Foxford",
      location: "2/2, удалённо",
    };
    const v = await foxford.fetchJob(ORIGIN, discovered);

    expect(v.salaryFrom).toBe(105000);
    expect(v.salaryTo).toBe(0);
    expect(v.currency).toBe("RUR");
    expect(v.workFormat).toBe("2/2");
    expect(v.descriptionText).toContain("Домашнюю школу");
  });
});
