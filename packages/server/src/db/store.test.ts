import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Status, emptyRunStats, normalizeDedup, type NewApplication, type Profile } from "@sgz/shared";
import { defaultProfile } from "../config/profile.js";
import { openStore, seedDefaultUsers, type SqliteStore } from "./index.js";

let store: SqliteStore;
const today = new Date().toISOString().slice(0, 10);
const past = "2000-01-01T00:00:00.000Z";
const future = "2999-01-01T00:00:00.000Z";

const userFixture = (slug: string) => ({
  slug,
  name: slug.toUpperCase(),
  tgChatId: "",
  dailyLimitHH: 25,
  dailyLimitCareer: 10,
  active: true,
  allowOtherCountry: true,
  poolExpandPerDay: 2,
  opusEnabled: false,
});

const vacancyFixture = (externalId: string, over: Partial<Parameters<SqliteStore["upsertVacancy"]>[0]> = {}) => ({
  source: "hh",
  externalId,
  url: `https://hh.ru/vacancy/${externalId}`,
  title: "Go разработчик",
  company: "ООО Рога и Копыта",
  salaryFrom: 100000,
  salaryTo: 200000,
  currency: "RUR",
  descriptionText: "",
  hasTest: false,
  requiresLetter: true,
  area: "Москва",
  workFormat: "remote",
  publishedAt: null,
  archived: false,
  dedupHash: "",
  ...over,
});

const appFixture = (userId: number, vacancyId: number, over: Partial<NewApplication> = {}): NewApplication => ({
  userId,
  vacancyId,
  hhResumeId: null,
  generatedResumeId: null,
  runId: 0,
  status: Status.SENT,
  reasonDetail: "",
  coverLetter: "Здравствуйте.",
  llmDecision: null,
  ...over,
});

beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("migrations", () => {
  it("are idempotent on a file db and enable WAL", () => {
    const dir = mkdtempSync(join(tmpdir(), "sgz-db-"));
    const path = join(dir, "nested", "sgz.db");
    try {
      const a = openStore(path);
      const names = a.db
        .prepare("SELECT name FROM schema_migrations ORDER BY name")
        .all()
        .map((r) => r.name);
      expect(names).toEqual(["001_init.sql", "002_hh_resumes_created_at.sql"]);
      expect(a.db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      a.upsertUser(userFixture("x"));
      a.close();
      const b = openStore(path);
      expect(b.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n).toBe(2);
      expect(b.listUsers()).toHaveLength(1);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("users + profile", () => {
  it("seedDefaultUsers creates two users once", () => {
    expect(seedDefaultUsers(store).map((u) => u.slug)).toEqual(["yaroslav", "alina"]);
    expect(seedDefaultUsers(store)).toEqual([]);
    expect(store.getUserBySlug("alina")?.name).toBe("Алина");
    expect(store.listUsers()).toHaveLength(2);
  });

  it("upserts by slug and by id, filters active", () => {
    const u = store.upsertUser(userFixture("a"));
    const again = store.upsertUser({ ...userFixture("a"), name: "renamed", active: false });
    expect(again.id).toBe(u.id);
    expect(again.name).toBe("renamed");
    expect(store.listUsers(true)).toHaveLength(0);
    const byId = store.upsertUser({ ...userFixture("a"), id: u.id, slug: "b", active: true, opusEnabled: true });
    expect(byId).toMatchObject({ id: u.id, slug: "b", opusEnabled: true, active: true });
    expect(store.getUserBySlug("a")).toBeNull();
  });

  it("profile roundtrip with defaults filled", () => {
    const u = store.upsertUser(userFixture("a"));
    expect(store.getProfile(u.id)).toBeNull();
    const p: Profile = { ...defaultProfile(), full_name: "Тест", verified_skills: ["Go"], extra: { x: "y" } };
    store.saveProfile(u.id, p);
    expect(store.getProfile(u.id)).toEqual(p);
    store.saveProfile(u.id, { ...p, full_name: "Два" });
    expect(store.getProfile(u.id)?.full_name).toBe("Два");
  });
});

describe("vacancies", () => {
  it("upsert keeps id/first_seen_at, bumps last_seen_at, computes dedup hash, keeps description", () => {
    const v1 = store.upsertVacancy(vacancyFixture("1", { descriptionText: "full text" }));
    expect(v1.dedupHash).toBe(normalizeDedup("ООО Рога и Копыта", "Go разработчик"));
    expect(v1.firstSeenAt).toBe(v1.lastSeenAt);
    store.db.prepare("UPDATE vacancies SET first_seen_at = ?, last_seen_at = ? WHERE id = ?").run(past, past, v1.id);
    const v2 = store.upsertVacancy(vacancyFixture("1", { title: "Golang dev", salaryFrom: 150000 }));
    expect(v2.id).toBe(v1.id);
    expect(v2.firstSeenAt).toBe(past);
    expect(v2.lastSeenAt > past).toBe(true);
    expect(v2.title).toBe("Golang dev");
    expect(v2.descriptionText).toBe("full text");
    expect(v2.dedupHash).toBe(normalizeDedup("ООО Рога и Копыта", "Golang dev"));
    expect(store.getVacancy(v1.id)?.salaryFrom).toBe(150000);
    expect(store.findVacancyByExternal("hh", "1")?.id).toBe(v1.id);
    expect(store.findVacancyByExternal("hh", "nope")).toBeNull();
    const byId = store.upsertVacancy({ ...vacancyFixture("1"), id: v1.id, archived: true });
    expect(byId.archived).toBe(true);
  });
});

describe("applications", () => {
  it("numbers attempts and rejects a second SENT", () => {
    const u = store.upsertUser(userFixture("a"));
    const v = store.upsertVacancy(vacancyFixture("1"));
    const a1 = store.insertApplication(appFixture(u.id, v.id, { status: Status.FAILED_UI, reasonDetail: "x" }));
    const a2 = store.insertApplication(appFixture(u.id, v.id, { llmDecision: { vacancy_id: v.id, apply: true, reason: "ok", resume_id: "r", cover_letter: "c", direction: "go", seniority: "middle", red_flags: [] } }));
    expect([a1.attempt, a2.attempt]).toEqual([1, 2]);
    expect(a2.llmDecision?.reason).toBe("ok");
    expect(a1.llmDecision).toBeNull();
    expect(store.hasSentApplication(u.id, v.id)).toBe(true);
    expect(() => store.insertApplication(appFixture(u.id, v.id))).toThrow(/UNIQUE/);
    // failed attempts may keep piling up
    expect(store.insertApplication(appFixture(u.id, v.id, { status: Status.FAILED_LLM })).attempt).toBe(3);
    const row = store.getApplication(a2.id);
    expect(row?.vacancy.id).toBe(v.id);
    expect(row?.resumeTitle).toBe("");
    store.updateApplicationStatus(a1.id, Status.SKIP_DRY_RUN, "d");
    expect(store.getApplication(a1.id)?.application).toMatchObject({ status: "SKIP_DRY_RUN", reasonDetail: "d" });
  });

  it("hasSentApplication is false for other users / non-SENT", () => {
    const u = store.upsertUser(userFixture("a"));
    const u2 = store.upsertUser(userFixture("b"));
    const v = store.upsertVacancy(vacancyFixture("1"));
    store.insertApplication(appFixture(u.id, v.id, { status: Status.SKIP_LLM_REJECT }));
    expect(store.hasSentApplication(u.id, v.id)).toBe(false);
    store.insertApplication(appFixture(u.id, v.id));
    expect(store.hasSentApplication(u2.id, v.id)).toBe(false);
  });

  it("countSentToday per source, with career as any non-hh", () => {
    const u = store.upsertUser(userFixture("a"));
    const hh1 = store.upsertVacancy(vacancyFixture("1"));
    const hh2 = store.upsertVacancy(vacancyFixture("2"));
    const site = store.upsertVacancy(vacancyFixture("https://x.com/j/1", { source: "acme" }));
    store.insertApplication(appFixture(u.id, hh1.id));
    store.insertApplication(appFixture(u.id, hh2.id, { status: Status.FAILED_UI }));
    const old = store.insertApplication(appFixture(u.id, hh2.id));
    store.db.prepare("UPDATE applications SET created_at = ? WHERE id = ?").run(past, old.id);
    store.insertApplication(appFixture(u.id, site.id));
    expect(store.countSentToday(u.id, "hh", today)).toBe(1);
    expect(store.countSentToday(u.id, "hh", `${today}T12:00:00Z`)).toBe(1);
    expect(store.countSentToday(u.id, "acme", today)).toBe(1);
    expect(store.countSentToday(u.id, "career", today)).toBe(1);
    expect(store.countSentToday(u.id, "hh", "2000-01-01")).toBe(1);
  });

  it("dedup window uses SENT applications since a date", () => {
    const u = store.upsertUser(userFixture("a"));
    const v = store.upsertVacancy(vacancyFixture("1"));
    const twin = store.upsertVacancy(vacancyFixture("https://x.com/j/2", { source: "acme", company: "Рога и Копыта" }));
    expect(twin.dedupHash).toBe(v.dedupHash);
    expect(store.hasRecentApplicationByDedup(u.id, v.dedupHash, past)).toBe(false);
    store.insertApplication(appFixture(u.id, v.id, { status: Status.SKIP_FILTER }));
    expect(store.hasRecentApplicationByDedup(u.id, v.dedupHash, past)).toBe(false);
    store.insertApplication(appFixture(u.id, v.id));
    expect(store.hasRecentApplicationByDedup(u.id, twin.dedupHash, past)).toBe(true);
    expect(store.hasRecentApplicationByDedup(u.id, twin.dedupHash, future)).toBe(false);
    expect(store.hasRecentApplicationByDedup(u.id, "", past)).toBe(false);
  });

  it("listApplications filters and paginates", () => {
    const u = store.upsertUser(userFixture("a"));
    const u2 = store.upsertUser(userFixture("b"));
    const r = store.upsertHHResume({ userId: u.id, hhResumeId: "abc", title: "Go dev", url: "u", direction: "go", summary: null, isGenerated: false, syncedAt: "" });
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      const v = store.upsertVacancy(vacancyFixture(String(i), { title: i % 2 ? "React dev" : "Go dev", source: i === 6 ? "acme" : "hh" }));
      ids.push(store.insertApplication(appFixture(u.id, v.id, { runId: i < 3 ? 1 : 2, hhResumeId: r.id, status: i === 5 ? Status.SKIP_LIMIT : Status.SENT })).id);
    }
    store.insertApplication(appFixture(u2.id, store.upsertVacancy(vacancyFixture("99")).id));
    expect(store.listApplications({}).total).toBe(8);
    expect(store.listApplications({ userId: u.id }).total).toBe(7);
    expect(store.listApplications({ userId: u.id, runId: 1 }).total).toBe(3);
    expect(store.listApplications({ status: [Status.SKIP_LIMIT] }).items.map((x) => x.application.id)).toEqual([ids[5]]);
    expect(store.listApplications({ source: "acme" }).total).toBe(1);
    expect(store.listApplications({ source: "career" }).total).toBe(1);
    expect(store.listApplications({ source: "hh" }).total).toBe(7);
    expect(store.listApplications({ q: "React" }).total).toBe(3);
    expect(store.listApplications({ q: "Рога" }).total).toBe(8);
    expect(store.listApplications({ since: future }).total).toBe(0);
    expect(store.listApplications({ until: past }).total).toBe(0);
    expect(store.listApplications({ since: past, until: future }).total).toBe(8);
    const p1 = store.listApplications({ pageSize: 3 });
    const p2 = store.listApplications({ pageSize: 3, page: 2 });
    const p3 = store.listApplications({ pageSize: 3, page: 3 });
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([3, 3, 2]);
    expect(p1.total).toBe(8);
    expect(p1.items[0]?.application.id).toBeGreaterThan(p1.items[2]?.application.id ?? 0);
    expect(p1.items[0]?.resumeTitle).toBe("");
    expect(p3.items[1]?.resumeTitle).toBe("Go dev");
    expect(store.listApplications({ pageSize: 9999 }).items.length).toBe(8);
  });

  it("questionnaire answers roundtrip", () => {
    const u = store.upsertUser(userFixture("a"));
    const v = store.upsertVacancy(vacancyFixture("1"));
    const a = store.insertApplication(appFixture(u.id, v.id));
    store.insertQuestionnaireAnswers(
      a.id,
      [
        { idx: 0, text: "Гражданство?", kind: "radio", options: ["РФ", "другое"], required: true },
        { idx: 1, text: "Опыт?", kind: "text", required: false },
      ],
      [
        { idx: 1, text: "2.5 года" },
        { idx: 0, option_idx: 0 },
      ],
    );
    const qa = store.listQuestionnaireAnswers(a.id);
    expect(qa).toHaveLength(2);
    expect(qa[0]?.question.text).toBe("Гражданство?");
    expect(qa[0]?.answer).toEqual({ idx: 0, option_idx: 0 });
    expect(qa[1]?.answer.text).toBe("2.5 года");
  });
});

describe("hh resumes", () => {
  it("upserts by hh id and counts generated ones created today", () => {
    const u = store.upsertUser(userFixture("a"));
    const r1 = store.upsertHHResume({ userId: u.id, hhResumeId: "h1", title: "Go", url: "u", direction: "go", summary: { direction: "go", seniority: "middle", key_skills: ["Go"], one_line: "x" }, isGenerated: false, syncedAt: "" });
    expect(r1.summary?.key_skills).toEqual(["Go"]);
    expect(r1.syncedAt).not.toBe("");
    const r1b = store.upsertHHResume({ userId: u.id, hhResumeId: "h1", title: "Go v2", url: "u", direction: "go", summary: null, isGenerated: false, syncedAt: "2026-01-01T00:00:00.000Z" });
    expect(r1b.id).toBe(r1.id);
    expect(r1b.title).toBe("Go v2");
    expect(r1b.summary?.direction).toBe("go");
    expect(r1b.syncedAt).toBe("2026-01-01T00:00:00.000Z");
    store.upsertHHResume({ userId: u.id, hhResumeId: "g1", title: "gen", url: "u", direction: "react", summary: null, isGenerated: true, syncedAt: "" });
    const g2 = store.upsertHHResume({ userId: u.id, hhResumeId: "g2", title: "gen2", url: "u", direction: "vue", summary: null, isGenerated: true, syncedAt: "" });
    store.db.prepare("UPDATE hh_resumes SET created_at = ? WHERE id = ?").run(past, g2.id);
    expect(store.countHHResumesCreatedToday(u.id, today)).toBe(1);
    expect(store.listHHResumes(u.id)).toHaveLength(3);
    expect(store.getHHResumeByHHId("g2")?.isGenerated).toBe(true);
    expect(store.getHHResumeByHHId("none")).toBeNull();
  });

  it("generated resumes", () => {
    const u = store.upsertUser(userFixture("a"));
    const v = store.upsertVacancy(vacancyFixture("1"));
    const g = store.insertGeneratedResume({ userId: u.id, vacancyId: v.id, texPath: "/t/cv-acme.tex", pdfPath: "", model: "opus" });
    expect(store.getGeneratedResume(g.id)).toEqual(g);
    expect(store.listGeneratedResumes(u.id)).toEqual([g]);
    const a = store.insertApplication(appFixture(u.id, v.id, { generatedResumeId: g.id }));
    expect(store.getApplication(a.id)?.resumeTitle).toBe("cv-acme");
  });
});

describe("chats", () => {
  it("thread upsert and message dedup via hh id and via text", () => {
    const u = store.upsertUser(userFixture("a"));
    const t = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: true, vacancyId: null, employer: "Acme", state: "new", lastSeenAt: "" });
    const t2 = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: true, vacancyId: null, employer: "", state: "invited", lastSeenAt: "" });
    expect(t2.id).toBe(t.id);
    expect(t2.employer).toBe("Acme");
    expect(t2.state).toBe("invited");
    expect(store.listChatThreads(u.id, "invited")).toHaveLength(1);
    expect(store.listChatThreads(u.id, "new")).toHaveLength(0);
    expect(store.listChatThreads(u.id)).toHaveLength(1);

    const n = store.insertChatMessages(t.id, [
      { hhMessageId: "m1", direction: "in", author: "bot", text: "Q1?", isQuestion: true, answered: false },
      { hhMessageId: "m1", direction: "in", author: "bot", text: "Q1 dup", isQuestion: true, answered: false },
      { hhMessageId: null, direction: "out", author: "me", text: "A1", isQuestion: false, answered: false },
      { hhMessageId: null, direction: "out", author: "me", text: "A1", isQuestion: false, answered: false },
      { hhMessageId: null, direction: "in", author: "employer", text: "A1", isQuestion: false, answered: false },
    ]);
    expect(n).toBe(3);
    expect(store.insertChatMessages(t.id, [{ hhMessageId: "m1", direction: "in", author: "bot", text: "x", isQuestion: false, answered: false }])).toBe(0);
    const msgs = store.listChatMessages(t.id);
    expect(msgs.map((m) => m.text)).toEqual(["Q1?", "A1", "A1"]);
    expect(msgs[0]?.hhMessageId).toBe("m1");
    expect(msgs[1]?.hhMessageId).toBeNull();
    store.markAnswered([msgs[0]?.id ?? 0]);
    store.markAnswered([]);
    expect(store.listChatMessages(t.id)[0]?.answered).toBe(true);
  });
});

describe("runs", () => {
  it("insert/finish/list and event pagination by afterId", () => {
    const u = store.upsertUser(userFixture("a"));
    const r = store.insertRun({ userId: u.id, source: "hh", trigger: "cli", status: "running", stats: emptyRunStats(true), tgSent: false, error: "" });
    expect(r.startedAt).not.toBe("");
    expect(r.finishedAt).toBeNull();
    expect(r.stats.dry_run).toBe(true);
    const e1 = store.appendRunEvent({ runId: r.id, level: "info", stage: "search", message: "found", data: { n: 3 } });
    const e2 = store.appendRunEvent({ runId: r.id, level: "warn", stage: "apply", message: "slow" });
    expect(e1.data).toEqual({ n: 3 });
    expect(e2.data).toBeUndefined();
    expect(store.listRunEvents(r.id, 0).map((e) => e.id)).toEqual([e1.id, e2.id]);
    expect(store.listRunEvents(r.id, e1.id).map((e) => e.id)).toEqual([e2.id]);
    expect(store.listRunEvents(r.id, e2.id)).toEqual([]);
    store.finishRun({ ...r, status: "done", finishedAt: null, stats: { ...r.stats, found: 3 }, tgSent: true });
    const done = store.getRun(r.id);
    expect(done?.status).toBe("done");
    expect(done?.finishedAt).not.toBeNull();
    expect(done?.stats.found).toBe(3);
    expect(done?.tgSent).toBe(true);
    store.insertRun({ userId: null, source: "all", trigger: "schedule", status: "queued", stats: emptyRunStats(), tgSent: false, error: "" });
    expect(store.listRuns(null, 10)).toHaveLength(2);
    expect(store.listRuns(u.id, 10)).toHaveLength(1);
    expect(store.listRuns(null, 1)).toHaveLength(1);
    expect(store.getRun(999)).toBeNull();
  });
});

describe("stats / settings / llm / career / backup", () => {
  it("userStats aggregates with and without since", () => {
    const u = store.upsertUser(userFixture("a"));
    const v1 = store.upsertVacancy(vacancyFixture("1"));
    const v2 = store.upsertVacancy(vacancyFixture("2"));
    store.insertApplication(appFixture(u.id, v1.id));
    store.insertApplication(appFixture(u.id, v2.id, { status: Status.SKIP_LLM_REJECT }));
    store.insertApplication(appFixture(u.id, v2.id, { status: Status.FAILED_UI }));
    store.insertApplication(appFixture(u.id, v2.id, { status: Status.NEEDS_HUMAN }));
    store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: v1.id, employer: "A", state: "invited", lastSeenAt: "" });
    const t = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n2", isBot: true, vacancyId: null, employer: "B", state: "rejected", lastSeenAt: "" });
    store.insertChatMessages(t.id, [
      { hhMessageId: null, direction: "in", author: "bot", text: "q", isQuestion: true, answered: true },
      { hhMessageId: null, direction: "out", author: "me", text: "a", isQuestion: false, answered: false },
    ]);
    store.insertRun({ userId: u.id, source: "hh", trigger: "cli", status: "done", stats: emptyRunStats(), tgSent: false, error: "" });
    const s = store.userStats(u.id, null);
    expect(s).toEqual({
      sent: 1,
      skipped: 1,
      failed: 1,
      byStatus: { SENT: 1, SKIP_LLM_REJECT: 1, FAILED_UI: 1, NEEDS_HUMAN: 1 },
      invitations: 1,
      rejections: 1,
      chatReplies: 1,
      runsCount: 1,
    });
    expect(store.userStats(u.id, future)).toEqual({ sent: 0, skipped: 0, failed: 0, byStatus: {}, invitations: 0, rejections: 0, chatReplies: 0, runsCount: 0 });
    expect(store.userStats(u.id, past).sent).toBe(1);
  });

  it("settings", () => {
    expect(store.getSetting("k")).toBeNull();
    store.setSetting("k", "v1");
    store.setSetting("k", "v2");
    expect(store.getSetting("k")).toBe("v2");
  });

  it("llm call insert", () => {
    store.insertLLMCall({ runId: null, task: "decide_hh", model: "sonnet", promptChars: 10, resultChars: 5, durationMs: 100, ok: true, error: "", attempt: 1 });
    store.insertLLMCall({ runId: 7, task: "chat", model: "opus", promptChars: 1, resultChars: 0, durationMs: 5, ok: false, error: "boom", attempt: 2 });
    const rows = store.db.prepare("SELECT run_id, ok, error FROM llm_calls ORDER BY id").all();
    expect(rows).toEqual([
      { run_id: null, ok: 1, error: "" },
      { run_id: 7, ok: 0, error: "boom" },
    ]);
  });

  it("career site profile roundtrip", () => {
    const u = store.upsertUser(userFixture("a"));
    const c = store.upsertCareerSite({ userId: u.id, slug: "acme", name: "Acme", baseUrl: "https://acme.io", ats: "greenhouse", profile: { ats_board_token: "acme", filters: ["go"] }, enabled: true, lastRunAt: null });
    expect(c.profile).toEqual({ ats_board_token: "acme", filters: ["go"] });
    const c2 = store.upsertCareerSite({ userId: u.id, slug: "acme", name: "Acme Inc", baseUrl: "https://acme.io", ats: "greenhouse", profile: { ...c.profile, apply_hints: "click apply" }, enabled: false, lastRunAt: "2026-01-01T00:00:00.000Z" });
    expect(c2.id).toBe(c.id);
    expect(c2.profile.apply_hints).toBe("click apply");
    expect(store.listCareerSites(u.id, true)).toHaveLength(0);
    expect(store.listCareerSites(u.id)).toHaveLength(1);
    const c3 = store.upsertCareerSite({ ...c2, enabled: true });
    expect(store.getCareerSite(c3.id)?.enabled).toBe(true);
    store.deleteCareerSite(c.id);
    expect(store.getCareerSite(c.id)).toBeNull();
  });

  it("backup writes a file with the data", () => {
    const dir = mkdtempSync(join(tmpdir(), "sgz-bak-"));
    try {
      store.setSetting("k", "v");
      const dest = join(dir, "sub", "backup.db");
      store.backup(dest);
      expect(existsSync(dest)).toBe(true);
      expect(statSync(dest).size).toBeGreaterThan(0);
      const copy = openStore(dest);
      expect(copy.getSetting("k")).toBe("v");
      copy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
