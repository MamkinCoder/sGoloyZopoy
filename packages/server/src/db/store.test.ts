import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Status, companyKey, emptyRunStats, normalizeDedup, type NewApplication, type Profile } from "@sgz/shared";
import { defaultProfile } from "../config/profile.js";
import { openStore, seedDefaultUsers, type SqliteStore } from "./index.js";

let store: SqliteStore;
const today = new Date().toISOString().slice(0, 10);
const past = "2000-01-01T00:00:00.000Z";
const day = [`${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`] as const;
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
  direction: "",
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
      expect(names).toEqual(["001_init.sql", "002_hh_resumes_created_at.sql", "003_company_limiter.sql", "004c_chat_interview.sql", "005d_interview_outcome.sql", "006_study.sql", "007a_agent.sql", "007b_kb.sql", "007c_kb_reviews.sql", "008a_skills_learned_to_kb.sql"]);
      expect(a.db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      a.upsertUser(userFixture("x"));
      a.close();
      const b = openStore(path);
      expect(b.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n).toBe(names.length);
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
    expect(store.countSentToday(u.id, "hh", ...day)).toBe(1);
    expect(store.countSentToday(u.id, "acme", ...day)).toBe(1);
    expect(store.countSentToday(u.id, "career", ...day)).toBe(1);
    expect(store.countSentToday(u.id, "hh", past, `${past.slice(0, 10)}T23:59:59.999Z`)).toBe(1);
    // 00:30 in Moscow on Jan 2 is stored as Jan 1 21:30Z: Moscow's Jan 2 bounds still count it
    store.db.prepare("UPDATE applications SET created_at = ? WHERE id = ?").run("2026-01-01T21:30:00.000Z", old.id);
    expect(store.countSentToday(u.id, "hh", "2026-01-01T21:00:00.000Z", "2026-01-02T21:00:00.000Z")).toBe(1);
  });

  it("review queue: QUEUED/SKIP_MANUAL block reprocessing and count as queued today; latestPerVacancy", () => {
    const u = store.upsertUser(userFixture("a"));
    const v1 = store.upsertVacancy(vacancyFixture("https://x.com/j/1", { source: "acme" }));
    const v2 = store.upsertVacancy(vacancyFixture("https://x.com/j/2", { source: "acme" }));
    const q = store.insertApplication(appFixture(u.id, v1.id, { status: Status.QUEUED, coverLetter: "a" }));
    const skip = store.insertApplication(appFixture(u.id, v2.id, { status: Status.SKIP_FILTER }));
    expect(store.hasSentApplication(u.id, v1.id)).toBe(true);
    expect(store.countSentToday(u.id, "career", ...day)).toBe(1);
    store.updateApplicationCoverLetter(q.id, "b");
    store.insertQuestionnaireAnswers(q.id, [{ idx: 0, text: "?", kind: "text", required: false }], [{ idx: 0, text: "!" }]);
    store.deleteQuestionnaireAnswers(q.id);
    expect(store.listQuestionnaireAnswers(q.id)).toEqual([]);
    store.updateApplicationStatus(q.id, Status.SKIP_MANUAL, "skipped");
    expect(store.getApplication(q.id)?.application).toMatchObject({ coverLetter: "b", status: "SKIP_MANUAL" });
    expect(store.hasSentApplication(u.id, v1.id)).toBe(true);
    const filtered = () => store.listApplications({ userId: u.id, status: [Status.SKIP_FILTER], latestPerVacancy: true }).items.map((r) => r.application.id);
    expect(filtered()).toEqual([skip.id]);
    store.insertApplication(appFixture(u.id, v2.id, { status: Status.QUEUED }));
    expect(filtered()).toEqual([]);
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

  it("hasRecentRejection is true only for SKIP_LLM_REJECT on that exact vacancy within the window", () => {
    const u = store.upsertUser(userFixture("a"));
    const v = store.upsertVacancy(vacancyFixture("1"));
    const other = store.upsertVacancy(vacancyFixture("2"));
    expect(store.hasRecentRejection(u.id, v.id, past)).toBe(false);
    store.insertApplication(appFixture(u.id, v.id, { status: Status.SKIP_FILTER }));
    expect(store.hasRecentRejection(u.id, v.id, past)).toBe(false);
    store.insertApplication(appFixture(u.id, v.id, { status: Status.SKIP_LLM_REJECT }));
    expect(store.hasRecentRejection(u.id, v.id, past)).toBe(true);
    expect(store.hasRecentRejection(u.id, v.id, future)).toBe(false);
    expect(store.hasRecentRejection(u.id, other.id, past)).toBe(false);
  });

  it("company limiter counts SENT across sources, respects the window, and locks the first direction", () => {
    const u = store.upsertUser(userFixture("a"));
    const hhVacancy = store.upsertVacancy(vacancyFixture("1", { company: "Ozon" }));
    const careerVacancy = store.upsertVacancy(vacancyFixture("https://ozon.tech/jobs/2", { source: "ozon-tech", company: "ООО «Озон Технологии»" }));
    expect(companyKey(hhVacancy.company)).toBe(companyKey(careerVacancy.company));
    const key = companyKey(hhVacancy.company);
    expect(store.countRecentApplicationsByCompany(u.id, key, past)).toBe(0);
    expect(store.companyLockDirection(u.id, key, past)).toBe("");

    store.insertApplication(appFixture(u.id, hhVacancy.id, { status: Status.SKIP_LLM_REJECT, direction: "go-backend" }));
    expect(store.countRecentApplicationsByCompany(u.id, key, past)).toBe(0); // not SENT, doesn't count

    store.insertApplication(appFixture(u.id, hhVacancy.id, { direction: "go-backend" }));
    expect(store.countRecentApplicationsByCompany(u.id, key, past)).toBe(1);
    expect(store.companyLockDirection(u.id, key, past)).toBe("go-backend");

    // A second SENT application from the other source, after the first, still cross-source counts
    // but does not change the locked direction (first SENT wins).
    store.insertApplication(appFixture(u.id, careerVacancy.id, { direction: "node-backend" }));
    expect(store.countRecentApplicationsByCompany(u.id, key, past)).toBe(2);
    expect(store.companyLockDirection(u.id, key, past)).toBe("go-backend");

    // Window expiry: a `since` after both sends sees nothing.
    expect(store.countRecentApplicationsByCompany(u.id, key, future)).toBe(0);
    expect(store.companyLockDirection(u.id, key, future)).toBe("");
    expect(store.countRecentApplicationsByCompany(u.id, "", past)).toBe(0);
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
  it("interview time: reminder claimed once, re-armed only by a new time; prep round-trips", () => {
    const u = store.upsertUser(userFixture("a"));
    const t = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: null, employer: "Acme", state: "invited", lastSeenAt: "" });
    expect(t.interviewAt).toBeNull();
    const now = "2026-09-25T10:00:00.000Z";
    const until = "2026-09-25T12:00:00.000Z";
    store.setChatInterview(t.id, "2026-09-25T11:00:00.000Z");
    expect(store.claimInterviewReminders("2026-09-25T08:00:00.000Z", "2026-09-25T10:00:00.000Z")).toHaveLength(0); // not yet
    expect(store.claimInterviewReminders(now, until).map((x) => x.id)).toEqual([t.id]);
    expect(store.claimInterviewReminders(now, until)).toHaveLength(0); // once
    store.setChatInterview(t.id, "2026-09-25T11:00:00.000Z"); // same time from a later reply
    expect(store.claimInterviewReminders(now, until)).toHaveLength(0);
    store.setChatInterview(t.id, "2026-09-25T11:30:00.000Z"); // moved
    expect(store.claimInterviewReminders(now, until)).toHaveLength(1);
    // a regular upsert (chat poll) keeps the captured time
    const again = store.upsertChatThread({ ...t, state: "needs_human" });
    expect(again.interviewAt).toBe("2026-09-25T11:30:00.000Z");
    store.setChatInterview(t.id, null);
    expect(store.listChatThreads(u.id)[0]!.interviewAt).toBeNull();

    const prep = { questions: ["Q"], stories: [{ skill: "Go", prompt: "p" }], gaps: [], ask_them: ["A"] };
    store.setChatPrep(t.id, prep);
    expect(store.listChatThreads(u.id)[0]!.prep).toEqual(prep);
  });

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
    // the bot's reply read back from hh with an id is the same message, not a new one
    expect(store.insertChatMessages(t.id, [{ hhMessageId: "m9", direction: "out", author: "me", text: "A1 ", isQuestion: false, answered: false }])).toBe(0);
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

  it("closes orphaned running/queued runs and reports the last done", () => {
    const base = { userId: null, source: "all", trigger: "schedule", stats: emptyRunStats(), tgSent: false, error: "" } as const;
    const running = store.insertRun({ ...base, status: "running" });
    const queued = store.insertRun({ ...base, status: "queued" });
    const done = store.insertRun({ ...base, status: "running" });
    expect(store.lastRunAt("done")).toBeNull();
    store.finishRun({ ...done, status: "done", finishedAt: past });
    expect(store.reconcileOrphanedRuns(future)).toBe(2);
    for (const id of [running.id, queued.id]) expect(store.getRun(id)).toMatchObject({ status: "stopped", finishedAt: future, error: "orphaned by restart" });
    expect(store.getRun(done.id)?.status).toBe("done");
    expect(store.reconcileOrphanedRuns(future)).toBe(0);
    expect(store.lastRunAt("done")).toBe(past);
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
      { hhMessageId: "h-1", direction: "out", author: "me", text: "history", isQuestion: false, answered: false },
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

  it("userAnalytics: kpis, daily, funnel, breakdowns, bot replies exclude hh history", () => {
    const u = store.upsertUser(userFixture("a"));
    const other = store.upsertUser(userFixture("b"));
    const res = store.upsertHHResume({ userId: u.id, hhResumeId: "r1", title: "Go dev", url: "u", direction: "go", summary: null, isGenerated: true, syncedAt: "" });
    const v1 = store.upsertVacancy(vacancyFixture("1", { company: "Acme" }));
    const v2 = store.upsertVacancy(vacancyFixture("2", { company: "Acme", workFormat: "office" }));
    const v3 = store.upsertVacancy(vacancyFixture("3", { company: "Beta" }));
    const decision = (apply: boolean, reason = "ok") => ({
      vacancy_id: 0, apply, reason, resume_id: "r1", cover_letter: "", direction: "go", seniority: "middle", red_flags: [],
    });
    store.insertApplication(appFixture(u.id, v1.id, { hhResumeId: res.id, direction: "go", llmDecision: decision(true) }));
    store.insertApplication(appFixture(u.id, v2.id, { hhResumeId: res.id, llmDecision: decision(true) }));
    store.insertApplication(appFixture(u.id, v3.id, { status: Status.SKIP_LLM_REJECT, reasonDetail: "Требуется Senior с опытом 6 лет", llmDecision: decision(false) }));
    store.insertApplication(appFixture(u.id, v3.id, { status: Status.FAILED_UI }));
    store.insertApplication(appFixture(other.id, v3.id)); // other user: ignored
    const run = store.insertRun({ userId: u.id, source: "hh", trigger: "cli", status: "done", stats: { ...emptyRunStats(), found: 9 }, tgSent: false, error: "" });
    store.insertLLMCall({ runId: run.id, task: "decide_hh", model: "m", promptChars: 100, resultChars: 10, durationMs: 200, ok: true, error: "", attempt: 1 });
    store.insertLLMCall({ runId: run.id, task: "decide_hh", model: "m", promptChars: 50, resultChars: 0, durationMs: 400, ok: false, error: "x", attempt: 2 });
    store.insertLLMCall({ runId: null, task: "decide_hh", model: "m", promptChars: 1, resultChars: 1, durationMs: 1, ok: true, error: "", attempt: 1 });
    const t1 = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: v1.id, employer: "Acme", state: "invited", lastSeenAt: "" });
    store.setInterviewOutcome(t1.id, "next");
    store.upsertChatThread({ userId: u.id, hhNegotiationId: "n2", isBot: false, vacancyId: v2.id, employer: "Acme", state: "viewed", lastSeenAt: "" });
    store.upsertChatThread({ userId: u.id, hhNegotiationId: "n3", isBot: false, vacancyId: null, employer: "C", state: "needs_human", lastSeenAt: "" });
    store.insertChatMessages(t1.id, [
      { hhMessageId: "m1", direction: "in", author: "employer", text: "Привет", isQuestion: true, answered: true },
      { hhMessageId: "m2", direction: "out", author: "me", text: "old reply from history", isQuestion: false, answered: false },
      { hhMessageId: null, direction: "out", author: "bot", text: "bot reply", isQuestion: false, answered: false },
    ]);

    const a = store.userAnalytics(u.id, null);
    expect(a.kpi).toMatchObject({
      sent: 2, skipped: 1, failed: 1, negotiations: 3, responded: 2, response_rate: 1, invitations: 1, rejections: 0,
      employer_messages: 1, bot_replies: 1, needs_human_open: 1, resumes_total: 1, resumes_generated: 1,
      llm_calls: 2, llm_failed: 1, llm_prompt_chars: 150, llm_result_chars: 10, llm_avg_ms: 300, runs: 1,
    });
    expect(a.daily).toEqual([{ day: today, sent: 2, skipped: 1, failed: 1, msgs_in: 1, bot_out: 1, llm_calls: 2 }]);
    expect(a.funnel.map((f) => [f.key, f.n])).toEqual([["found", 9], ["decided", 3], ["approved", 2], ["sent", 2], ["viewed", 2], ["invited", 1], ["passed", 1], ["offer", 0]]);
    expect(a.salary).toBeNull(); // 2 postings < min-N
    expect(a.skip_reasons).toEqual([{ key: "SKIP_LLM_REJECT", n: 1 }]);
    expect(a.reject_reasons).toEqual([{ key: "уровень / опыт", n: 1 }]);
    expect(a.companies).toEqual([{ key: "Acme", n: 2, hh: 2, resp: 2, inv: 1, pass: 1 }]);
    expect(a.sources).toEqual([{ key: "hh", n: 2, hh: 2, resp: 2, inv: 1, pass: 1 }]);
    expect(a.resumes).toEqual([{ key: "Go dev", n: 2, hh: 2, resp: 2, inv: 1, pass: 1 }]);
    expect(a.directions).toEqual([{ key: "go", n: 2, hh: 2, resp: 2, inv: 1, pass: 1 }]);
    expect(a.work_formats).toEqual([{ key: "office", n: 1 }, { key: "remote", n: 1 }]);
    expect(a.llm_tasks).toEqual([{ key: "decide_hh", n: 2 }]);
    expect(a.recent.map((e) => e.kind).sort()).toEqual(["bot", "employer", "sent", "sent"]);

    const none = store.userAnalytics(u.id, future);
    expect(none.kpi.sent).toBe(0);
    expect(none.kpi.response_rate).toBeNull();
    expect(none.recent).toEqual([]);
    const week = store.userAnalytics(u.id, new Date(Date.now() - 6 * 864e5).toISOString());
    expect(week.daily).toHaveLength(7);
    expect(week.daily.at(-1)?.sent).toBe(2);
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

  it("userAnalytics: career sends count toward n but not the hh conversion denominator", () => {
    const u = store.upsertUser(userFixture("a"));
    const hv = store.upsertVacancy(vacancyFixture("1"));
    const cv = store.upsertVacancy(vacancyFixture("https://acme.io/j/1", { source: "acme" }));
    store.insertApplication(appFixture(u.id, hv.id, { direction: "go" }));
    store.insertApplication(appFixture(u.id, cv.id, { direction: "go" }));
    store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: hv.id, employer: "X", state: "rejected", lastSeenAt: "" });
    const a = store.userAnalytics(u.id, null);
    expect(a.directions).toEqual([{ key: "go", n: 2, hh: 1, resp: 1, inv: 0, pass: 0 }]);
    expect(a.sources).toContainEqual({ key: "career · acme", n: 1, hh: 0, resp: 0, inv: 0, pass: 0 });
  });

  it("careerSiteYield: distinct vacancies per career source, queued = QUEUED/SENT, hh and old rows excluded", () => {
    const u = store.upsertUser(userFixture("a"));
    const v1 = store.upsertVacancy(vacancyFixture("https://acme.io/j/1", { source: "acme" }));
    const v2 = store.upsertVacancy(vacancyFixture("https://acme.io/j/2", { source: "acme" }));
    const v3 = store.upsertVacancy(vacancyFixture("https://beta.io/j/1", { source: "beta" }));
    const hv = store.upsertVacancy(vacancyFixture("9"));
    store.insertApplication(appFixture(u.id, v1.id, { status: Status.SKIP_LLM_REJECT }));
    store.insertApplication(appFixture(u.id, v1.id, { status: Status.QUEUED }));
    store.insertApplication(appFixture(u.id, v2.id, { status: Status.SKIP_FILTER }));
    store.insertApplication(appFixture(u.id, v3.id, { status: Status.SENT }));
    store.insertApplication(appFixture(u.id, hv.id));
    expect(store.careerSiteYield(u.id, past)).toEqual({ acme: { found: 2, queued: 1 }, beta: { found: 1, queued: 1 } });
    expect(store.careerSiteYield(u.id, future)).toEqual({});
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
