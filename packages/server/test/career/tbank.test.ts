import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tbank } from "../../src/career/ats/tbank.js";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");

const listResponse = fixture("tbank-get-vacancies.json");
const descriptionResponse = fixture("tbank-get-vacancy-description.json");

describe("tbank ATS client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      const body = url.toString().endsWith("/getVacancyDescription") ? descriptionResponse : listResponse;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects tbank career pages by host+path", () => {
    expect(tbank.detect("https://www.tbank.ru/career/it/about/", "")).toEqual({ token: "it" });
    expect(tbank.detect("https://www.tbank.ru/career/vacancies/it/", "")).toEqual({ token: "it" });
    expect(tbank.detect("https://example.com/jobs", "")).toBeNull();
  });

  it("lists jobs from the getVacancies endpoint, stopping when isFinished", async () => {
    const jobs = await tbank.listJobs("it");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://www.tbank.ru/pfpjobs/papi/getVacancies");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.filters.generatedGraphQL.or).toEqual([{ category: "tcareer_it" }]);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "tbank:7ff59d6a-4032-49a7-9b45-45628da7bfa6",
      url: "https://www.tbank.ru/career/it/vacancy/saint-petersburg/starshij-ml-inzhener/7ff59d6a-4032-49a7-9b45-45628da7bfa6/",
      title: "Старший ML-инженер",
      company: "T-Bank",
    });
    expect(jobs[1].location).toBe("Москва");
  });

  it("fetches a full vacancy via getVacancyDescription", async () => {
    const jobs = await tbank.listJobs("it");
    const job = await tbank.fetchJob("it", jobs[0]!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ urlSlug: "7ff59d6a-4032-49a7-9b45-45628da7bfa6", options: { category: "tcareer_it" } });

    expect(job.source).toBe("tbank");
    expect(job.title).toBe("Старший ML-инженер");
    expect(job.company).toBe("T-Bank");
    expect(job.descriptionText).toContain("Мы развиваем LLM Platform");
    expect(job.descriptionText).toContain("Опыт работы ML-разработчиком от 4 лет");
    expect(job.workFormat).toBe("Удаленный");
  });
});
