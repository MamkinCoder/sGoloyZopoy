import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as kontur } from "../../../src/career/ats/sites/kontur.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("kontur ats client", () => {
  it("detects the Kontur careers host", () => {
    expect(kontur.detect("https://kontur.ru/career/vacancies", "")).toEqual({ token: "https://kontur.ru" });
    expect(kontur.detect("https://example.com/careers", "")).toBeNull();
    expect(kontur.detect("https://kontur.ru/about", "")).toBeNull();
  });

  it("lists all jobs from the server-rendered vacancies page", async () => {
    const listHtml = fixture("kontur-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await kontur.listJobs("https://kontur.ru");

    expect(calls).toEqual(["https://kontur.ru/career/vacancies"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:kontur:3728",
      url: "https://kontur.ru/career/vacancies/3728",
      title: "Руководитель команды разработки",
      company: "Контур",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:kontur:5818", title: "Ведущий data scientist по ИИ-агентам, senior" });
    expect(jobs[2]).toMatchObject({ externalId: "site:kontur:5833", title: "ML‑разработчик, middle+/senior" });
  });

  it("fetches a job's full text from the schema.org JobPosting JSON-LD block", async () => {
    const detailHtml = fixture("kontur-vacancy-5818.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:kontur:5818",
      url: "https://kontur.ru/career/vacancies/5818",
      title: "Ведущий data scientist по ИИ-агентам, senior",
      company: "Контур",
    };
    const vacancy = await kontur.fetchJob("https://kontur.ru", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Контур");
    expect(vacancy.descriptionText).toContain("Проектировать и реализовывать агентное ядро");
    expect(vacancy.area).toContain("Екатеринбург");
    expect(vacancy.workFormat).toBe("офис, удалённо или гибридно");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
