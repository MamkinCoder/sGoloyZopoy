// Minimal in-memory Store + RunService for API tests. Only the behaviour routes rely on is real;
// the rest of the Store interface is implemented as sensible no-ops so it type-checks.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyRunStats,
  type AnalyticsDTO,
  RunBusyError,
  type Application,
  type ApplicationFilter,
  type ApplicationRow,
  type CareerSite,
  type ChatMessage,
  type ChatThread,
  type Config,
  type GeneratedResume,
  type HHResume,
  type InterviewPrep,
  type NewApplication,
  type NewChatMessage,
  type NewRunEvent,
  type Profile,
  type QuestionnaireAnswer,
  type Run,
  type RunEvent,
  type RunRequest,
  type RunService,
  type Stats,
  type Store,
  type User,
  type Vacancy,
} from "@sgz/shared";
import { createApp } from "../../src/api/index.js";
import type { ApiDeps } from "../../src/api/deps.js";

export const PASSWORD = "hunter2";

export function fakeConfig(dataDir: string): Config {
  return {
    dataDir,
    repoDir: dataDir,
    bind: { host: "127.0.0.1", port: 0 },
    panelPassword: PASSWORD,
    panelUrl: "http://localhost:3002",
    tgBotToken: "",
    tgChatId: "",
    chromiumBin: "chromium",
    claudeBin: "claude",
    xelatexBin: "xelatex",
    scheduleAt: "12:00",
    scheduleJitterMin: 20,
    tz: "Europe/Moscow",
    runnerEnabled: true,
    throttleMinMs: 0,
    throttleMaxMs: 0,
    userAgent: "test",
    memoryGuardMB: 450,
  };
}

const nowISO = () => new Date().toISOString();

export class FakeStore implements Store {
  users: User[] = [];
  profiles = new Map<number, Profile>();
  hhResumes: HHResume[] = [];
  vacancies: Vacancy[] = [];
  applications: Application[] = [];
  qa: QuestionnaireAnswer[] = [];
  threads: ChatThread[] = [];
  messages: ChatMessage[] = [];
  generated: GeneratedResume[] = [];
  sites: CareerSite[] = [];
  runs: Run[] = [];
  events: RunEvent[] = [];
  settings = new Map<string, string>();
  private seq = 1;
  private nextId() {
    return this.seq++;
  }

  close() {}

  upsertUser(u: Omit<User, "id"> & { id?: number }): User {
    const existing = this.users.find((x) => x.id === u.id || x.slug === u.slug);
    if (existing) {
      Object.assign(existing, u, { id: existing.id });
      return existing;
    }
    const user: User = { ...u, id: u.id ?? this.nextId() };
    this.users.push(user);
    return user;
  }
  getUserBySlug(slug: string) {
    return this.users.find((u) => u.slug === slug) ?? null;
  }
  listUsers(onlyActive = false) {
    return onlyActive ? this.users.filter((u) => u.active) : [...this.users];
  }
  getProfile(userId: number) {
    return this.profiles.get(userId) ?? null;
  }
  saveProfile(userId: number, p: Profile) {
    this.profiles.set(userId, p);
  }

  upsertHHResume(r: Omit<HHResume, "id"> & { id?: number }): HHResume {
    const res: HHResume = { ...r, id: r.id ?? this.nextId() };
    this.hhResumes.push(res);
    return res;
  }
  listHHResumes(userId: number) {
    return this.hhResumes.filter((r) => r.userId === userId);
  }
  getHHResumeByHHId(hhResumeId: string) {
    return this.hhResumes.find((r) => r.hhResumeId === hhResumeId) ?? null;
  }
  countHHResumesCreatedToday() {
    return 0;
  }

  upsertVacancy(v: Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt"> & { id?: number }): Vacancy {
    const vac: Vacancy = { ...v, id: v.id ?? this.nextId(), firstSeenAt: nowISO(), lastSeenAt: nowISO() };
    this.vacancies.push(vac);
    return vac;
  }
  getVacancy(id: number) {
    return this.vacancies.find((v) => v.id === id) ?? null;
  }
  findVacancyByExternal(source: string, externalId: string) {
    return this.vacancies.find((v) => v.source === source && v.externalId === externalId) ?? null;
  }
  hasRecentApplicationByDedup() {
    return false;
  }
  hasRecentRejection(userId: number, vacancyId: number, sinceISO: string) {
    return this.applications.some((a) => a.userId === userId && a.vacancyId === vacancyId && a.status === "SKIP_LLM_REJECT" && a.createdAt >= sinceISO);
  }
  lastApplication(userId: number, vacancyId: number) {
    return this.applications.filter((a) => a.userId === userId && a.vacancyId === vacancyId).at(-1) ?? null;
  }
  countRecentApplicationsByCompany() {
    return 0;
  }
  companyLockDirection() {
    return "";
  }

  hasSentApplication(userId: number, vacancyId: number) {
    return this.applications.some((a) => a.userId === userId && a.vacancyId === vacancyId && ["SENT", "QUEUED", "SKIP_MANUAL"].includes(a.status));
  }
  insertApplication(a: NewApplication): Application {
    const app: Application = { ...a, id: this.nextId(), attempt: 1, createdAt: nowISO() };
    this.applications.push(app);
    return app;
  }
  private row(a: Application): ApplicationRow {
    const vacancy = this.getVacancy(a.vacancyId)!;
    const resumeTitle = this.hhResumes.find((r) => r.id === a.hhResumeId)?.title ?? "";
    return { application: a, vacancy, resumeTitle };
  }
  getApplication(id: number) {
    const a = this.applications.find((x) => x.id === id);
    return a ? this.row(a) : null;
  }
  updateApplicationStatus(id: number, status: Application["status"], detail: string) {
    const a = this.applications.find((x) => x.id === id);
    if (a) Object.assign(a, { status, reasonDetail: detail });
  }
  updateApplicationCoverLetter(id: number, text: string) {
    const a = this.applications.find((x) => x.id === id);
    if (a) a.coverLetter = text;
  }
  listApplications(f: ApplicationFilter) {
    let rows = this.applications.map((a) => this.row(a));
    if (f.userId !== undefined) rows = rows.filter((r) => r.application.userId === f.userId);
    if (f.runId !== undefined) rows = rows.filter((r) => r.application.runId === f.runId);
    if (f.status) rows = rows.filter((r) => f.status!.includes(r.application.status));
    if (f.source) rows = rows.filter((r) => (f.source === "career" ? r.vacancy.source !== "hh" : r.vacancy.source === f.source));
    if (f.latestPerVacancy) rows = rows.filter((r) => !this.applications.some((b) => b.userId === r.application.userId && b.vacancyId === r.application.vacancyId && b.id > r.application.id));
    if (f.since) rows = rows.filter((r) => r.application.createdAt >= f.since!);
    if (f.until) rows = rows.filter((r) => r.application.createdAt <= f.until!);
    if (f.q) {
      const q = f.q.toLowerCase();
      rows = rows.filter((r) => r.vacancy.title.toLowerCase().includes(q) || r.vacancy.company.toLowerCase().includes(q));
    }
    const total = rows.length;
    const page = f.page ?? 1;
    const size = Math.min(f.pageSize ?? 50, 200);
    return { items: rows.slice((page - 1) * size, page * size), total };
  }
  countSentToday() {
    return 0;
  }
  insertQuestionnaireAnswers(applicationId: number, qs: QuestionnaireAnswer["question"][], as: QuestionnaireAnswer["answer"][]) {
    qs.forEach((q, i) => this.qa.push({ id: this.nextId(), applicationId, question: q, answer: as[i]!, createdAt: nowISO() }));
  }
  listQuestionnaireAnswers(applicationId: number) {
    return this.qa.filter((q) => q.applicationId === applicationId);
  }
  deleteQuestionnaireAnswers(applicationId: number) {
    this.qa = this.qa.filter((q) => q.applicationId !== applicationId);
  }

  upsertChatThread(t: Omit<ChatThread, "id"> & { id?: number }): ChatThread {
    const th: ChatThread = { ...t, id: t.id ?? this.nextId() };
    this.threads.push(th);
    return th;
  }
  listChatThreads(userId: number, state?: string) {
    return this.threads.filter((t) => t.userId === userId && (!state || t.state === state));
  }
  insertChatMessages(threadId: number, msgs: NewChatMessage[]) {
    for (const m of msgs) this.messages.push({ ...m, id: this.nextId(), threadId, createdAt: nowISO() });
    return msgs.length;
  }
  listChatMessages(threadId: number) {
    return this.messages.filter((m) => m.threadId === threadId);
  }
  markAnswered(ids: number[]) {
    for (const m of this.messages) if (ids.includes(m.id)) m.answered = true;
  }
  setChatInterview(threadId: number, atISO: string | null) {
    for (const t of this.threads) if (t.id === threadId) t.interviewAt = atISO;
  }
  setChatPrep(threadId: number, prep: InterviewPrep) {
    for (const t of this.threads) if (t.id === threadId) t.prep = prep;
  }
  claimInterviewReminders(): ChatThread[] {
    return [];
  }

  insertGeneratedResume(g: Omit<GeneratedResume, "id" | "createdAt">): GeneratedResume {
    const gr: GeneratedResume = { ...g, id: this.nextId(), createdAt: nowISO() };
    this.generated.push(gr);
    return gr;
  }
  listGeneratedResumes(userId: number) {
    return this.generated.filter((g) => g.userId === userId);
  }
  getGeneratedResume(id: number) {
    return this.generated.find((g) => g.id === id) ?? null;
  }

  listCareerSites(userId: number, onlyEnabled = false) {
    return this.sites.filter((s) => s.userId === userId && (!onlyEnabled || s.enabled));
  }
  getCareerSite(id: number) {
    return this.sites.find((s) => s.id === id) ?? null;
  }
  upsertCareerSite(c: Omit<CareerSite, "id"> & { id?: number }): CareerSite {
    const existing = this.sites.find((s) => s.id === c.id);
    if (existing) {
      Object.assign(existing, c);
      return existing;
    }
    const site: CareerSite = { ...c, id: c.id ?? this.nextId() };
    this.sites.push(site);
    return site;
  }
  deleteCareerSite(id: number) {
    this.sites = this.sites.filter((s) => s.id !== id);
  }

  insertRun(r: Omit<Run, "id" | "startedAt" | "finishedAt">): Run {
    const run: Run = { ...r, id: this.nextId(), startedAt: nowISO(), finishedAt: null };
    this.runs.push(run);
    return run;
  }
  finishRun(r: Run) {
    const cur = this.runs.find((x) => x.id === r.id);
    if (cur) Object.assign(cur, r);
  }
  getRun(id: number) {
    return this.runs.find((r) => r.id === id) ?? null;
  }
  listRuns(userId: number | null, limit: number) {
    return this.runs.filter((r) => userId === null || r.userId === userId).slice(-limit).reverse();
  }
  reconcileOrphanedRuns() {
    return 0;
  }
  lastRunAt() {
    return null;
  }
  appendRunEvent(e: NewRunEvent): RunEvent {
    const ev: RunEvent = { ...e, id: this.nextId(), ts: nowISO() };
    this.events.push(ev);
    return ev;
  }
  listRunEvents(runId: number, afterId: number) {
    return this.events.filter((e) => e.runId === runId && e.id > afterId);
  }

  userStats(): Stats {
    return { sent: 1, skipped: 2, failed: 0, byStatus: { SENT: 1 }, invitations: 0, rejections: 0, chatReplies: 0, runsCount: 1 };
  }
  userAnalytics(_userId: number, since: string | null): AnalyticsDTO {
    const kpi = Object.fromEntries(
      ["sent", "skipped", "failed", "negotiations", "responded", "invitations", "rejections", "employer_messages", "bot_replies", "needs_human_open",
       "resumes_total", "resumes_generated", "llm_calls", "llm_failed", "llm_prompt_chars", "llm_result_chars", "llm_avg_ms", "runs"].map((k) => [k, 0]),
    ) as Omit<AnalyticsDTO["kpi"], "response_rate">;
    return {
      since,
      kpi: { ...kpi, response_rate: null },
      daily: [], funnel: [], skip_reasons: [], companies: [], sources: [], resumes: [], directions: [],
      reject_reasons: [], work_formats: [], areas: [], llm_tasks: [], recent: [],
    };
  }
  getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }
  setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }
  insertLLMCall() {}
  backup() {}
}

/** subscribe() yields two live events (appended to the store) then marks the run done and ends. */
export class FakeRunner implements RunService {
  started: RunRequest[] = [];
  stopped: number[] = [];
  busy = false;
  activeRun: Run | null = null;
  constructor(private store: FakeStore) {}

  async start(req: RunRequest) {
    if (this.busy) throw new RunBusyError();
    this.started.push(req);
    const user = req.userSlug === "all" ? null : this.store.getUserBySlug(req.userSlug);
    const run = this.store.insertRun({
      userId: user?.id ?? null,
      source: req.source,
      trigger: req.trigger,
      status: "queued",
      stats: emptyRunStats(req.dryRun),
      tgSent: false,
      error: "",
    });
    return run.id;
  }
  async stop(runId: number) {
    this.stopped.push(runId);
  }
  active() {
    return this.activeRun;
  }
  async *subscribe(runId: number): AsyncIterable<RunEvent> {
    for (const message of ["live one", "live two"]) {
      yield this.store.appendRunEvent({ runId, level: "info", stage: "search", message });
    }
    const run = this.store.getRun(runId);
    if (run) this.store.finishRun({ ...run, status: "done", finishedAt: nowISO() });
  }
  async wait(runId: number) {
    return this.store.getRun(runId)!;
  }
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  store: FakeStore;
  runner: FakeRunner;
  cfg: Config;
  deps: ApiDeps;
  /** Cookie header value for an authenticated session. */
  cookie: string;
  get(path: string, init?: RequestInit): Promise<Response>;
  json(method: string, path: string, body?: unknown): Promise<Response>;
}

export async function harness(over: Partial<ApiDeps> = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "sgz-api-"));
  const cfg = fakeConfig(dataDir);
  const store = new FakeStore();
  const runner = new FakeRunner(store);
  store.upsertUser({
    slug: "yaroslav",
    name: "Yaroslav",
    tgChatId: "",
    dailyLimitHH: 25,
    dailyLimitCareer: 10,
    active: true,
    allowOtherCountry: true,
    poolExpandPerDay: 2,
    opusEnabled: false,
  });
  const deps: ApiDeps = { cfg, store, runner, version: "test", log: () => {}, ...over };
  const app = createApp(deps);
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const get = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { cookie, ...(init.headers as Record<string, string> | undefined) } });
  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, store, runner, cfg, deps, cookie, get, json };
}
