// Shared domain types. FROZEN contract: every package codes against these.
// No runtime deps here — plain TypeScript types + a few pure helpers.

export type Source = "hh" | string; // "hh" or a career-site slug

export const Status = {
  SENT: "SENT",
  SKIP_ALREADY_APPLIED: "SKIP_ALREADY_APPLIED", // hh shows «Вы откликнулись»
  SKIP_TEST_REQUIRED: "SKIP_TEST_REQUIRED", // vacancy requires a test; we don't do those
  SKIP_LLM_REJECT: "SKIP_LLM_REJECT", // decide said apply=false
  SKIP_DEDUP: "SKIP_DEDUP", // same company+title applied recently
  SKIP_LIMIT: "SKIP_LIMIT", // daily limit reached
  SKIP_DRY_RUN: "SKIP_DRY_RUN",
  SKIP_FILTER: "SKIP_FILTER", // exclude_words / company blacklist / salary floor
  SKIP_ARCHIVED: "SKIP_ARCHIVED",
  SKIP_FOREIGN: "SKIP_FOREIGN", // other-country popup and allow_other_country=false
  FAILED_NO_CONFIRMATION: "FAILED_NO_CONFIRMATION",
  FAILED_UI: "FAILED_UI", // agent could not complete the flow; snapshot saved
  FAILED_ANTI_BOT: "FAILED_ANTI_BOT",
  FAILED_CAPTCHA: "FAILED_CAPTCHA",
  FAILED_LOGIN_EXPIRED: "FAILED_LOGIN_EXPIRED",
  FAILED_LOW_MEMORY: "FAILED_LOW_MEMORY",
  FAILED_LLM: "FAILED_LLM",
  FAILED_LATEX: "FAILED_LATEX",
  NEEDS_HUMAN: "NEEDS_HUMAN", // chat thread the LLM refused to answer autonomously
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const FATAL_STATUSES: readonly Status[] = [
  Status.FAILED_ANTI_BOT,
  Status.FAILED_CAPTCHA,
  Status.FAILED_LOGIN_EXPIRED,
  Status.FAILED_LOW_MEMORY,
];
export const isFatal = (s: Status): boolean => FATAL_STATUSES.includes(s);

/** Errors that abort a whole run. The runner maps them to a fatal Status + Telegram alert. */
export class RunAbortError extends Error {
  constructor(
    public readonly status: Status,
    message: string,
  ) {
    super(message);
    this.name = "RunAbortError";
  }
}

export interface User {
  id: number;
  slug: string; // "yaroslav", "alina"
  name: string;
  tgChatId: string; // "" → shared chat
  dailyLimitHH: number;
  dailyLimitCareer: number;
  active: boolean;
  allowOtherCountry: boolean;
  poolExpandPerDay: number; // max new hh resumes/day created by pool expand (default 2)
  opusEnabled: boolean;
}

/** The ONLY facts the LLM may use about a person. Mirrored in data/users/<slug>/profile.yaml. */
export interface Profile {
  full_name: string;
  email: string;
  phone: string;
  telegram: string;
  city: string;
  citizenship: string;
  relocation: string; // free text
  work_formats: string[]; // remote | office | hybrid
  salary_from: number; // 0 → never name a figure
  salary_to: number;
  currency: string;
  experience: string;
  languages: string[];
  directions: string[]; // go-backend, node-backend, react, vue, fullstack, android ...
  summary: string;
  verified_skills: string[];
  never_claim_skills: string[];
  hh_queries: string[];
  hh_area: string; // "" → no region filter
  exclude_words: string[];
  company_blacklist: string[];
  extra: Record<string, string>; // free facts for questionnaires
}

export interface ResumeSummary {
  direction: string;
  seniority: string;
  key_skills: string[];
  one_line: string;
}

export interface HHResume {
  id: number;
  userId: number;
  hhResumeId: string; // hh hash
  title: string;
  url: string;
  direction: string;
  summary: ResumeSummary | null;
  isGenerated: boolean;
  syncedAt: string; // ISO
}

export interface Vacancy {
  id: number;
  source: Source;
  externalId: string; // hh vacancy id | canonical URL for career sites
  url: string;
  title: string;
  company: string;
  salaryFrom: number;
  salaryTo: number;
  currency: string;
  descriptionText: string;
  hasTest: boolean;
  requiresLetter: boolean;
  area: string;
  workFormat: string;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  archived: boolean;
  dedupHash: string;
}

/** One element of the decide prompt output. */
export interface Decision {
  vacancy_id: number;
  apply: boolean;
  reason: string;
  resume_id: string; // HHResume.hhResumeId
  cover_letter: string;
  direction: string;
  seniority: string;
  red_flags: string[];
}

export interface Question {
  idx: number;
  text: string;
  kind: "radio" | "checkbox" | "text" | "select" | "number" | "file";
  options?: string[];
  required: boolean;
}

export interface Answer {
  idx: number;
  text?: string;
  option_idx?: number;
  option_idxs?: number[];
}

export interface Application {
  id: number;
  userId: number;
  vacancyId: number;
  hhResumeId: number | null;
  generatedResumeId: number | null;
  runId: number;
  attempt: number;
  status: Status;
  reasonDetail: string;
  coverLetter: string;
  llmDecision: Decision | null;
  createdAt: string;
}

export interface QuestionnaireAnswer {
  id: number;
  applicationId: number;
  question: Question;
  answer: Answer;
  createdAt: string;
}

export type ThreadState = "new" | "viewed" | "invited" | "rejected" | "archived" | "needs_human";

export interface ChatThread {
  id: number;
  userId: number;
  hhNegotiationId: string;
  isBot: boolean;
  vacancyId: number | null;
  employer: string;
  state: ThreadState;
  lastSeenAt: string;
}

export interface ChatMessage {
  id: number;
  threadId: number;
  hhMessageId: string | null;
  direction: "in" | "out";
  author: "employer" | "bot" | "me";
  text: string;
  isQuestion: boolean;
  answered: boolean;
  createdAt: string;
}

export interface GeneratedResume {
  id: number;
  userId: number;
  vacancyId: number;
  texPath: string;
  pdfPath: string;
  model: string;
  createdAt: string;
}

/** Career site as configured in the panel. `profile` is what the onboarding agent learned. */
export interface CareerSite {
  id: number;
  userId: number;
  slug: string;
  name: string;
  baseUrl: string;
  ats: ATSKind;
  profile: SiteProfile;
  enabled: boolean;
  lastRunAt: string | null;
}

export type ATSKind =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "teamtailor"
  | "smartrecruiters"
  | "huntflow"
  | "potok"
  | "hh_hosted" // company.hh.ru → handled by the hh pipeline
  | "custom"; // Stagehand agent flow

/** Learned/edited knowledge about a career site. All fields optional; agent fills what it finds. */
export interface SiteProfile {
  listing_url?: string; // page with the job list
  jobs_json_url?: string; // ATS JSON endpoint if any
  ats_board_token?: string; // greenhouse/lever/ashby board id
  filters?: string[]; // keywords to keep (e.g. "backend", "go")
  apply_mode?: "ats_api" | "agent";
  apply_hints?: string; // free text the agent wrote for itself after a successful apply
  discover_hints?: string;
  notes?: string;
  last_verified_at?: string;
}

export type RunTrigger = "schedule" | "manual" | "cli";
export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";
export type RunSource = "hh" | "career" | "all" | "pool";

export interface RunStats {
  found: number;
  deduped: number;
  by_status: Partial<Record<Status, number>>;
  chat_replies: number;
  invitations: number;
  rejections: number;
  top_vacancies: TopVacancy[];
  dry_run: boolean;
  llm_calls: number;
}

export interface TopVacancy {
  title: string;
  company: string;
  salary_from: number;
  salary_to: number;
  url: string;
}

export interface Run {
  id: number;
  userId: number | null;
  source: RunSource;
  trigger: RunTrigger;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  stats: RunStats;
  tgSent: boolean;
  error: string;
}

export type Stage =
  | "session"
  | "pool"
  | "search"
  | "fetch"
  | "decide"
  | "apply"
  | "chats"
  | "touch"
  | "discover"
  | "tailor"
  | "build"
  | "report";

export interface RunEvent {
  id: number;
  runId: number;
  ts: string;
  level: "info" | "warn" | "error";
  stage: Stage | string;
  message: string;
  data?: Record<string, unknown>;
}

/** Structured CV the LLM edits and the LaTeX renderer consumes (data/users/<slug>/cv/*.yaml). */
export interface CV {
  title: string;
  name: string;
  contacts: { email: string; phone: string; telegram: string; github: string; city: string };
  about: string;
  skills: { name: string; items: string[] }[];
  jobs: {
    company: string;
    role: string;
    period: string;
    location: string;
    summary: string;
    bullets: string[];
    stack: string[];
  }[];
  education: { institution: string; degree: string; period: string; note: string }[];
}

export const emptyRunStats = (dryRun = false): RunStats => ({
  found: 0,
  deduped: 0,
  by_status: {},
  chat_replies: 0,
  invitations: 0,
  rejections: 0,
  top_vacancies: [],
  dry_run: dryRun,
  llm_calls: 0,
});
