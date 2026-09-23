import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as oneC } from "../../../src/career/ats/sites/1c.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const ORIGIN = "https://1c.ru";
const LIST_URL = `${ORIGIN}/rus/firm1c/vacan/search`;

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

describe("1c ats client", () => {
  it("detects the 1c.ru host", () => {
    expect(oneC.detect(`${ORIGIN}/rus/firm1c/vacan/`, "")).toEqual({ token: ORIGIN });
    expect(oneC.detect("https://example.com/vacancies", "")).toBeNull();
  });

  it("detects by page content when the host differs", () => {
    expect(oneC.detect("https://example.com/", "<a href='https://1c.ru/rus/firm1c/vacan/vacancy/93'>job</a>")).toEqual({ token: ORIGIN });
  });

  it("lists all jobs across pages until an empty page", async () => {
    mockFetch({
      [`${LIST_URL}?page=1&ajax=1`]: fixture("1c-search-page1.html"),
      [`${LIST_URL}?page=2&ajax=1`]: fixture("1c-search-page2-empty.html"),
    });

    const jobs = await oneC.listJobs(ORIGIN);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:1c:169",
      url: `${ORIGIN}/rus/firm1c/vacan/vacancy/169`,
      title: "Тестировщик 1С Обмены",
      company: "1C",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:1c:103",
      title: "Архитектор 1С/ системный архитектор 1С",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:1c:93",
      title: "Разработчик 1С",
    });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const url = `${ORIGIN}/rus/firm1c/vacan/vacancy/93`;
    mockFetch({ [url]: fixture("1c-vacancy-93.html") });

    const discovered = { externalId: "site:1c:93", url, title: "Разработчик 1С", company: "1C" };

    const vacancy = await oneC.fetchJob(ORIGIN, discovered);

    expect(vacancy.title).toBe("Разработчик 1С");
    expect(vacancy.company).toBe("1C");
    expect(vacancy.url).toBe(url);
    expect(vacancy.workFormat).toBe("Офис");
    expect(vacancy.descriptionText).toContain("лидер рынка автоматизации");
    expect(vacancy.descriptionText).toContain("Обязанности");
    expect(vacancy.descriptionText).toContain("Требования");
    expect(vacancy.descriptionText).toContain("XML, JSON, XDTO");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.descriptionText).not.toContain("&laquo;");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.area).toBe("");
  });

  it("fetches a second job to confirm per-page fields vary", async () => {
    const url = `${ORIGIN}/rus/firm1c/vacan/vacancy/169`;
    mockFetch({ [url]: fixture("1c-vacancy-169.html") });

    const discovered = { externalId: "site:1c:169", url, title: "Тестировщик 1С Обмены", company: "1C" };

    const vacancy = await oneC.fetchJob(ORIGIN, discovered);

    expect(vacancy.title).toBe("Тестировщик 1С Обмены");
    expect(vacancy.workFormat).toBe("Гибрид");
    expect(vacancy.descriptionText).toContain("Регрессионное тестирование ERP");
  });
});
