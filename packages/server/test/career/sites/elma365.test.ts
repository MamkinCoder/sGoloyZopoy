import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as elma365 } from "../../../src/career/ats/sites/elma365.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(dir, "..", "fixtures", "sites", name), "utf8");

const ORIGIN = "https://elma365.com";
const LIST_URL = `${ORIGIN}/ru/company/careers/`;

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

describe("elma365 ATS client", () => {
  it("detects by host", () => {
    expect(elma365.detect(`${ORIGIN}/ru/company/careers/`, "")).toEqual({ token: ORIGIN });
    expect(elma365.detect("https://example.com/", "")).toBeNull();
  });

  it("detects from page HTML when the base_url host is shared/unrecognized", () => {
    expect(elma365.detect("https://example.com/", "see elma365.com/ru/company/careers/ for jobs")).toEqual({ token: ORIGIN });
  });

  it("lists all jobs across categories from the __NUXT__ payload on the careers page", async () => {
    mockFetch({ [LIST_URL]: fixture("elma365-careers.html") });

    const jobs = await elma365.listJobs(ORIGIN);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:elma365:sales-manager-b2g",
      url: `${ORIGIN}/ru/company/careers/sales-manager-b2g/`,
      title: "Менеджер по продажам B2G",
      company: "ELMA365",
      location: "Санкт-Петербург, Ижевск",
    });
    expect(jobs.map((j) => j.externalId)).toEqual([
      "site:elma365:sales-manager-b2g",
      "site:elma365:sales-manager-it",
      "site:elma365:hrd",
    ]);
  });

  it("fetches job detail from the __NUXT__ payload on the vacancy page", async () => {
    const url = `${ORIGIN}/ru/company/careers/sales-manager-b2g/`;
    mockFetch({ [url]: fixture("elma365-vacancy-sales-manager-b2g.html") });

    const v = await elma365.fetchJob(ORIGIN, {
      externalId: "site:elma365:sales-manager-b2g",
      url,
      title: "Менеджер по продажам B2G",
      company: "ELMA365",
    });

    expect(v.title).toBe("Менеджер по продажам B2G");
    expect(v.company).toBe("ELMA365");
    expect(v.url).toBe(url);
    expect(v.descriptionText).toContain("Формирование методики продажи продуктов вертикали");
    expect(v.descriptionText).toContain("Успешный опыт продаж крупных IT-проектов");
    expect(v.descriptionText).toContain("белая ЗП");
    expect(v.descriptionText).not.toContain("<li>");
    expect(v.area).toBe("Санкт-Петербург, Ижевск");
    expect(v.workFormat).toBe("офис");
    expect(v.salaryFrom).toBe(0);
    expect(v.salaryTo).toBe(0);
  });
});
