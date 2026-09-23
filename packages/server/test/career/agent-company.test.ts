// A company's own careers site brands every vacancy with the site name; a job board keeps each employer.
import { describe, expect, it, vi } from "vitest";
import type { CareerSite, LLMClient } from "@sgz/shared";
import { createCareerAgent } from "../../src/career/agent.js";
import type { ATSClientImpl } from "../../src/career/ats/types.js";

const fake = (kind: string, aggregator: boolean): ATSClientImpl =>
  ({
    kind,
    aggregator,
    verified: true,
    notes: "",
    jobsUrl: () => "",
    detect: () => null,
    listJobs: async () => [{ externalId: "1", url: "https://x/1", title: "Go-разработчик", company: "BGStaff" }],
    fetchJob: async (_t: string, d: { externalId: string; url: string; title: string }) => ({ source: kind, externalId: d.externalId, url: d.url, title: d.title, company: "BGStaff", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "Go", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "" }),
  }) as unknown as ATSClientImpl;
const site = (ats: string) => ({ id: 1, userId: 1, slug: ats, name: "Habr Career", baseUrl: "https://x", ats, profile: { ats_board_token: "t" }, enabled: true, lastRunAt: null }) as unknown as CareerSite;

describe("career agent apply", () => {
  const req = (ats: string) => ({ site: { ...site(ats), profile: { ats_board_token: "t", apply_mode: "ats_api" } }, vacancy: {}, profile: {}, resumePdfPath: "", coverLetter: "", dryRun: false, answerQuestions: async () => [] }) as never;

  it("an ATS apply that throws (maybe after the POST) is not retried through the browser", async () => {
    const client = { ...fake("greenhouse", false), apply: async () => { throw new Error("socket hang up"); } } as unknown as ATSClientImpl;
    const agent = createCareerAgent({} as LLMClient, { clients: [client] });
    const goto = vi.fn();
    const r = await agent.apply({ goto } as never, req("greenhouse"));
    expect(r).toMatchObject({ status: "FAILED_NO_CONFIRMATION", reasonDetail: expect.stringContaining("socket hang up") });
    expect(goto).not.toHaveBeenCalled();
  });

  it("a job board without apply() never drives the browser into its login wall", async () => {
    const agent = createCareerAgent({} as LLMClient, { clients: [fake("site:x", true)] });
    const goto = vi.fn();
    expect((await agent.apply({ goto } as never, req("site:x"))).status).toBe("FAILED_UI");
    expect(goto).not.toHaveBeenCalled();
  });
});

describe("career agent company naming", () => {
  it("keeps the employer for aggregators, uses the site name for company sites", async () => {
    for (const [agg, want] of [[true, "BGStaff"], [false, "Habr Career"]] as const) {
      const agent = createCareerAgent({} as LLMClient, { clients: [fake("site:x", agg)] });
      const [d] = await agent.discover(null, site("site:x"), ["go"]);
      expect(d!.company).toBe(want);
      expect((await agent.fetch(null, site("site:x"), d!)).company).toBe(want);
    }
  });
});
