import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as amocrm } from "../../../src/career/ats/sites/amocrm.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(dir, "..", "fixtures", "sites", name), "utf8");

const ORIGIN = "https://www.amocrm.ru";

function mockFetch(routes: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = routes[url];
      if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("amoCRM ATS client", () => {
  it("detects www.amocrm.ru as the host", () => {
    expect(amocrm.detect(`${ORIGIN}/jobs/`, "")).toEqual({ token: ORIGIN });
    expect(amocrm.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs from the flat /jobs/ page", async () => {
    mockFetch({ [`${ORIGIN}/jobs/`]: fixture("amocrm-jobs.html") });
    const jobs = await amocrm.listJobs(ORIGIN);
    expect(jobs).toHaveLength(3);
    const php = jobs.find((j) => j.externalId === "site:amocrm:junior-php-developer");
    expect(php).toMatchObject({
      url: `${ORIGIN}/jobs/production/junior-php-developer/`,
      title: "Junior/Junior+ PHP Разработчик",
      company: "amoCRM",
      location: "Производство",
    });
    const support = jobs.find((j) => j.externalId === "site:amocrm:technical-support");
    expect(support?.title).toBe("Специалист технической поддержки");
  });

  it("fetches a job's full description from the detail page", async () => {
    const url = `${ORIGIN}/jobs/production/junior-php-developer/`;
    mockFetch({ [url]: fixture("amocrm-job.html") });
    const v = await amocrm.fetchJob(ORIGIN, {
      externalId: "site:amocrm:junior-php-developer",
      url,
      title: "",
      company: "amoCRM",
      location: "Производство",
    });
    expect(v.title).toBe("Junior/Junior+ PHP Разработчик");
    expect(v.company).toBe("amoCRM");
    expect(v.area).toBe("Производство");
    expect(v.descriptionText).toContain("PHP");
    expect(v.descriptionText).toContain("MySQL");
    expect(v.descriptionText).not.toContain("<iframe");
    expect(v.salaryFrom).toBe(0);
  });
});
