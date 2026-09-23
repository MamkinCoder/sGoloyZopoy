import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as pec } from "../../../src/career/ats/sites/pec.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pec ats client", () => {
  it("detects the PEC careers host", () => {
    expect(pec.detect("https://hr.pecom.ru/vacancies/", "")).toEqual({ token: "https://hr.pecom.ru" });
    expect(pec.detect("https://pecom.ru/company/vacancies/", "")).toBeNull();
    expect(pec.detect("https://pecom.ru/", "some markup mentioning hr.pecom.ru/vacancies")).toEqual({
      token: "https://hr.pecom.ru",
    });
  });

  it("lists all jobs from the /ajax/vacancy.php fragment", async () => {
    const listHtml = fixture("pec-vacancies.html");
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await pec.listJobs("https://hr.pecom.ru");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hr.pecom.ru/ajax/vacancy.php");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe("cat=0&city=0&area=0");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:pec:arkhitektor-resheniy-solution-architect-90d488",
      url: "https://hr.pecom.ru/vacancies/arkhitektor-resheniy-solution-architect-90d488/",
      title: "Архитектор решений",
      company: "PEC",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:pec:sistemnyy-analitik-dwh-bi-344a74",
      title: "Системный аналитик (DWH/BI)",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:pec:voditel-ekspeditor-na-tonar-2649-moskva-7107ef",
    });
  });

  it("fetches a job's full text and city from the server-rendered detail page", async () => {
    const detailHtml = fixture("pec-vacancy-sistemnyy-analitik-dwh-bi-344a74.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:pec:sistemnyy-analitik-dwh-bi-344a74",
      url: "https://hr.pecom.ru/vacancies/sistemnyy-analitik-dwh-bi-344a74/",
      title: "Системный аналитик (DWH/BI)",
      company: "PEC",
    };

    const vacancy = await pec.fetchJob("https://hr.pecom.ru", discovered);

    expect(vacancy.title).toBe("Системный аналитик (DWH/BI)");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("PEC");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.descriptionText).toContain("Обязанности");
    expect(vacancy.descriptionText).toContain("Уверенный уровень знаний SQL");
    expect(vacancy.descriptionText).toContain("Условия");
    expect(vacancy.descriptionText).not.toContain("<");
  });

  it("fetches a second job (different section layout with tab-indented <li>)", async () => {
    const detailHtml = fixture("pec-vacancy-arkhitektor-resheniy-solution-architect-90d488.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:pec:arkhitektor-resheniy-solution-architect-90d488",
      url: "https://hr.pecom.ru/vacancies/arkhitektor-resheniy-solution-architect-90d488/",
      title: "Архитектор решений",
      company: "PEC",
    };

    const vacancy = await pec.fetchJob("https://hr.pecom.ru", discovered);

    expect(vacancy.area).toBe("Москва");
    expect(vacancy.descriptionText).toContain("REST API");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
