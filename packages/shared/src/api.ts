// HTTP API DTOs — the contract between packages/server (H) and packages/web (I).
// Route list lives in docs/api.md; shapes live here so both sides type-check against the same thing.
import type {
  Application,
  CareerSite,
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

export interface ChatThreadDTO extends ChatThread {
  vacancy: { id: number; title: string; company: string; url: string } | null;
  unanswered: number;
  last_message: string | null;
}
export type ChatMessageDTO = ChatMessage;

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

export type CareerSiteDTO = CareerSite;

export interface HealthDTO {
  ok: boolean;
  version: string;
  uptime_s: number;
  mem_rss_mb: number;
  mem_available_mb: number | null;
  active_run_id: number | null;
  scheduler_next: string | null;
  users: { slug: string; hh_login_ok: boolean | null; cookies_age_h: number | null }[];
  tools: { chromium: string | null; claude: string | null; xelatex: string | null };
}

export interface ApiError {
  error: string;
}
