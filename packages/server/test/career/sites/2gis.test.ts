import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as twoGis } from "../../../src/career/ats/sites/2gis.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("2gis ats client", () => {
  it("detects the 2GIS careers host", () => {
    expect(twoGis.detect("https://job.2gis.ru/vacancies", "")).toEqual({ token: "https://job.2gis.ru" });
    expect(twoGis.detect("https://example.com/careers", "")).toBeNull();
    expect(twoGis.detect("https://example.com/careers", "some markup mentioning job.2gis.ru/vacancies")).toEqual({
      token: "https://job.2gis.ru",
    });
  });

  it("lists all jobs from the server-rendered listing page", async () => {
    const listHtml = fixture("2gis-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await twoGis.listJobs("https://job.2gis.ru");

    expect(calls).toEqual(["https://job.2gis.ru/vacancies?page=100"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:2gis:563",
      url: "https://job.2gis.ru/vacancies/project_management/563",
      title: "Менеджер В2В проектов в 2GIS",
      company: "2GIS",
      location: "Удалённо",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:2gis:562",
      url: "https://job.2gis.ru/vacancies/information_security/562",
      title: "Инженер по эксплуатации СЗИ",
      location: "Новосибирск",
    });
    // 3-chip card (category, subcategory, location) - location is still the last chip
    expect(jobs[2]).toMatchObject({
      externalId: "site:2gis:521",
      url: "https://job.2gis.ru/vacancies/development/521",
      title: "Android-разработчик в команду MSDK",
      location: "Удалённо",
    });
  });

  it("fetches a remote job's full text from the JobPosting JSON-LD", async () => {
    const detailHtml = fixture("2gis-vacancy-521.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:2gis:521",
      url: "https://job.2gis.ru/vacancies/development/521",
      title: "Android-разработчик в команду MSDK",
      company: "2GIS",
      location: "Удалённо",
    };

    const vacancy = await twoGis.fetchJob("https://job.2gis.ru", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("2GIS");
    expect(vacancy.area).toBe("Удалённо");
    expect(vacancy.workFormat).toBe("Удалённо");
    expect(vacancy.descriptionText).toContain("Разрабатывать и поддерживать Android SDK");
    expect(vacancy.descriptionText).toContain("Мы ждём, что вы");
    expect(vacancy.descriptionText).not.toContain("<");
  });

  it("fetches an office job's city from jobLocation", async () => {
    const detailHtml = fixture("2gis-vacancy-562.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:2gis:562",
      url: "https://job.2gis.ru/vacancies/information_security/562",
      title: "Инженер по эксплуатации СЗИ",
      company: "2GIS",
      location: "Новосибирск",
    };

    const vacancy = await twoGis.fetchJob("https://job.2gis.ru", discovered);

    expect(vacancy.area).toBe("Новосибирск");
    expect(vacancy.workFormat).toBe("");
    expect(vacancy.descriptionText).toContain("средств защиты информации");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
