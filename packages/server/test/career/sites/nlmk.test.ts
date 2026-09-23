import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as nlmk } from "../../../src/career/ats/sites/nlmk.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const ORIGIN = "https://career.nlmk.com";
const LIST_URL = `${ORIGIN}/vacancy/`;

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

describe("nlmk ats client", () => {
  it("detects the career.nlmk.com host", () => {
    expect(nlmk.detect(`${ORIGIN}/vacancy/`, "")).toEqual({ token: ORIGIN });
    expect(nlmk.detect("https://example.com/careers", "")).toBeNull();
  });

  it("detects by page content when the host differs", () => {
    expect(nlmk.detect("https://example.com/", "<a href='https://career.nlmk.com/vacancy/'>job</a>")).toEqual({ token: ORIGIN });
  });

  it("lists all jobs from the single server-rendered listing page", async () => {
    mockFetch({ [LIST_URL]: fixture("nlmk-vacancies.html") });

    const jobs = await nlmk.listJobs(ORIGIN);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:nlmk:data-scientist-ml-cv-",
      url: `${ORIGIN}/vacancy/detail/data-scientist-ml-cv-/`,
      title: "Data scientist (ML/CV)",
      company: "НЛМК-Информационные технологии",
      location: "Москва",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:nlmk:ml-engineer-",
      title: "ML engineer",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:nlmk:starshiy-menedzher-it-protsessov-",
      title: "Старший менеджер ИТ процессов",
      company: "НЛМК-Информационные технологии",
    });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const url = `${ORIGIN}/vacancy/detail/ml-engineer-/`;
    mockFetch({ [url]: fixture("nlmk-vacancy-ml-engineer.html") });

    const discovered = {
      externalId: "site:nlmk:ml-engineer-",
      url,
      title: "ML engineer",
      company: "НЛМК-Информационные технологии",
      location: "Москва",
    };

    const vacancy = await nlmk.fetchJob(ORIGIN, discovered);

    expect(vacancy.title).toBe("ML engineer");
    expect(vacancy.company).toBe("НЛМК-Информационные технологии");
    expect(vacancy.url).toBe(url);
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toContain("Полный день");
    expect(vacancy.descriptionText).toContain("машинного обучения");
    expect(vacancy.descriptionText).toContain("Чем предстоит заниматься");
    expect(vacancy.descriptionText).toContain("xgboost/catboost/lightgbm");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
  });
});
