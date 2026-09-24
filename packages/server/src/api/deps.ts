// Dependencies injected into createApp. Everything optional beyond cfg/store/runner/version is a
// health hook the integrator wires from other workstreams (they may not exist yet when H ships).
import type { ChatTask, Config, Job, JobState, LLMClient, RunService, Store } from "@sgz/shared";

/** Read-only view of the always-on agent's tables (jobs, chat reply tasks). */
export interface AgentView {
  jobs(state?: JobState): Job[];
  /** Latest reply task per thread of a user, keyed by thread id. */
  tasks(userId: number): Map<number, ChatTask>;
}

export interface HHSessionCheck {
  ok: boolean | null;
  cookiesAgeH: number | null;
}

export interface ToolVersions {
  chromium: string | null;
  claude: string | null;
  xelatex: string | null;
}

export interface RuntimeSettings {
  schedule_at?: string;
  schedule_jitter_min?: string;
  dedup_window_days?: string;
  tz?: string;
}

export interface ApiDeps {
  cfg: Config;
  store: Store;
  runner: RunService;
  version: string;
  /** On-demand LLM calls outside runs (interview study pack). Absent: those endpoints answer 503. */
  llm?: LLMClient;
  /** The always-on agent; absent (CLI, tests): /agent/jobs is empty and chats carry no task. */
  agent?: AgentView;
  /** Registered career-site adapter names (GET /api/adapters). Defaults to the ATSKind list. */
  adapters?: string[];
  hhSessionCheck?: (slug: string) => HHSessionCheck;
  schedulerNext?: () => string | null;
  /** Called after validated settings are persisted, so the live scheduler can reload. */
  settingsChanged?: (settings: RuntimeSettings) => void;
  memAvailableMB?: () => number | null;
  toolVersions?: () => ToolVersions;
  /** Directory with the built SPA; defaults to packages/server/spa. */
  spaDir?: string;
  /** Request log sink; defaults to console.log. Pass a no-op in tests. */
  log?: (line: string) => void;
}
