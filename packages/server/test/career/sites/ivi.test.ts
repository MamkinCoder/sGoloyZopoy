import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as ivi } from "../../../src/career/ats/sites/ivi.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(dir, "../fixtures/sites", name), "utf8");

const ORIGIN = "https://corp.ivi.ru";

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

describe("ivi ATS client", () => {
  it("detects corp.ivi.ru as the host", () => {
    expect(ivi.detect(`${ORIGIN}/vacancies/`, "")).toEqual({ token: ORIGIN });
    expect(ivi.detect("https://www.ivi.ru/pages/jobs", "")).toBeNull();
  });

  it("falls back to sniffing the html when the base host differs", () => {
    expect(ivi.detect("https://www.ivi.ru/pages/jobs", `see ${ORIGIN}/vacancies/`)).toEqual({ token: ORIGIN });
  });

  it("lists jobs by discovering category sections then reading each section page", async () => {
    mockFetch({
      [`${ORIGIN}/vacancies/`]: fixture("ivi-vacancies.html"),
      [`${ORIGIN}/vacancies/it-product/`]: fixture("ivi-section-it-product.html"),
      [`${ORIGIN}/vacancies/business/`]: fixture("ivi-section-business.html"),
    });
    const jobs = await ivi.listJobs(ORIGIN);
    const ids = jobs.map((j) => j.externalId).sort();
    expect(ids).toEqual([
      "site:ivi:golang-developer",
      "site:ivi:java-razrabotchik-big-data",
      "site:ivi:menedzher-po-zakupkam",
      "site:ivi:sistemnyj-administrator-linux-devops",
    ]);
    const golang = jobs.find((j) => j.externalId === "site:ivi:golang-developer");
    expect(golang).toMatchObject({
      url: `${ORIGIN}/vacancy/golang-developer/`,
      title: "Golang developer",
      company: "IVI",
    });
  });

  it("fetches a job's full description from the vacancy blocks, skipping benefits", async () => {
    const url = `${ORIGIN}/vacancy/golang-developer/`;
    mockFetch({ [url]: fixture("ivi-job-golang-developer.html") });
    const v = await ivi.fetchJob(ORIGIN, {
      externalId: "site:ivi:golang-developer",
      url,
      title: "Golang developer",
      company: "IVI",
      raw: { level: "Middle" },
    });
    expect(v.title).toBe("Golang developer");
    expect(v.company).toBe("IVI");
    expect(v.descriptionText).toContain("Разрабатываем высоконагруженные сервисы");
    expect(v.descriptionText).toContain("Уровень: Middle");
    expect(v.descriptionText).toContain("Опыт разработки на Go от 2 лет");
    expect(v.descriptionText).not.toContain("ДМС со стоматологией");
    expect(v.salaryFrom).toBe(0);
    expect(v.area).toBe("");
    expect(v.workFormat).toBe("");
  });
});
