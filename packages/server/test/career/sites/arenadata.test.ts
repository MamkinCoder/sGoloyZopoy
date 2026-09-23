import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as arenadata } from "../../../src/career/ats/sites/arenadata.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("arenadata ats client", () => {
  it("detects the Arenadata careers host", () => {
    expect(arenadata.detect("https://arenadata.tech/ru/career", "")).toEqual({ token: "https://arenadata.tech" });
    expect(arenadata.detect("https://career.arenadata.tech/", "")).toEqual({ token: "https://arenadata.tech" });
    expect(arenadata.detect("https://example.com/careers", "")).toBeNull();
  });

  it("lists all jobs embedded as JSON in the listing page's RSC flight chunk", async () => {
    const listHtml = fixture("arenadata-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await arenadata.listJobs("https://arenadata.tech");

    expect(calls).toEqual(["https://arenadata.tech/ru/career"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:arenadata:senior-go-developer",
      url: "https://arenadata.tech/ru/career/senior-go-developer",
      title: "Senior Go Developer",
      company: "Arenadata",
    });
    // company varies per vacancy (product subsidiary brand), not hardcoded
    expect(jobs[1]).toMatchObject({ externalId: "site:arenadata:devops", title: "DevOps", company: "DataCatalog" });
    expect(jobs[2]).toMatchObject({ externalId: "site:arenadata:administrator-ofisa", company: "Arenadata" });
  });

  it("fetches a job's full text from the server-rendered detail sections", async () => {
    const detailHtml = fixture("arenadata-vacancy-senior-go-developer.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:arenadata:senior-go-developer",
      url: "https://arenadata.tech/ru/career/senior-go-developer",
      title: "Senior Go Developer",
      company: "Arenadata",
      raw: { slug: "senior-go-developer", position: "Senior Go Developer", positionGrade: "senior", product: "Arenadata QuickMarts Control", department: "Техническая дирекция", company: "Arenadata" },
    };
    const vacancy = await arenadata.fetchJob("https://arenadata.tech", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Arenadata");
    expect(vacancy.descriptionText).toContain("ADQM Control");
    expect(vacancy.descriptionText).toContain("заниматься разработкой и развитием сервисов на Golang");
    expect(vacancy.descriptionText).toContain("имеете опыт коммерческой разработки на Golang от 4 лет");
    expect(vacancy.descriptionText).toContain("Команда Технической дирекции");
    // the boilerplate hiring-stages / benefits sections are skipped
    expect(vacancy.descriptionText).not.toContain("Этапы найма");
    expect(vacancy.descriptionText).not.toContain("Расширенный ДМС");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
