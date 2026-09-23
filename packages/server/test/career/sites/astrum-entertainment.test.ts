import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as astrum } from "../../../src/career/ats/sites/astrum-entertainment.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(dir, "..", "fixtures", "sites", name), "utf8");

const ORIGIN = "https://astrum-entertainment.ru";

function mockFetch(routes: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.redirect === "manual") {
        // bot-challenge warm-up: seed the one-time cookie, as the live site does on a fresh visit.
        return new Response("", { status: 307, headers: { "set-cookie": "bp_chl=test; Path=/" } });
      }
      const body = routes[url];
      if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("astrum-entertainment ATS client", () => {
  it("detects by host", () => {
    expect(astrum.detect(`${ORIGIN}/careers`, "")).toEqual({ token: ORIGIN });
    expect(astrum.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs from the __NUXT__ payload on the careers page", async () => {
    mockFetch({ [`${ORIGIN}/careers`]: fixture("astrum-entertainment-careers.html") });
    const jobs = await astrum.listJobs(ORIGIN);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:astrum-entertainment:4309044",
      url: `${ORIGIN}/careers/4309044`,
      title: "Python разработчик",
      company: "Astrum Entertainment",
    });
    expect(jobs.map((j) => j.externalId)).toEqual([
      "site:astrum-entertainment:4309044",
      "site:astrum-entertainment:4309040",
      "site:astrum-entertainment:4313344",
    ]);
  });

  it("fetches job detail from the __NUXT__ payload on the vacancy page", async () => {
    const url = `${ORIGIN}/careers/4309044`;
    mockFetch({ [url]: fixture("astrum-entertainment-job-4309044.html") });
    const v = await astrum.fetchJob(ORIGIN, {
      externalId: "site:astrum-entertainment:4309044",
      url,
      title: "Python разработчик",
      company: "Astrum Entertainment",
    });
    expect(v.title).toBe("Python разработчик");
    expect(v.company).toBe("Astrum Entertainment");
    expect(v.descriptionText).toContain("Уверенное знание Python");
    expect(v.descriptionText).toContain("Расширенный ДМС");
    expect(v.descriptionText).not.toContain("<strong>");
    expect(v.salaryFrom).toBe(0);
  });
});
