// What the chat jobs need: the agent's browser (own Chrome profile), clients, store with the task table.
import type { Config, EnqueueOptions, HHClient, LLMClient, Logger, Notifier, Store, User } from "@sgz/shared";
import type { ChatTasksRepo } from "../../db/chat-tasks.js";
import type { HabrClient } from "../../habr/client.js";
import type { Throttle } from "../../runner/budget.js";
import type { BrowserHandle } from "../../runner/context.js";
import type { ReviewGate } from "./review.js";

export type ChatStore = Store & ChatTasksRepo;

export interface ChatEnv {
  cfg: Config;
  store: ChatStore;
  hh: HHClient;
  habr: HabrClient | null;
  llm: LLMClient;
  notifier: Notifier;
  log: Logger;
  now(): Date;
  throttle: Throttle;
  browser: Pick<BrowserHandle, "openHH" | "openHabr">;
  enqueue(kind: string, payload?: Record<string, unknown>, opts?: EnqueueOptions): unknown;
  review: ReviewGate;
}

export const userById = (store: Pick<Store, "listUsers">, id: number): User | null => store.listUsers().find((u) => u.id === id) ?? null;
