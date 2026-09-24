// HTTP API DTOs — the contract between packages/server (H) and packages/web (I).
// Route list lives in docs/api.md; shapes live here so both sides type-check against the same thing.
import type { ChatTaskDTO } from "./agent.js";
import type {
  Application,
  CareerSite,
  SalaryBand,
  StudyPack,
  ChatMessage,
  ChatThread,
  Decision,
  HHResume,
  Profile,
  Run,
  RunEvent,
  RunSource,
  Status,
  User,
  Vacancy,
} from "./model.js";

export type UserDTO = User;
export type ProfileDTO = Profile;

export interface StatsDTO {
  sent: number;
  skipped: number;
  failed: number;
  by_status: Partial<Record<Status, number>>;
  invitations: number;
  rejections: number;
  chat_replies: number;
  runs_count: number;
}

/** GET /users/:slug/analytics — one payload for the dashboard charts. */
export interface AnalyticsCount {
  key: string;
  n: number;
  /** Conversion (companies / sources / resumes / directions only): of `n` sent, `hh` went through hh
   * (career sites have no negotiation threads), `resp` got a reply / view, `inv` an invitation. */
  hh?: number;
  resp?: number;
  inv?: number;
  /** Interviews the seeker marked as passed (next stage or offer). */
  pass?: number;
}

export interface AnalyticsDay {
  day: string; // YYYY-MM-DD (UTC)
  sent: number;
  skipped: number;
  failed: number;
  msgs_in: number; // employer messages
  bot_out: number; // replies the bot sent (hh_message_id IS NULL)
  llm_calls: number;
}

export interface AnalyticsEvent {
  at: string;
  kind: "sent" | "employer" | "bot";
  title: string;
  detail: string;
}

export interface AnalyticsDTO {
  since: string | null;
  kpi: {
    sent: number;
    skipped: number;
    failed: number;
    negotiations: number;
    responded: number; // threads in viewed|invited|rejected
    response_rate: number | null; // responded / sent
    invitations: number;
    rejections: number;
    employer_messages: number;
    bot_replies: number;
    needs_human_open: number;
    resumes_total: number;
    resumes_generated: number;
    llm_calls: number;
    llm_failed: number;
    llm_prompt_chars: number;
    llm_result_chars: number;
    llm_avg_ms: number;
    runs: number;
  };
  daily: AnalyticsDay[];
  funnel: AnalyticsCount[]; // found, decided, approved, sent, viewed, invited
  skip_reasons: AnalyticsCount[];
  companies: AnalyticsCount[];
  sources: AnalyticsCount[];
  resumes: AnalyticsCount[];
  directions: AnalyticsCount[];
  reject_reasons: AnalyticsCount[];
  work_formats: AnalyticsCount[];
  areas: AnalyticsCount[];
  llm_tasks: AnalyticsCount[];
  recent: AnalyticsEvent[];
  /** RUB band over vacancies decided for this user in the last 90 days; null when too few. */
  salary: SalaryBand | null;
}

export interface ApplicationDTO {
  application: Application;
  vacancy: Vacancy;
  resume_title: string;
}

export interface ApplicationDetailDTO extends ApplicationDTO {
  questionnaire: { question: { idx: number; text: string; kind: string; options?: string[]; required: boolean }; answer: unknown }[];
  decision: Decision | null;
  snapshot_url: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface GeneratedResumeDTO {
  id: number;
  vacancy_id: number;
  vacancy_title: string;
  company: string;
  pdf_url: string;
  tex_url: string;
  model: string;
  created_at: string;
}

export interface ResumesDTO {
  hh: HHResume[];
  generated: GeneratedResumeDTO[];
  last_synced: string | null;
  capacity: { created: number; max: number } | null;
}

/** A career application waiting in the review queue (status QUEUED). */
export interface QueueItemDTO {
  id: number;
  created_at: string;
  vacancy: { id: number; title: string; company: string; url: string; area: string; work_format: string; salary_from: number; salary_to: number; currency: string };
  site: { name: string; slug: string } | null;
  pdf_url: string | null;
  /** The site can't be applied to by the bot (job board needing the user's login): apply by hand via the link. */
  manual_apply: boolean;
  cover_letter: string;
  /** Claude's decide reason. */
  reason: string;
  /** Last send/inspect note (e.g. "form checked: ..."). */
  detail: string;
  form: { full_name: string; email: string; phone: string; cv_file_name: string; cover_letter: string };
  /** Extra questions and the bot's answers, after «Проверить форму». */
  questionnaire: ApplicationDetailDTO["questionnaire"];
  /** decide's 0-100 fit, null on rows decided before the field existed. */
  fit_score: number | null;
  fit_reason: string;
}

/** A vacancy the pipeline filtered out (newest row per vacancy is a SKIP_* filter status). */
export interface FilteredItemDTO {
  id: number;
  created_at: string;
  status: Status;
  /** Filter detail or the LLM's reason. */
  reason: string;
  vacancy: { id: number; title: string; company: string; url: string; source: string };
  site: { name: string; slug: string } | null;
  fit_score: number | null;
  fit_reason: string;
}

export interface ChatThreadDTO extends ChatThread {
  vacancy: { id: number; title: string; company: string; url: string } | null;
  unanswered: number;
  last_message: string | null;
  /** A study pack is stored (GET /users/:slug/chats/:id/study returns it); `study` itself is not in the list. */
  has_study: boolean;
  /** The latest reply task of the always-on agent, null when the thread never had one. */
  task: ChatTaskDTO | null;
}
export type ChatMessageDTO = ChatMessage;

/** GET /users/:slug/chats/:id/study: the stored pack (null until built) and whether a build is running. */
export interface StudyDTO {
  pack: StudyPack | null;
  generating: boolean;
  /** Last build failure for this thread ("" when none). */
  error: string;
}

export interface RunDTO extends Run {
  user_slug: string | null;
}
export type RunEventDTO = RunEvent;

export interface StartRunBody {
  user: string | "all";
  source: RunSource;
  dry_run?: boolean;
  limit?: number;
  stage?: string;
}

export interface DedupRowDTO {
  vacancy: { title: string; company: string; url: string };
  reason: Status;
  detail: string;
}

/** `yield` (last 30 days) and `fails` (consecutive failed visits) come only from the list endpoint. */
export type CareerSiteDTO = CareerSite & { yield?: { found: number; queued: number }; fails?: number };

export interface HealthDTO {
  ok: boolean;
  version: string;
  uptime_s: number;
  mem_rss_mb: number;
  mem_available_mb: number | null;
  active_run_id: number | null;
  scheduler_next: string | null;
  users: {
    slug: string;
    hh_login_ok: boolean | null;
    cookies_age_h: number | null;
    /** Career autopilot today: enabled sites, sites still unvisited, queue slots left of the daily limit. */
    career: { sites_enabled: number; sites_left_today: number; queue_left: number; daily_limit: number };
  }[];
  tools: { chromium: string | null; claude: string | null; xelatex: string | null };
  /** Last hh resume raise ("touch"), ISO or null. */
  touch_last_at: string | null;
}

export interface ApiError {
  error: string;
}

/** GET /users/:slug/retro: last 7 days vs the 7 before. The route answers null when the week is too small. */
export interface RetroDTO {
  since: string;
  sent: number;
  response_rate: number | null;
  invite_rate: number | null;
  /** The previous 7 days, null when it had too few sends to compare against. */
  prev: { sent: number; response_rate: number | null; invite_rate: number | null } | null;
  /** Over the last 14 days (answers lag sends), hh sends only, each gated by a minimum sample. */
  best: { key: string; hh: number; resp: number; inv: number } | null;
  mismatch: { key: string; hh: number } | null;
  /** Review-queue items older than 3 days. */
  stale_queue: number;
  interviews: { employer: string; at: string; state: string }[];
}
