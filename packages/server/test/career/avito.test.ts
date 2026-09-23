import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { avito } from "../../src/career/ats/avito.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(dir, "fixtures", name), "utf8");

const ORIGIN = "https://career.avito.com";

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

describe("avito ATS client", () => {
  it("detects career.avito.com as the host", () => {
    expect(avito.detect(`${ORIGIN}/vacancies/`, "")).toEqual({ token: ORIGIN });
    expect(avito.detect("https://www.avito.ru/company/job", "")).toBeNull();
  });

  it("lists jobs by discovering section slugs then reading each section page", async () => {
    mockFetch({
      [`${ORIGIN}/vacancies/`]: fixture("avito-vacancies.html"),
      [`${ORIGIN}/vacancies/razrabotka/`]: fixture("avito-section-razrabotka.html"),
      [`${ORIGIN}/vacancies/prodazhi/`]: fixture("avito-vacancies.html"), // reuse: only need its 1 sales item
    });
    const jobs = await avito.listJobs(ORIGIN);
    const ids = jobs.map((j) => j.externalId).sort();
    expect(ids).toEqual(["avito:7880", "avito:8152", "avito:8198"]);
    const telemetry = jobs.find((j) => j.externalId === "avito:8152");
    expect(telemetry).toMatchObject({
      url: `${ORIGIN}/vacancies/razrabotka/20492/`,
      title: "Техлид разработки в команду Telemetry",
      company: "Avito",
    });
    const sales = jobs.find((j) => j.externalId === "avito:8198");
    expect(sales?.location).toBe("Екатеринбург, Пермь");
  });

  it("fetches a job's full vacancy from the JobPosting JSON-LD", async () => {
    const url = `${ORIGIN}/vacancies/razrabotka/20492/`;
    mockFetch({ [url]: fixture("avito-job.html") });
    const v = await avito.fetchJob(ORIGIN, { externalId: "avito:8152", url, title: "", company: "Avito" });
    expect(v.title).toBe("Техлид разработки в команду Telemetry");
    expect(v.company).toBe("Avito");
    expect(v.area).toBe("Москва");
    expect(v.workFormat).toBe("Полная занятость");
    expect(v.descriptionText).toContain("Kubernetes");
    expect(v.descriptionText).not.toContain("&nbsp;");
    expect(v.publishedAt).toBe("2026-09-10T10:46:02.000Z");
    expect(v.salaryFrom).toBe(0);
  });
});
