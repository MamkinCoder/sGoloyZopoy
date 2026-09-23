// A company's own careers site brands every vacancy with the site name; a job board keeps each employer.
import { describe, expect, it } from "vitest";
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
