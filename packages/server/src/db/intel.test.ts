import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Status, companyKey } from "@sgz/shared";
import { formatIntel } from "./intel.js";
import { openStore, type SqliteStore } from "./index.js";

let store: SqliteStore;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

const user = () =>
  store.upsertUser({ slug: "a", name: "A", tgChatId: "", dailyLimitHH: 25, dailyLimitCareer: 10, active: true, allowOtherCountry: true, poolExpandPerDay: 2, opusEnabled: false });

let n = 0;
/** One SENT hh application `hoursAgo` old; optional thread state and first employer reply `replyH` after the send. */
function sent(userId: number, company: string, o: { hoursAgo?: number; state?: string; replyH?: number; letter?: string; resumeId?: number | null; source?: string } = {}) {
  const v = store.upsertVacancy({
    source: o.source ?? "hh", externalId: String(++n), url: `u${n}`, title: `Go ${n}`, company, salaryFrom: 0, salaryTo: 0, currency: "",
    descriptionText: "", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "",
  });
  const at = new Date(Date.now() - (o.hoursAgo ?? 1) * 3600_000);
  const a = store.insertApplication({
    userId, vacancyId: v.id, hhResumeId: o.resumeId ?? null, generatedResumeId: null, runId: 0, status: Status.SENT, reasonDetail: "", direction: "", coverLetter: o.letter ?? "Привет!", llmDecision: null,
  });
  store.db.prepare("UPDATE applications SET created_at = ? WHERE id = ?").run(at.toISOString(), a.id);
  if (o.state) {
    const t = store.upsertChatThread({ userId, hhNegotiationId: `n${n}`, isBot: false, vacancyId: v.id, employer: company, state: o.state as never, lastSeenAt: "" });
    if (o.replyH !== undefined)
      store.insertChatMessages(t.id, [{ hhMessageId: `m${n}`, direction: "in", author: "employer", text: "Здравствуйте", isQuestion: false, answered: false, createdAt: new Date(at.getTime() + o.replyH * 3600_000).toISOString() }]);
  }
}

describe("companyIntel", () => {
  it("counts sends, replies, invites and the median reply time per company key", () => {
    const u = user();
    sent(u.id, "ООО Точка", { hoursAgo: 100, state: "invited", replyH: 2 });
    sent(u.id, "Точка", { hoursAgo: 100, state: "rejected", replyH: 10 });
    sent(u.id, "Точка", { hoursAgo: 100, state: "viewed", replyH: 6 });
    sent(u.id, "Точка", { hoursAgo: 100 });
    sent(u.id, "Ozon", { hoursAgo: 5 });
    const key = companyKey("Точка");
    const intel = store.companyIntel(u.id, [key, companyKey("Ozon"), companyKey("Nobody"), ""]);
    expect(intel[key]).toMatchObject({ sent: 4, replied: 3, invited: 1, rejected: 1, medianReplyH: 6 });
    expect(intel[companyKey("Ozon")]).toMatchObject({ sent: 1, replied: 0, medianReplyH: null });
    expect(intel[companyKey("Nobody")]).toBeUndefined();
    expect(formatIntel(intel[key]!)).toMatch(/: 4 отклика, 1 приглашение, 1 отказ, отвечают ~6ч$/);
    expect(formatIntel(intel[companyKey("Ozon")]!)).toBe("Ozon: 1 отклик, 0 ответов");
  });
});

describe("resumeStats / letterOutcomes", () => {
  it("per-resume conversion since a date", () => {
    const u = user();
    const r = store.upsertHHResume({ userId: u.id, hhResumeId: "h1", title: "Go dev", url: "u", direction: "go", summary: null, isGenerated: false, syncedAt: "" });
    sent(u.id, "A", { resumeId: r.id, state: "invited" });
    sent(u.id, "B", { resumeId: r.id, state: "viewed" });
    sent(u.id, "C", { resumeId: r.id, hoursAgo: 24 * 40 }); // before the window
    sent(u.id, "D"); // no resume: career-style send
    expect(store.resumeStats(u.id, new Date(Date.now() - 30 * 864e5).toISOString())).toEqual([{ hhResumeId: "h1", title: "Go dev", sent: 2, resp: 2, inv: 1 }]);
  });

  it("known outcomes only: invited, rejected, or silent 14+ days; hh only", () => {
    const u = user();
    sent(u.id, "A", { state: "invited", letter: "inv" });
    sent(u.id, "B", { state: "rejected", letter: "rej" });
    sent(u.id, "C", { hoursAgo: 24 * 20, letter: "silent" });
    sent(u.id, "D", { letter: "fresh" }); // too fresh to call silent
    sent(u.id, "E", { hoursAgo: 24 * 20, letter: "career", source: "acme" });
    sent(u.id, "F", { state: "invited", letter: "" });
    const out = store.letterOutcomes(u.id, 50);
    expect(out.map((o) => [o.letter, o.invited]).sort()).toEqual([["inv", true], ["rej", false], ["silent", false]]);
  });
});
