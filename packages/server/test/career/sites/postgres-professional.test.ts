import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as postgresProfessional } from "../../../src/career/ats/sites/postgres-professional.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postgres-professional ats client", () => {
  it("detects the career.postgrespro.ru host", () => {
    expect(postgresProfessional.detect("https://career.postgrespro.ru/vacancies", "")).toEqual({
      token: "https://career.postgrespro.ru",
    });
    expect(postgresProfessional.detect("https://example.com/career", "")).toBeNull();
    expect(
      postgresProfessional.detect("https://example.com/career", "some markup mentioning career.postgrespro.ru/vacancies"),
    ).toEqual({ token: "https://career.postgrespro.ru" });
  });

  it("lists all jobs from the server-rendered listing page", async () => {
    const listHtml = fixture("postgres-professional-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await postgresProfessional.listJobs("https://career.postgrespro.ru");

    expect(calls).toEqual(["https://career.postgrespro.ru/vacancies"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:postgres-professional:170444641",
      url: "https://career.postgrespro.ru/vacancies/170444641",
      title: "Tech Presale 1С",
      company: "Postgres Professional",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:postgres-professional:170444700",
      url: "https://career.postgrespro.ru/vacancies/170444700",
      title: "Менеджер по продажам",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:postgres-professional:170444712",
      url: "https://career.postgrespro.ru/vacancies/170444712",
      title: "Специалист по информационной безопасности",
    });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const detailHtml = fixture("postgres-professional-vacancy-170444641.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(detailHtml);
      }),
    );

    const discovered = {
      externalId: "site:postgres-professional:170444641",
      url: "https://career.postgrespro.ru/vacancies/170444641",
      title: "Tech Presale 1С",
      company: "Postgres Professional",
    };

    const vacancy = await postgresProfessional.fetchJob("https://career.postgrespro.ru", discovered);

    expect(calls).toEqual(["https://career.postgrespro.ru/vacancies/170444641"]);
    expect(vacancy.title).toBe("Tech Presale 1С");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Postgres Professional");
    expect(vacancy.descriptionText).toContain("Сейчас мы ищем");
    expect(vacancy.descriptionText).toContain("Чем предстоит заниматься");
    expect(vacancy.descriptionText).toContain("уверенные знания в 1С");
    expect(vacancy.descriptionText).not.toContain("ФИО");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
