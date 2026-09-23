import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vk } from "../../src/career/ats/vk.js";

const FIXTURES = join(__dirname, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vk ats client", () => {
  it("detects the VK careers host", () => {
    expect(vk.detect("https://team.vk.company/vacancy/", "")).toEqual({ token: "https://team.vk.company" });
    expect(vk.detect("https://example.com/careers", "")).toBeNull();
    expect(vk.detect("https://example.com/careers", "fetch('/career/api/v2/vacancies/?limit=1')")).toEqual({
      token: "https://example.com",
    });
  });

  it("lists all jobs across pages", async () => {
    const page1 = fixture("vk-vacancies-page1.json");
    const page2 = fixture("vk-vacancies-page2.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return url.includes("offset=50") ? jsonResponse(page2) : jsonResponse(page1);
      }),
    );

    const jobs = await vk.listJobs("https://team.vk.company");

    expect(calls).toEqual([
      "https://team.vk.company/career/api/v2/vacancies/?limit=50&offset=0",
      "https://team.vk.company/career/api/v2/vacancies/?limit=50&offset=50",
    ]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "vk:54608",
      url: "https://team.vk.company/vacancy/54608/",
      title: "Go-разработчик в команду контентных сервисов",
      company: "VK Коммерция",
      location: "Москва",
    });
    expect(jobs[2]).toMatchObject({ externalId: "vk:45850", company: "VKontakte" });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const detailHtml = fixture("vk-vacancy-detail.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "vk:54608",
      url: "https://team.vk.company/vacancy/54608/",
      title: "Go-разработчик в команду контентных сервисов",
      company: "VK Коммерция",
      location: "Москва",
    };
    const vacancy = await vk.fetchJob("https://team.vk.company", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.descriptionText).toContain("Разрабатывать и проектировать backend на Go");
    expect(vacancy.descriptionText).toContain("Требования");
    expect(vacancy.descriptionText).toContain("Уровень: middle, senior");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
