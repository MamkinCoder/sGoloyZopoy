// Composition of the always-on agent for `sgz serve`: the queue, its own Chrome (chrome-profile-chat with the
// saved hh/habr cookies), the chat handlers, the knowledge-base review gate and serve's recurring jobs
// (scheduler/jobs.ts). With SGZ_RUNNER=false only the digest and the retro run; chat jobs stay queued.
import { paths, type Config, type HHClient, type LLMClient, type Notifier, type RunService } from "@sgz/shared";
import type { SqliteStore } from "../db/index.js";
import type { HabrClient } from "../habr/client.js";
import { createThrottle, readMemAvailableMB } from "../runner/budget.js";
import { createBrowserHandle } from "../runner/context.js";
import type { RunnerDeps } from "../runner/deps.js";
import { sleep } from "../runner/util.js";
import { serveJobs } from "../scheduler/jobs.js";
import type { ChatEnv } from "./chats/env.js";
import { chatHandlers, chatSchedules } from "./chats/index.js";
import { kbReviewGate } from "./chats/review.js";
import { createAgent, type Agent } from "./queue.js";

export type { Agent } from "./queue.js";
export type { ChatEnv } from "./chats/env.js";

export interface AgentDeps {
  cfg: Config;
  store: SqliteStore;
  launcher: RunnerDeps["launcher"];
  loadCookies?: RunnerDeps["loadCookies"];
  hh: HHClient;
  habr: HabrClient | null;
  llm: LLMClient;
  notifier: Notifier;
  runner: Pick<RunService, "start" | "active">;
  /** scheduler.owed(): the daily run waits for the idle runner slot. */
  owed(): boolean;
  startedAt: Date;
}

export function createAppAgent(d: AgentDeps): { agent: Agent; chats: ChatEnv } {
  const log = {
    info: (stage: string, m: string) => console.error(`[agent] [${stage}] ${m}`),
    warn: (stage: string, m: string) => console.error(`[agent] WARN [${stage}] ${m}`),
    error: (stage: string, m: string) => console.error(`[agent] ERROR [${stage}] ${m}`),
  };
  const browser = createBrowserHandle(d, { profileDir: paths.chatChromeProfile, snapshotDir: paths.snapshots(d.cfg), log });
  let agent: Agent | null = null;
  const chats: ChatEnv = {
    cfg: d.cfg,
    store: d.store,
    hh: d.hh,
    habr: d.habr,
    llm: d.llm,
    notifier: d.notifier,
    log,
    now: () => new Date(),
    throttle: createThrottle(d.cfg, sleep, Math.random, new AbortController().signal),
    browser,
    enqueue: (kind, payload, opts) => agent!.enqueue(kind, payload, opts),
    review: kbReviewGate(d.store, d.notifier),
  };
  const chatsOn = d.cfg.runnerEnabled;
  const polls = chatsOn ? chatSchedules() : [];
  const serve = serveJobs({ ...d, chatsPolled: polls.length > 0 });
  agent = createAgent({
    store: d.store,
    handlers: { ...(chatsOn ? chatHandlers(chats) : {}), ...serve.handlers },
    schedules: [...polls, ...serve.schedules],
    keepUnknown: !chatsOn,
    notifier: d.notifier,
    browser,
    log,
    memAvailableMB: readMemAvailableMB,
    memoryGuardMB: d.cfg.memoryGuardMB,
  });
  return { agent, chats };
}
