// Composition of the always-on agent for `sgz serve`: the queue, its own Chrome (chrome-profile-chat with the
// saved hh/habr cookies), the chat handlers and the knowledge-base review gate.
import { paths, type Config, type HHClient, type LLMClient, type Notifier } from "@sgz/shared";
import type { SqliteStore } from "../db/index.js";
import type { HabrClient } from "../habr/client.js";
import { createThrottle } from "../runner/budget.js";
import { createBrowserHandle } from "../runner/context.js";
import type { RunnerDeps } from "../runner/deps.js";
import { sleep } from "../runner/util.js";
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
  agent = createAgent({ store: d.store, handlers: chatHandlers(chats), schedules: chatSchedules(), notifier: d.notifier, browser, log });
  return { agent, chats };
}
