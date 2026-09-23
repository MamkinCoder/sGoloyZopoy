import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as irg } from "../../../src/career/ats/sites/inventive-retail-group.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inventive-retail-group ats client", () => {
  it("detects the job.inventive.ru host", () => {
    expect(irg.detect("https://job.inventive.ru/vacancies/", "")).toEqual({ token: "https://job.inventive.ru" });
    expect(irg.detect("https://example.com/careers", "")).toBeNull();
    expect(irg.detect("https://irgroup.ru/career/", "")).toBeNull();
  });

  it("lists jobs from the first page and stops once a page comes back short of per_page", async () => {
    const page1 = fixture("inventive-retail-group-vacancies-page1.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(page1);
      }),
    );

    const jobs = await irg.listJobs("https://job.inventive.ru");

    expect(calls).toEqual(["https://job.inventive.ru/wp-json/wp/v2/vacancy?per_page=100&page=1"]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "site:inventive-retail-group:160546",
      url: "https://job.inventive.ru/vacancy/assistent-po-ohrane-truda/",
      title: "Ассистент по охране труда",
      company: "Inventive Retail Group",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:inventive-retail-group:160500",
      title: "Продавец магазина Мир Кубиков в ТРЦ Казань Молл",
    });
  });

  it("keeps paginating while a page is full-sized (per_page)", async () => {
    const fullPage = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({
        id: 1000 + i,
        slug: `job-${i}`,
        link: `https://job.inventive.ru/vacancy/job-${i}/`,
        title: { rendered: `Job ${i}` },
        content: { rendered: "<p>desc</p>" },
      })),
    );
    const page2 = fixture("inventive-retail-group-vacancies-page2.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return url.includes("page=2") ? jsonResponse(page2) : jsonResponse(fullPage);
      }),
    );

    const jobs = await irg.listJobs("https://job.inventive.ru");

    expect(calls).toEqual([
      "https://job.inventive.ru/wp-json/wp/v2/vacancy?per_page=100&page=1",
      "https://job.inventive.ru/wp-json/wp/v2/vacancy?per_page=100&page=2",
    ]);
    expect(jobs).toHaveLength(101);
    expect(jobs[100]).toMatchObject({ externalId: "site:inventive-retail-group:6822", title: "Продавец-консультант Hiker" });
  });

  it("fetches a job's full text, city and work format from the detail page", async () => {
    const detailHtml = fixture("inventive-retail-group-vacancy-160546.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:inventive-retail-group:160546",
      url: "https://job.inventive.ru/vacancy/assistent-po-ohrane-truda/",
      title: "Ассистент по охране труда",
      company: "Inventive Retail Group",
      raw: {
        id: 160546,
        slug: "assistent-po-ohrane-truda",
        link: "https://job.inventive.ru/vacancy/assistent-po-ohrane-truda/",
        title: { rendered: "Ассистент по охране труда" },
        content: {
          rendered:
            "<p>Если давно присматривался к этой роли &#8212; самое время попробовать.</p><ul><li>Разработка и актуализация локальных нормативных актов по охране труда;</li></ul>",
        },
      },
    };
    const vacancy = await irg.fetchJob("https://job.inventive.ru", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Inventive Retail Group");
    expect(vacancy.descriptionText).toContain("Разработка и актуализация локальных нормативных актов");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Полная занятость");
    expect(vacancy.salaryFrom).toBe(0);
  });
});
