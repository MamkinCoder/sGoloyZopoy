// What the chat jobs need: the agent's browser (own Chrome profile), clients, store with the task table.
import { notifierFor, type Config, type EnqueueOptions, type HHClient, type LLMClient, type Logger, type Notifier, type Store, type User } from "@sgz/shared";
import type { ChatTasksRepo } from "../../db/chat-tasks.js";
import type { KbReviewsRepo } from "../../db/kb-reviews.js";
import type { HabrClient } from "../../habr/client.js";
import type { Throttle } from "../../runner/budget.js";
import type { BrowserHandle } from "../../runner/context.js";
import type { ReviewGate } from "./review.js";

export type ChatStore = Store & ChatTasksRepo & KbReviewsRepo;

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
/** The notifier bound to the seeker's chat: their cards and alerts are sent (and edited) there. */
export const userNotifier = (env: Pick<ChatEnv, "notifier" | "store">, userId: number): Notifier => notifierFor(env.notifier, userById(env.store, userId));
