// Persistence contract (SQLite via node:sqlite). Workstream A implements; everyone else calls.
import type {
  Answer,
  Application,
  CareerSite,
  ChatMessage,
  ChatThread,
  GeneratedResume,
  HHResume,
  Profile,
  Question,
  QuestionnaireAnswer,
  Run,
  RunEvent,
  Source,
  Status,
  User,
  Vacancy,
} from "./model.js";
import type { AnalyticsDTO } from "./api.js";

export interface ApplicationFilter {
  userId?: number;
  runId?: number;
  status?: Status[];
  source?: Source;
  since?: string; // ISO
  until?: string;
  q?: string; // title/company substring
  /** Only the newest row of each (user, vacancy): e.g. a filtered vacancy later sent/queued drops out. */
  latestPerVacancy?: boolean;
  page?: number; // 1-based
  pageSize?: number; // default 50, max 200
}

export interface ApplicationRow {
  application: Application;
  vacancy: Vacancy;
  resumeTitle: string;
}

export interface Stats {
  sent: number;
  skipped: number;
  failed: number;
  byStatus: Partial<Record<Status, number>>;
  invitations: number;
  rejections: number;
  chatReplies: number;
  runsCount: number;
}

export interface LLMCall {
  runId: number | null;
  task: string;
  model: string;
  promptChars: number;
  resultChars: number;
  durationMs: number;
  ok: boolean;
  error: string;
  attempt: number;
}

/** Insert shapes: id/createdAt assigned by the store. */
export type NewApplication = Omit<Application, "id" | "attempt" | "createdAt">;
export type NewRunEvent = Omit<RunEvent, "id" | "ts">;
export type NewChatMessage = Omit<ChatMessage, "id" | "threadId" | "createdAt">;

export interface Store {
  close(): void;

  // users
  upsertUser(u: Omit<User, "id"> & { id?: number }): User;
  getUserBySlug(slug: string): User | null;
  listUsers(onlyActive?: boolean): User[];
  getProfile(userId: number): Profile | null;
  saveProfile(userId: number, p: Profile): void;

  // hh resumes
  upsertHHResume(r: Omit<HHResume, "id"> & { id?: number }): HHResume;
  listHHResumes(userId: number): HHResume[];
  getHHResumeByHHId(hhResumeId: string): HHResume | null;
  countHHResumesCreatedToday(userId: number, dayISO: string): number;

  // vacancies
  /** Keeps first_seen_at, updates last_seen_at + mutable fields; computes dedupHash if empty. */
  upsertVacancy(v: Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt"> & { id?: number }): Vacancy;
  getVacancy(id: number): Vacancy | null;
  findVacancyByExternal(source: Source, externalId: string): Vacancy | null;
  hasRecentApplicationByDedup(userId: number, dedupHash: string, sinceISO: string): boolean;

  // per-company spam limiter (cross-source: hh + career)
  /** Count of SENT applications to `companyKey` since `sinceISO`, across all sources. */
  countRecentApplicationsByCompany(userId: number, companyKey: string, sinceISO: string): number;
  /** CV direction of the earliest SENT application to `companyKey` since `sinceISO`, or "" if none/unknown. */
  companyLockDirection(userId: number, companyKey: string, sinceISO: string): string;

  // applications (one row per attempt; unique SENT per user+vacancy)
  /** True when the vacancy is SENT, QUEUED for review or skipped by a human: never process it again. */
  hasSentApplication(userId: number, vacancyId: number): boolean;
  /** True when the LLM already rejected this exact vacancy (SKIP_LLM_REJECT) since sinceISO. */
  hasRecentRejection(userId: number, vacancyId: number, sinceISO: string): boolean;
  /** Newest application row of this user for this vacancy, any status. */
  lastApplication(userId: number, vacancyId: number): Application | null;
  insertApplication(a: NewApplication): Application;
  getApplication(id: number): ApplicationRow | null;
  updateApplicationStatus(id: number, status: Status, detail: string): void;
  updateApplicationCoverLetter(id: number, text: string): void;
  listApplications(f: ApplicationFilter): { items: ApplicationRow[]; total: number };
  /** SENT + QUEUED + SKIP_MANUAL created that day: for career sites the daily limit counts queued items. */
  countSentToday(userId: number, source: Source, dayISO: string): number;
  insertQuestionnaireAnswers(applicationId: number, qs: Question[], as: Answer[]): void;
  listQuestionnaireAnswers(applicationId: number): QuestionnaireAnswer[];
  deleteQuestionnaireAnswers(applicationId: number): void;

  // chats
  upsertChatThread(t: Omit<ChatThread, "id"> & { id?: number }): ChatThread;
  listChatThreads(userId: number, state?: string): ChatThread[];
  /** Dedup by hhMessageId when present, else by (thread, direction, text). Returns inserted count. */
  insertChatMessages(threadId: number, msgs: NewChatMessage[]): number;
  listChatMessages(threadId: number): ChatMessage[];
  markAnswered(messageIds: number[]): void;

  // generated resumes
  insertGeneratedResume(g: Omit<GeneratedResume, "id" | "createdAt">): GeneratedResume;
  listGeneratedResumes(userId: number): GeneratedResume[];
  getGeneratedResume(id: number): GeneratedResume | null;

  // career sites
  listCareerSites(userId: number, onlyEnabled?: boolean): CareerSite[];
  getCareerSite(id: number): CareerSite | null;
  upsertCareerSite(c: Omit<CareerSite, "id"> & { id?: number }): CareerSite;
  deleteCareerSite(id: number): void;
  /** Per site slug since `sinceISO`: vacancies that got an application row (`found`) and how many reached
   * QUEUED/SENT (`queued`). Feeds the autopilot's rotation order. */
  careerSiteYield(userId: number, sinceISO: string): Record<string, { found: number; queued: number }>;

  // runs
  insertRun(r: Omit<Run, "id" | "startedAt" | "finishedAt">): Run;
  finishRun(r: Run): void;
  getRun(id: number): Run | null;
  listRuns(userId: number | null, limit: number): Run[];
  appendRunEvent(e: NewRunEvent): RunEvent;
  listRunEvents(runId: number, afterId: number): RunEvent[];

  // stats / settings / llm
  userStats(userId: number, sinceISO: string | null): Stats;
  userAnalytics(userId: number, sinceISO: string | null): AnalyticsDTO;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  insertLLMCall(c: LLMCall): void;
  backup(destPath: string): void;
}
