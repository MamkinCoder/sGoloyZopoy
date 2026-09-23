import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../../../src/career/ats/sites/bitrix24-1c-bitrix.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const ORIGIN = "https://careers.bitrix24.ru";
const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bitrix24-1c-bitrix ats client", () => {
  it("detects the careers.bitrix24.ru host", () => {
    expect(client.detect(`${ORIGIN}/jobs/`, "")).toEqual({ token: ORIGIN });
    expect(client.detect("https://www.1c-bitrix.ru/company/vacancies/", "")).toBeNull();
    expect(client.detect("https://www.1c-bitrix.ru/company/vacancies/", "see careers.bitrix24.ru/jobs/ for openings")).toEqual({
      token: ORIGIN,
    });
  });

  it("lists jobs by discovering category slugs then reading each category page", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === `${ORIGIN}/jobs/`) return htmlResponse(fixture("bitrix24-1c-bitrix-jobs.html"));
        if (url === `${ORIGIN}/jobs/development/`) return htmlResponse(fixture("bitrix24-1c-bitrix-development.html"));
        if (url === `${ORIGIN}/jobs/marketing/`) return htmlResponse(fixture("bitrix24-1c-bitrix-marketing.html"));
        // customer-service card in the root fixture has no matching page fixture; reuse the empty one
        if (url === `${ORIGIN}/jobs/customer-service/`) return htmlResponse(fixture("bitrix24-1c-bitrix-marketing.html"));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const jobs = await client.listJobs(ORIGIN);

    expect(calls).toEqual([
      `${ORIGIN}/jobs/`,
      `${ORIGIN}/jobs/customer-service/`,
      `${ORIGIN}/jobs/development/`,
      `${ORIGIN}/jobs/marketing/`,
    ]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "site:bitrix24-1c-bitrix:development/ai-backend-engineer",
      url: `${ORIGIN}/jobs/development/ai-backend-engineer/`,
      title: "AI Backend Engineer",
      company: "Bitrix24 / 1C-Bitrix",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:bitrix24-1c-bitrix:development/highload-engineer",
      url: `${ORIGIN}/jobs/development/highload-engineer/`,
      title: "Инженер по оптимизации производительности Senior (SaaS, Highload)",
    });
  });

  it("fetches a job's full text bounded between the fixed heading and footer teaser", async () => {
    const url = `${ORIGIN}/jobs/development/highload-engineer/`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(fixture("bitrix24-1c-bitrix-job.html"))),
    );

    const discovered = {
      externalId: "site:bitrix24-1c-bitrix:development/highload-engineer",
      url,
      title: "placeholder",
      company: "Bitrix24 / 1C-Bitrix",
    };
    const vacancy = await client.fetchJob(ORIGIN, discovered);

    expect(vacancy.title).toBe("Инженер по оптимизации производительности Senior (SaaS, Highload)");
    expect(vacancy.url).toBe(url);
    expect(vacancy.company).toBe("Bitrix24 / 1C-Bitrix");
    expect(vacancy.descriptionText).toContain("высоконагруженный облачный SaaS-сервис");
    expect(vacancy.descriptionText).toContain("Kubernetes и Docker");
    expect(vacancy.descriptionText).not.toContain("Больше вакансий");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.area).toBe("");
  });
});
