import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as severstal } from "../../../src/career/ats/sites/severstal.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("severstal ats client", () => {
  it("detects the Severstal careers host", () => {
    expect(severstal.detect("https://career.severstal.com/vacancies/", "")).toEqual({ token: "https://career.severstal.com" });
    expect(severstal.detect("https://example.com/careers", "")).toBeNull();
    expect(severstal.detect("https://example.com/careers", "fetch('https://career.severstal.com/vacancies/?direction=it')")).toEqual(
      { token: "https://career.severstal.com" },
    );
  });

  it("pages through the XHR listing endpoint until isLast", async () => {
    const page1 = fixture("severstal-vacancies-it-page1.json");
    const page2 = fixture("severstal-vacancies-it-page2.json");
    const calls: { url: string; headers: HeadersInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: init?.headers });
        return jsonResponse(url.includes("page=2") ? page2 : page1);
      }),
    );

    const jobs = await severstal.listJobs("https://career.severstal.com");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/vacancies/?direction=it&page=1");
    expect(new Headers(calls[0]?.headers).get("x-requested-with")).toBe("XMLHttpRequest");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:severstal:menedzher-otdela-metodologii-i-razvitiya-ib",
      url: "https://career.severstal.com/vacancies/menedzher-otdela-metodologii-i-razvitiya-ib/",
      title: "Менеджер отдела методологии и развития ИБ",
      company: "Severstal",
      location: "Москва (АО Северсталь Менеджмент)",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:severstal:rukovoditel-it-proektov-ii-ml",
      title: "Руководитель ИТ-проектов (ИИ/ML)",
    });
  });

  it("fetches a job's full text from the JobPosting microdata", async () => {
    const detailHtml = fixture("severstal-vacancy-it-partnyer.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:severstal:it-partnyer_1",
      url: "https://career.severstal.com/vacancies/it-partnyer_1/",
      title: "ИТ-партнёр",
      company: "Severstal",
      location: "Москва (АО «Северсталь-инфоком»)",
    };
    const vacancy = await severstal.fetchJob("https://career.severstal.com", discovered);

    expect(vacancy.title).toBe("ИТ-партнёр");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Severstal");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Полная");
    expect(vacancy.publishedAt).toBe(new Date("2026-08-17").toISOString());
    expect(vacancy.descriptionText).toContain("Примеры будущих задач");
    expect(vacancy.descriptionText).toContain("анализировать бизнес-стратегию");
    expect(vacancy.descriptionText).not.toContain("Откликнуться");
  });
});
