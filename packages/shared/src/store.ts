// Persistence contract (SQLite via node:sqlite). Workstream A implements; everyone else calls.
import type {
  Answer,
  Application,
  CareerSite,
  ChatMessage,
  ChatThread,
  GeneratedResume,
  HHResume,
  InterviewOutcome,
  InterviewPrep,
  StudyPack,
  Profile,
  Question,
  QuestionnaireAnswer,
  Run,
  SalaryBand,
  RunEvent,
  RunStatus,
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
/** createdAt: hh's send time when known; the insert time otherwise. */
export type NewChatMessage = Omit<ChatMessage, "id" | "threadId" | "createdAt"> & { createdAt?: string };

/** Reply history of one employer (SENT applications of one user); see Store.companyIntel. */
export interface CompanyIntel {
  name: string;
  sent: number;
  /** An employer message arrived, or the thread reached invited / rejected. */
  replied: number;
  invited: number;
  rejected: number;
  /** Median hours from the send to the first employer message; null without replies. */
  medianReplyH: number | null;
}

/** Conversion of one pool resume over SENT hh applications; see Store.resumeStats. */
export interface ResumeStat {
  hhResumeId: string;
  title: string;
  sent: number;
  resp: number;
  inv: number;
}

/** A sent cover letter and how it ended: invited, or not (rejected / silent for 14+ days). */
export interface LetterOutcome {
  title: string;
  letter: string;
  invited: boolean;
}

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
  /** With `from`, only a row still in that status changes (a human may have skipped / marked it meanwhile). True when a row changed. */
  updateApplicationStatus(id: number, status: Status, detail: string, from?: Status): boolean;
  updateApplicationCoverLetter(id: number, text: string): void;
  /** created_at = now: a filter skip seen again stays on the Filtered page (listed by the newest row's created_at). */
  touchApplication(id: number): void;
  listApplications(f: ApplicationFilter): { items: ApplicationRow[]; total: number };
  /** SENT + QUEUED + SKIP_MANUAL created in [sinceISO, untilISO) (the local day's UTC bounds): for career sites the daily limit counts queued items. */
  countSentToday(userId: number, source: Source, sinceISO: string, untilISO: string): number;
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
  /** Sets (null clears) the interview time; a changed time re-arms its reminder. */
  setChatInterview(threadId: number, atISO: string | null): void;
  setChatPrep(threadId: number, prep: InterviewPrep): void;
  setChatStudy(threadId: number, study: StudyPack): void;
  /** Threads with an interview in (now, until] not reminded yet; marks them reminded. */
  claimInterviewReminders(nowISO: string, untilISO: string): ChatThread[];
  /** Threads whose interview was in [fromISO, toISO] with no outcome and never asked; marks them asked. */
  claimOutcomeAsks(fromISO: string, toISO: string): ChatThread[];
  setInterviewOutcome(threadId: number, outcome: InterviewOutcome | null): void;

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
  /** Closes runs left running/queued by a crashed process; returns how many. Call before the runner exists. */
  reconcileOrphanedRuns(finishedAt: string): number;
  /** finished_at of the latest run with this status, or null. */
  lastRunAt(status: RunStatus): string | null;
  appendRunEvent(e: NewRunEvent): RunEvent;
  listRunEvents(runId: number, afterId: number): RunEvent[];

  // stats / settings / llm
  userStats(userId: number, sinceISO: string | null): Stats;
  userAnalytics(userId: number, sinceISO: string | null): AnalyticsDTO;
  /** Per company key (vacancies.company_key) among `keys`; companies without SENT rows are absent. */
  companyIntel(userId: number, keys: string[]): Record<string, CompanyIntel>;
  /** Per pool resume, SENT hh applications since `sinceISO`, most used first. */
  resumeStats(userId: number, sinceISO: string): ResumeStat[];
  /** SENT hh letters with a known outcome (invited, rejected, or silent for 14+ days), newest first. */
  letterOutcomes(userId: number, limit: number): LetterOutcome[];
  /** RUB band over vacancies seen in the last `days` (default 90); null below the min-N gate. */
  salaryBand(q: SalaryQuery): SalaryBand | null;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  insertLLMCall(c: LLMCall): void;
  backup(destPath: string): void;
}

export interface SalaryQuery {
  /** Only vacancies this user has an application row for (any status). */
  userId?: number;
  /** CV direction of those applications; needs userId. */
  direction?: string;
  /** Case-insensitive substring of the vacancy title. */
  titleLike?: string;
  days?: number;
}
