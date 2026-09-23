import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as gazpromNeft } from "../../../src/career/ats/sites/gazprom-neft.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const ORIGIN = "https://career.gazprom-neft.ru";
const LIST_API = `${ORIGIN}/api2/v1/vacancies/list/`;

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

function mockListApi(bySpec: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(LIST_API);
      const body = JSON.parse(String(init?.body ?? "{}")) as { spec?: string[] };
      const spec = body.spec?.[0] ?? "";
      const fixtureName = bySpec[spec];
      if (!fixtureName) throw new Error(`unexpected spec: ${spec}`);
      return jsonResponse(fixture(fixtureName));
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("gazprom-neft ATS client", () => {
  it("detects by host", () => {
    expect(gazpromNeft.detect(`${ORIGIN}/vacancies/`, "")).toEqual({ token: ORIGIN });
    expect(gazpromNeft.detect("https://example.com/", "")).toBeNull();
  });

  it("detects by page content when the host differs", () => {
    expect(gazpromNeft.detect("https://example.com/", "fetch('https://career.gazprom-neft.ru/vacancies/')")).toEqual({
      token: ORIGIN,
    });
  });

  it("lists jobs across IT subcategories, deduped", async () => {
    mockListApi({
      "213": "gazprom-neft-list-spec213-page1.json",
      "208": "gazprom-neft-list-spec208-page1.json",
      "207": "gazprom-neft-list-empty.json",
      "209": "gazprom-neft-list-empty.json",
      "210": "gazprom-neft-list-empty.json",
      "211": "gazprom-neft-list-empty.json",
      "212": "gazprom-neft-list-empty.json",
      "214": "gazprom-neft-list-empty.json",
      "215": "gazprom-neft-list-empty.json",
      "216": "gazprom-neft-list-empty.json",
      "217": "gazprom-neft-list-empty.json",
      "218": "gazprom-neft-list-empty.json",
    });

    const jobs = await gazpromNeft.listJobs(ORIGIN);

    expect(jobs).toHaveLength(3);
    const python = jobs.find((j) => j.externalId === "site:gazprom-neft:8426");
    expect(python).toMatchObject({
      url: `${ORIGIN}/vacancies/razrabotchik-python-10639/`,
      title: "Разработчик Python",
      company: "Gazprom Neft",
      location: "Москва",
    });
    const digital = jobs.find((j) => j.externalId === "site:gazprom-neft:8452");
    expect(digital?.location).toBe("Санкт-Петербург");
  });

  it("fetches a job's full text from the JobPosting JSON-LD", async () => {
    const url = `${ORIGIN}/vacancies/razrabotchik-python-10639/`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        expect(u).toBe(url);
        return htmlResponse(fixture("gazprom-neft-vacancy-razrabotchik-python.html"));
      }),
    );

    const v = await gazpromNeft.fetchJob(ORIGIN, {
      externalId: "site:gazprom-neft:8426",
      url,
      title: "Разработчик Python",
      company: "Gazprom Neft",
    });

    expect(v.title).toBe("Разработчик Python");
    expect(v.company).toBe("Gazprom Neft");
    expect(v.area).toBe("Москва");
    expect(v.workFormat).toBe("Постоянный трудовой договор");
    expect(v.descriptionText).toContain("Python");
    expect(v.descriptionText).toContain("PostgreSQL, Docker, Kubernetes");
    expect(v.descriptionText).not.toContain("<");
    expect(v.descriptionText).not.toContain("&lt;");
    expect(v.publishedAt).toBe("2026-09-18T07:00:00.000Z");
    expect(v.salaryFrom).toBe(0);
  });
});
