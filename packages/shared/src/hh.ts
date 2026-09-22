// hh.ru automation contract. Workstream C implements on top of BrowserSession (act/extract),
// with deterministic fast paths where hh markup is stable ([data-qa=...]) and the InitialState JSON
// (<template id="HH-Lux-InitialState">) for reading page data.
import type { BrowserSession } from "./browser.js";
import type { Answer, ChatMessage, ChatThread, HHResume, Question, Status, Vacancy } from "./model.js";

export interface SearchParams {
  query: string;
  period?: number; // days, default 1
  page?: number; // 0-based
  itemsOnPage?: number; // default 50
  area?: string;
  excludeWords?: string[];
}

export interface Card {
  externalId: string;
  url: string;
  title: string;
  company: string;
  salaryRaw: string;
}

export interface ApplyRequest {
  vacancy: Vacancy;
  resumeTitle: string; // resume is chosen by title in the modal
  coverLetter: string;
  allowOtherCountry: boolean;
  dryRun: boolean;
  /** Called when a questionnaire appears; must return one Answer per Question. */
  answerQuestions: (qs: Question[]) => Promise<Answer[]>;
}

export interface ApplyResult {
  status: Status;
  reasonDetail: string;
  snapshotPath?: string;
  questions?: Question[];
  answers?: Answer[];
}

export interface ThreadDetail {
  thread: Omit<ChatThread, "id" | "userId">;
  vacancyExternalId: string | null;
  messages: Omit<ChatMessage, "id" | "threadId" | "createdAt">[];
  survey: Question[]; // non-empty if a chat-bot survey widget is present
}

export interface ResumeEdit {
  title: string;
  about: string;
  keySkills: string[];
}

export interface HHClient {
  /** True if the session is authenticated (e.g. /applicant/resumes loads without redirect to login). */
  checkLogin(s: BrowserSession): Promise<boolean>;
  /** Throws RunAbortError(FAILED_CAPTCHA | FAILED_ANTI_BOT | FAILED_LOGIN_EXPIRED) if the page shows a block. */
  assertNotBlocked(s: BrowserSession): Promise<void>;

  search(s: BrowserSession, p: SearchParams): Promise<Card[]>; // [] when page empty
  fetchVacancy(s: BrowserSession, c: Card): Promise<{ vacancy: Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt">; alreadyApplied: boolean }>;
  apply(s: BrowserSession, req: ApplyRequest): Promise<ApplyResult>;

  syncResumes(s: BrowserSession): Promise<Omit<HHResume, "id" | "userId" | "summary" | "direction" | "isGenerated">[]>;
  resumeText(s: BrowserSession, resumeUrl: string): Promise<string>;
  resumeCapacity(s: BrowserSession): Promise<{ created: number; max: number }>;
  duplicateResume(s: BrowserSession, baseResumeId: string, edit: ResumeEdit): Promise<string>; // new hh id
  touchResume(s: BrowserSession, resumeUrl: string): Promise<void>; // «Поднять в поиске»; no-op if unavailable

  listThreads(s: BrowserSession, onlyUnread: boolean): Promise<{ negotiationId: string; chatUrl: string; unread: boolean; employer: string; state: string; vacancyExternalId: string | null }[]>;
  readThread(s: BrowserSession, chatUrl: string): Promise<ThreadDetail>;
  sendMessage(s: BrowserSession, chatUrl: string, text: string): Promise<void>;
  submitSurvey(s: BrowserSession, chatUrl: string, answers: Answer[]): Promise<void>;
}

/** Records every step of the real flows (html+png+url+state.json) for offline debugging. */
export interface HHRecorder {
  recordVacancyFlow(s: BrowserSession, vacancyUrl: string, outDir: string): Promise<void>;
  recordNegotiations(s: BrowserSession, negotiationId: string | null, outDir: string): Promise<void>;
  recordResumes(s: BrowserSession, outDir: string): Promise<void>;
}
