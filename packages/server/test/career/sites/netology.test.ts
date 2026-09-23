import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as netology } from "../../../src/career/ats/sites/netology.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("netology ats client", () => {
  it("detects the Netology host", () => {
    expect(netology.detect("https://netology.ru/job", "")).toEqual({ token: "https://netology.ru" });
    expect(netology.detect("https://example.com/careers", "")).toBeNull();
    expect(netology.detect("https://example.com/careers", "see netology.ru/job for openings")).toEqual({
      token: "https://netology.ru",
    });
  });

  it("lists published jobs from __NEXT_DATA__, skipping unpublished ones", async () => {
    const listHtml = fixture("netology-jobs.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await netology.listJobs("https://netology.ru");

    expect(calls).toEqual(["https://netology.ru/job"]);
    expect(jobs).toHaveLength(3); // 4 in fixture, 1 unpublished dropped
    expect(jobs.map((j) => j.externalId)).not.toContain("site:netology:aaaaaaaa-0000-0000-0000-000000000004");
    expect(jobs[1]).toMatchObject({
      externalId: "site:netology:aaaaaaaa-0000-0000-0000-000000000002",
      url: "https://netology.ru/job/aaaaaaaa-0000-0000-0000-000000000002",
      title: "Frontend-разработчик",
      company: "Netology",
      location: "remote",
    });
  });

  it("fetches a job's full text from the detail page's __NEXT_DATA__", async () => {
    const detailHtml = fixture("netology-job-detail.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:netology:aaaaaaaa-0000-0000-0000-000000000002",
      url: "https://netology.ru/job/aaaaaaaa-0000-0000-0000-000000000002",
      title: "Frontend-разработчик",
      company: "Netology",
      location: "remote",
    };
    const vacancy = await netology.fetchJob("https://netology.ru", discovered);

    expect(vacancy.title).toBe("Frontend-разработчик");
    expect(vacancy.company).toBe("Netology");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.area).toBe("remote");
    expect(vacancy.workFormat).toBe("Полная занятость");
    expect(vacancy.descriptionText).toContain("Разрабатывать интерфейсы на React");
    expect(vacancy.descriptionText).toContain("Что важно для нас:");
    expect(vacancy.descriptionText).toContain("Уровень: middle");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
  });
});
