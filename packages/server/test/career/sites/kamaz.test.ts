import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as kamaz } from "../../../src/career/ats/sites/kamaz.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const ORIGIN = "https://kamaz.ru";

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

function mockFetch(routes: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = routes[url];
      if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
      return htmlResponse(body);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("kamaz ats client", () => {
  it("detects the kamaz.ru host", () => {
    expect(kamaz.detect(`${ORIGIN}/career/work/vacancies/`, "")).toEqual({ token: ORIGIN });
    expect(kamaz.detect("https://example.com/vacancies", "")).toBeNull();
  });

  it("detects by page content when the host differs", () => {
    expect(
      kamaz.detect("https://example.com/", "<a href='https://kamaz.ru/career/work/vacancies/260856/'>job</a>"),
    ).toEqual({ token: ORIGIN });
  });

  it("lists all jobs from the single unpaginated listing page", async () => {
    mockFetch({ [`${ORIGIN}/career/work/vacancies/`]: fixture("kamaz-vacancies.html") });

    const jobs = await kamaz.listJobs(ORIGIN);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:kamaz:344208",
      url: `${ORIGIN}/career/work/vacancies/344208/`,
      title: "Штамповщик",
      company: "КАМАЗ",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:kamaz:260856",
      url: `${ORIGIN}/career/work/vacancies/260856/`,
      title: "Слесарь-сантехник",
    });
  });

  it("fetches a job with a single 'from' salary", async () => {
    const url = `${ORIGIN}/career/work/vacancies/260856/`;
    mockFetch({ [url]: fixture("kamaz-vacancy-260856.html") });

    const discovered = { externalId: "site:kamaz:260856", url, title: "Слесарь-сантехник", company: "КАМАЗ" };
    const vacancy = await kamaz.fetchJob(ORIGIN, discovered);

    expect(vacancy.title).toBe("Слесарь-сантехник");
    expect(vacancy.company).toBe("КАМАЗ");
    expect(vacancy.url).toBe(url);
    expect(vacancy.salaryFrom).toBe(75000);
    expect(vacancy.salaryTo).toBe(0);
    expect(vacancy.currency).toBe("RUB");
    expect(vacancy.descriptionText).toContain("ЧЕМ ВАМ ПРЕДСТОИТ ЗАНИМАТЬСЯ");
    expect(vacancy.descriptionText).toContain("Планово-предупредительного ремонта".toLowerCase());
    expect(vacancy.descriptionText).not.toContain("<");
  });

  it("fetches a job with a from-to salary range", async () => {
    const url = `${ORIGIN}/career/work/vacancies/342824/`;
    mockFetch({ [url]: fixture("kamaz-vacancy-342824.html") });

    const discovered = { externalId: "site:kamaz:342824", url, title: "Водитель погрузчика", company: "КАМАЗ" };
    const vacancy = await kamaz.fetchJob(ORIGIN, discovered);

    expect(vacancy.title).toBe("Водитель погрузчика");
    expect(vacancy.salaryFrom).toBe(82000);
    expect(vacancy.salaryTo).toBe(107000);
    expect(vacancy.descriptionText).toContain("Погрузка и разгрузка материалов на складе");
  });
});
