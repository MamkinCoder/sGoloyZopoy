import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as usergate } from "../../../src/career/ats/sites/usergate.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usergate ats client", () => {
  it("detects the UserGate careers path", () => {
    expect(usergate.detect("https://usergate.com/company/career", "")).toEqual({ token: "https://usergate.com" });
    expect(usergate.detect("https://usergate.com/ru/career", "")).toBeNull();
    expect(usergate.detect("https://example.com/", "calls usergate.com/api/v1/vacancies/all")).toEqual({ token: "https://usergate.com" });
    expect(usergate.detect("https://example.com/company/career", "")).toBeNull();
  });

  it("lists all open jobs from the public vacancies API", async () => {
    const listJson = fixture("usergate-vacancies-all.json");
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(listJson);
      }),
    );

    const jobs = await usergate.listJobs("https://usergate.com");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://usergate.com/api/v1/vacancies/all");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:usergate:131443955",
      url: "https://hh.ru/vacancy/131443955",
      title: "Golang-разработчик в команду VPN",
      company: "UserGate",
      location: "Санкт-Петербург",
    });
    expect(jobs[2]).toMatchObject({ externalId: "site:usergate:134914388", title: "Senior DevOps Engineer" });
  });

  it("fetches a job's full text from the vacancy detail endpoint", async () => {
    const detailJson = fixture("usergate-vacancy-131443955.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:usergate:131443955",
      url: "https://hh.ru/vacancy/131443955",
      title: "Golang-разработчик в команду VPN",
      company: "UserGate",
      location: "Санкт-Петербург",
    };
    const vacancy = await usergate.fetchJob("https://usergate.com", discovered);

    expect(calls).toEqual(["https://usergate.com/api/v1/vacancies/detail/131443955"]);
    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("UserGate");
    expect(vacancy.area).toBe("Санкт-Петербург");
    expect(vacancy.workFormat).toBe("Полная");
    expect(vacancy.descriptionText).toContain("разработка и поддержка серверной части VPN на Go");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
  });
});
