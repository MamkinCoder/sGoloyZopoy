import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as habr, listUrl, QUERIES } from "../../../src/career/ats/sites/habr-career.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const json = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "application/json" } });
const empty = JSON.stringify({ list: [], meta: { totalPages: 0, currentPage: 1 } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("habr-career ats client", () => {
  it("detects career.habr.com only", () => {
    expect(habr.detect("https://career.habr.com/vacancies", "")).toEqual({ token: "https://career.habr.com" });
    expect(habr.detect("https://habr.com/ru/articles/1", "")).toBeNull();
  });

  it("runs every fixed query, maps fields and dedups by id", async () => {
    const golang = fixture("habr-career-vacancies-golang.json"); // totalPages 1
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        // "go" returns the same page as "golang" -> must dedup
        return json(url.includes("q=golang&") || url.includes("q=go&") ? golang : empty);
      }),
    );

    const jobs = await habr.listJobs("https://career.habr.com");

    expect(calls).toEqual(QUERIES.map((q) => listUrl(q, 1)));
    expect(calls[0]).toBe("https://career.habr.com/api/frontend/vacancies?q=golang&sort=date&type=all&page=1");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:habr-career:1000168517",
      url: "https://career.habr.com/vacancies/1000168517",
      title: "Golang разработчик",
      company: "BGStaff",
      location: "удалённо",
    });
    expect(jobs[1]).toMatchObject({ company: "Яндекс", location: "Москва, Санкт-Петербург, Минск" });
    expect(jobs[2]).toMatchObject({ title: "Junior Go Developer", location: "Казань, удалённо" });
  });

  it("caps pages per query at 3", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const id = calls.length;
        return json(JSON.stringify({ list: [{ id, href: `/vacancies/${id}`, title: `T${id}` }], meta: { totalPages: 99, currentPage: 1 } }));
      }),
    );

    const jobs = await habr.listJobs("https://career.habr.com");

    expect(calls.filter((u) => u.includes("q=golang&"))).toEqual([1, 2, 3].map((p) => listUrl("golang", p)));
    expect(calls).toHaveLength(QUERIES.length * 3);
    expect(jobs).toHaveLength(QUERIES.length * 3);
  });

  it("stops cleanly on 429 and keeps what it had", async () => {
    const golang = fixture("habr-career-vacancies-golang.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return calls.length === 1 ? json(golang) : json("", 429);
      }),
    );

    const jobs = await habr.listJobs("https://career.habr.com");

    expect(calls).toHaveLength(2);
    expect(jobs).toHaveLength(3);
  });

  it("fetches description, salary and location from the page's JSON-LD", async () => {
    const html = fixture("habr-career-vacancy-1000168365.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      }),
    );

    const v = await habr.fetchJob("https://career.habr.com", {
      externalId: "site:habr-career:1000168365",
      url: "https://career.habr.com/vacancies/1000168365",
      title: "Junior Go Developer",
      company: "ITK academy",
    });

    expect(calls).toEqual(["https://career.habr.com/vacancies/1000168365"]);
    expect(v).toMatchObject({
      source: "site:habr-career",
      title: "Junior Go Developer",
      company: "ITK academy",
      area: "Казань",
      workFormat: "Удалённо",
      salaryFrom: 75000,
      salaryTo: 125000,
      currency: "RUR",
      publishedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(v.descriptionText).toContain("Уверенные знания синтаксиса языка Go");
    expect(v.descriptionText).not.toContain("<");
  });

  it("accepts jobLocation as a single object (some pages)", async () => {
    const html = fixture("habr-career-vacancy-1000168365.html").replace(/"jobLocation":\s*\[([\s\S]*?)\]/, '"jobLocation": $1');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })));
    const v = await habr.fetchJob("https://career.habr.com", { externalId: "site:habr-career:1", url: "https://career.habr.com/vacancies/1", title: "Go", company: "X" });
    expect(v.area).toBe("Казань");
  });
});
