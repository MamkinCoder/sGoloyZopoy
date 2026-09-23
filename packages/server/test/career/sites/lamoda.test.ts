import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as lamoda } from "../../../src/career/ats/sites/lamoda.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const textResponse = (body: string, contentType: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": contentType } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lamoda ats client", () => {
  it("detects the Lamoda careers host or html mentioning it", () => {
    expect(lamoda.detect("https://job.lamoda.ru/vacancies", "")).toEqual({ token: "https://job.lamoda.ru" });
    expect(lamoda.detect("https://job.lamoda.ru/it", "")).toEqual({ token: "https://job.lamoda.ru" });
    expect(lamoda.detect("https://example.com/", "")).toBeNull();
    expect(lamoda.detect("https://example.com/", 'see job.lamoda.ru/vacancies/foo--1')).toEqual({
      token: "https://job.lamoda.ru",
    });
  });

  it("lists open jobs from /sitemap.xml, skipping non-vacancy and filtered urls", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url.toString());
        return textResponse(fixture("lamoda-sitemap.xml"), "application/xml");
      }),
    );

    const jobs = await lamoda.listJobs("https://job.lamoda.ru");

    expect(calls).toEqual(["https://job.lamoda.ru/sitemap.xml"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:lamoda:1525",
      url: "https://job.lamoda.ru/vacancies/moskva-yu-zts/ofis-menedzher--1525",
      company: "Lamoda",
    });
    expect(jobs[1]?.externalId).toBe("site:lamoda:2833");
    expect(jobs[2]).toMatchObject({ externalId: "site:lamoda:2654", url: "https://job.lamoda.ru/vacancies/vacancy--2654" });
  });

  it("fetches a job with inline HTML requirements/conditions and a referenced duties chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => textResponse(fixture("lamoda-job-2833.html"), "text/html")),
    );

    const vacancy = await lamoda.fetchJob("https://job.lamoda.ru", {
      externalId: "site:lamoda:2833",
      url: "https://job.lamoda.ru/vacancies/moskva/python-developer--2833",
      title: "Python developer",
      company: "Lamoda",
    });

    expect(vacancy.source).toBe("site:lamoda");
    expect(vacancy.title).toBe("Python developer");
    expect(vacancy.company).toBe("Lamoda");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Разработка");
    expect(vacancy.salaryFrom).toBe(250000);
    expect(vacancy.salaryTo).toBe(350000);
    expect(vacancy.publishedAt).toBe(new Date("2026-08-18T08:49:06.000Z").toISOString());
    expect(vacancy.descriptionText).toContain("Разрабатывать новые сервисы");
    expect(vacancy.descriptionText).toContain("Знание Python, Django");
    expect(vacancy.descriptionText).toContain("Официальное оформление");
    expect(vacancy.descriptionText).not.toContain("<");
  });

  it("falls back to the plain-text shortInfo summary when structured fields are empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => textResponse(fixture("lamoda-job-1525.html"), "text/html")),
    );

    const vacancy = await lamoda.fetchJob("https://job.lamoda.ru", {
      externalId: "site:lamoda:1525",
      url: "https://job.lamoda.ru/vacancies/moskva-yu-zts/ofis-menedzher--1525",
      title: "Офис-менеджер",
      company: "Lamoda",
    });

    expect(vacancy.title).toBe("Офис-менеджер");
    expect(vacancy.area).toBe("Москва ЮЗТС");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
    expect(vacancy.descriptionText).toContain("грамотную речь");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
