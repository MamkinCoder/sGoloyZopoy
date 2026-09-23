import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as itransition } from "../../../src/career/ats/sites/itransition.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("itransition ats client", () => {
  it("detects the Itransition careers site by host or by html", () => {
    expect(itransition.detect("https://www.itransition.com/careers/vacancies", "")).toEqual({ token: "https://www.itransition.com" });
    expect(itransition.detect("https://itransition.com/careers", "")).toEqual({ token: "https://www.itransition.com" });
    expect(itransition.detect("https://example.com/", "")).toBeNull();
    expect(itransition.detect("https://example.com/", 'see itransition.com/careers/foo')).toEqual({ token: "https://www.itransition.com" });
  });

  it("lists open jobs from the vacancies page, skipping non-job cards and duplicates", async () => {
    const listHtml = fixture("itransition-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await itransition.listJobs("https://www.itransition.com");

    expect(calls).toEqual(["https://www.itransition.com/careers/vacancies"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:itransition:ai-agent-developer",
      url: "https://www.itransition.com/careers/ai-agent-developer",
      title: "AI Agent Developer",
      company: "Itransition",
      location: "European Union, Georgia",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:itransition:ruby-on-rails-senior-developer",
      title: "Ruby on Rails Senior Developer",
      location: "Poland",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:itransition:technical-product-owner-tpo-data-engineer",
      title: "Technical Product Owner (TPO) / Data Engineer",
      location: undefined,
    });
  });

  it("fetches a job's full text from the detail page JobPosting JSON-LD", async () => {
    const detailHtml = fixture("itransition-job-ai-agent-developer.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(detailHtml);
      }),
    );

    const discovered = {
      externalId: "site:itransition:ai-agent-developer",
      url: "https://www.itransition.com/careers/ai-agent-developer",
      title: "AI Agent Developer",
      company: "Itransition",
      location: "European Union, Georgia",
    };
    const vacancy = await itransition.fetchJob("https://www.itransition.com", discovered);

    expect(calls).toEqual([discovered.url]);
    expect(vacancy.title).toBe("AI Agent Developer");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Itransition");
    expect(vacancy.area).toBe("European Union, Georgia");
    expect(vacancy.workFormat).toBe("Full time");
    expect(vacancy.descriptionText).toContain("LLM-powered agents");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.publishedAt).toBe(new Date("2026-09-18T15:46:50.414Z").toISOString());
  });
});
