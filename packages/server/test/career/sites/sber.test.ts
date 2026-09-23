import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as sber } from "../../../src/career/ats/sites/sber.js";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/sites/${name}`, import.meta.url)), "utf8");

const page1 = fixture("sber-publications-page1.json");
const page2 = fixture("sber-publications-page2.json");

afterEach(() => vi.unstubAllGlobals());

describe("sber ATS client", () => {
  it("detects by host", () => {
    expect(sber.detect("https://rabota.sber.ru/", "")).toEqual({ token: "rabota.sber.ru" });
    expect(sber.detect("https://rabota.sber.ru/search", "")).toEqual({ token: "rabota.sber.ru" });
    expect(sber.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs from the publications API, paginating until total is reached", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const skip = new URL(url.toString()).searchParams.get("skip");
      const body = skip === "0" ? page1 : page2;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await sber.listJobs("rabota.sber.ru");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/public/app-candidate-public-api-gateway/api/v1/publications?skip=0&take=100");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("skip=2");

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:sber:4568319",
      url: "https://rabota.sber.ru/search/4568319/",
      title: "Backend Developer",
      company: "Sber",
    });
    expect(jobs[1]?.location).toBe("г Москва");
    expect(jobs[2]?.title).toContain("DA Lead");
  });

  it("fetches job detail from the cached listJobs payload, no extra request", async () => {
    const fetchMock = vi.fn(async () => new Response(page1, { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const [job] = await sber.listJobs("rabota.sber.ru");
    fetchMock.mockClear();

    const v = await sber.fetchJob("rabota.sber.ru", job!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.source).toBe("site:sber");
    expect(v.company).toBe("Sber");
    expect(v.title).toBe("Backend Developer");
    expect(v.descriptionText).toContain("Обязанности");
    expect(v.descriptionText).toContain("PostgreSQL, Redis, MongoDB");
    expect(v.area).toBe("г Казань");
    expect(v.workFormat).toBe("Полный день");
    expect(v.salaryFrom).toBe(0);
  });

  it("reports salary when present", async () => {
    const fetchMock = vi.fn(async () => new Response(page2, { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const [job] = await sber.listJobs("rabota.sber.ru");
    const v = await sber.fetchJob("rabota.sber.ru", job!);
    expect(v.salaryTo).toBe(700000);
    expect(v.currency).toBe("RUB");
  });
});
