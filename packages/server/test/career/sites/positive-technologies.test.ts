import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as positiveTechnologies } from "../../../src/career/ats/sites/positive-technologies.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("positive-technologies ats client", () => {
  it("detects the Positive Technologies careers host", () => {
    expect(positiveTechnologies.detect("https://ptsecurity.com/about/vacancy/", "")).toEqual({ token: "https://ptsecurity.com" });
    expect(positiveTechnologies.detect("https://example.com/careers", "")).toBeNull();
    expect(positiveTechnologies.detect("https://example.com/careers", "fetch('https://ptsecurity.com/ru-ru/about/vacancy/x')")).toEqual(
      { token: "https://ptsecurity.com" },
    );
  });

  it("lists all jobs from the server-rendered listing page", async () => {
    const listHtml = fixture("positive-technologies-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await positiveTechnologies.listJobs("https://ptsecurity.com");

    expect(calls).toEqual(["https://ptsecurity.com/about/vacancy/"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:positive-technologies:senior-backend-go-developer",
      url: "https://ptsecurity.com/ru-ru/about/vacancy/senior-backend-go-developer/",
      title: "Lead Backend Go Developer",
      company: "Positive Technologies",
      location: "Удаленная работа",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:positive-technologies:350192",
      title: "Специалист по анализу защищенности банковских систем",
      location: "Удаленная работа",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:positive-technologies:pricnipal-performance-engineer",
      title: "Pricnipal performance engineer",
      location: "Москва, Удаленная работа",
    });
  });

  it("fetches a job's full text from the article-content block", async () => {
    const detailHtml = fixture("positive-technologies-vacancy-senior-backend-go-developer.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:positive-technologies:senior-backend-go-developer",
      url: "https://ptsecurity.com/ru-ru/about/vacancy/senior-backend-go-developer/",
      title: "Lead Backend Go Developer",
      company: "Positive Technologies",
      location: "Удаленная работа",
    };
    const vacancy = await positiveTechnologies.fetchJob("https://ptsecurity.com", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Positive Technologies");
    expect(vacancy.area).toBe("Удаленная работа");
    expect(vacancy.descriptionText).toContain("разработка и поддержка сервисов на Go для NGFW-решений");
    expect(vacancy.descriptionText).toContain("Наши ожидания");
    expect(vacancy.descriptionText).not.toContain("Мы предлагаем");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
