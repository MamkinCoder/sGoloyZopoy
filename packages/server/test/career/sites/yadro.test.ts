import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as yadro } from "../../../src/career/ats/sites/yadro.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("yadro ats client", () => {
  it("detects the YADRO careers host", () => {
    expect(yadro.detect("https://careers.yadro.com/vacancies", "")).toEqual({ token: "https://careers.yadro.com" });
    expect(yadro.detect("https://example.com/careers", "")).toBeNull();
    expect(yadro.detect("https://example.com/careers", "goes to careers.yadro.com/vacancy/102517")).toEqual({
      token: "https://careers.yadro.com",
    });
  });

  it("lists all open jobs from the public vacancies API", async () => {
    const listJson = fixture("yadro-vacancies.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson);
      }),
    );

    const jobs = await yadro.listJobs("https://careers.yadro.com");

    expect(calls).toEqual(["https://careers.yadro.com/api/v1/vacancies/?limit=300&offset=0"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:yadro:2517",
      url: "https://careers.yadro.com/vacancy/102517",
      title: "Руководитель группы системных аналитиков",
      company: "YADRO",
      location: "Москва, Санкт-Петербург, Минск, Нижний Новгород",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:yadro:2492",
      title: "Руководитель отдела инфраструктуры / Lead DevOps / Head of Infrastructure",
      location: "Нижний Новгород",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:yadro:2508",
      title: "Техник по эксплуатации производственного оборудования",
      location: "Москва",
    });
  });

  it("fetches a job's full text from the id-filtered vacancies endpoint", async () => {
    const detailJson = fixture("yadro-vacancy-2492.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:yadro:2492",
      url: "https://careers.yadro.com/vacancy/102492",
      title: "Руководитель отдела инфраструктуры / Lead DevOps / Head of Infrastructure",
      company: "YADRO",
      location: "Нижний Новгород",
    };
    const vacancy = await yadro.fetchJob("https://careers.yadro.com", discovered);

    expect(calls).toEqual(["https://careers.yadro.com/api/v1/vacancies/?id=2492"]);
    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("YADRO");
    expect(vacancy.area).toBe("Нижний Новгород");
    expect(vacancy.workFormat).toBe("Работа в офисе");
    expect(vacancy.descriptionText).toContain("Руководить командой");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
  });
});
