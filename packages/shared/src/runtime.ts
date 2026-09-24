// Runner / notifier / config contracts. Workstream G implements runner+scheduler+notify; A implements config.
import type { Run, RunEvent, RunSource, RunTrigger, User } from "./model.js";

export interface Config {
  dataDir: string; // SGZ_DATA_DIR, default ./data
  repoDir: string; // dir containing CLAUDE.md (cwd for claude -p)
  bind: { host: string; port: number }; // SGZ_BIND, default 0.0.0.0:3002
  panelPassword: string;
  panelUrl: string;
  tgBotToken: string;
  tgChatId: string;
  chromiumBin: string; // CHROMIUM_BIN
  claudeBin: string; // default "claude"
  xelatexBin: string; // default "xelatex"
  scheduleAt: string; // "12:00"; "" → off
  scheduleJitterMin: number; // ±minutes, default 20
  tz: string; // Europe/Moscow
  runnerEnabled: boolean;
  throttleMinMs: number; // 8000
  throttleMaxMs: number; // 20000
  userAgent: string;
  memoryGuardMB: number; // default 450
}

export const paths = {
  db: (c: Config) => `${c.dataDir}/sgz.db`,
  profile: (c: Config, slug: string) => `${c.dataDir}/users/${slug}/profile.yaml`,
  cookies: (c: Config, slug: string) => `${c.dataDir}/users/${slug}/hh-cookies.json`,
  habrCookies: (c: Config, slug: string) => `${c.dataDir}/users/${slug}/habr-cookies.json`,
  habrResumeProposal: (c: Config, slug: string) => `${c.dataDir}/users/${slug}/habr-resume.proposal.json`,
  chromeProfile: (c: Config, slug: string) => `${c.dataDir}/users/${slug}/chrome-profile`,
  /** The always-on agent's own browser profile (runs next to the batch one, same saved cookies). */
  chatChromeProfile: (c: Config, slug: string) => `${c.dataDir}/users/${slug}/chrome-profile-chat`,
  cvDir: (c: Config, slug: string) => `${c.dataDir}/users/${slug}/cv`,
  texDir: (c: Config) => `${c.dataDir}/tex`,
  generatedDir: (c: Config, slug: string) => `${c.dataDir}/users/${slug}/generated`,
  snapshots: (c: Config, runId?: number) => `${c.dataDir}/snapshots${runId ? `/run-${runId}` : ""}`,
  actionCache: (c: Config) => `${c.dataDir}/action-cache`,
  recordings: (c: Config) => `${c.dataDir}/recordings`,
};

export interface RunRequest {
  userSlug: string | "all";
  source: RunSource;
  stage?: string; // search | apply | pool-sync | pool-expand | touch | onboard:<siteId>
  dryRun: boolean;
  limit: number; // 0 → user's daily limit
  trigger: RunTrigger;
}

export class RunBusyError extends Error {
  constructor() {
    super("a run is already active");
    this.name = "RunBusyError";
  }
}

export interface RunService {
  /** Enqueue; resolves with the run id. Throws RunBusyError if a run is active. */
  start(req: RunRequest): Promise<number>;
  stop(runId: number): Promise<void>;
  active(): Run | null;
  /** Live events for a run; the iterator ends when the run finishes. */
  subscribe(runId: number): AsyncIterable<RunEvent>;
  /** Resolves when the run finishes (for the CLI). */
  wait(runId: number): Promise<Run>;
}

export interface TgButton {
  text: string;
  data: string;
}

/** A button tap's answer: `note` pops up; `text` + `buttons` replace the tapped message (HTML, escaped by the caller). */
export interface TapReply {
  note: string;
  text: string;
  buttons: TgButton[][];
  /** Sent as a new HTML message to the same chat after the edit (e.g. a question to answer in free text). */
  say?: string;
}

export interface Notifier {
  report(user: User, run: Run): Promise<void>;
  alert(title: string, body: string): Promise<void>;
  /** HTML message (the caller escapes) with inline buttons, none when `buttons` is empty; `data` comes back
   *  through the callback poller. A flat list is one row; a list of lists is one row each. Resolves to the
   *  Telegram message id when known. Optional (tests, no token). */
  ask?(text: string, buttons: TgButton[] | TgButton[][]): Promise<number | void>;
  /** Replaces the text and buttons of a message sent by `ask` (same chat). Optional like `ask`. */
  edit?(messageId: number, text: string, buttons: TgButton[][]): Promise<void>;
  /** The same notifier bound to the seeker's own chat (`user.tgChatId`, else the owner's): alert/ask/edit go there. */
  forUser?(user: Pick<User, "tgChatId">): Notifier;
}

/** `n` bound to the user's chat; `n` itself when it cannot bind (no Telegram, test fakes) or there is no user. */
export const notifierFor = <N extends Partial<Notifier>>(n: N, user: Pick<User, "tgChatId"> | null | undefined): N => ((user && n.forUser?.(user)) as N | undefined) ?? n;

export interface Logger {
  info(stage: string, message: string, data?: Record<string, unknown>): void;
  warn(stage: string, message: string, data?: Record<string, unknown>): void;
  error(stage: string, message: string, data?: Record<string, unknown>): void;
}

/** The message of a thrown value (Error or anything else). */
export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
