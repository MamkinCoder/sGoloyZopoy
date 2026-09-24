// Always-on agent (docs/ARCHITECTURE.md §2-3): the job queue and chat reply tasks.

export type JobState = "queued" | "running" | "done" | "failed";

export interface Job {
  id: number;
  kind: string;
  /** At most one open (queued/running) job per key; null = no dedupe. */
  key: string | null;
  payload: Record<string, unknown>;
  state: JobState;
  priority: number;
  runAfter: string;
  attempts: number;
  maxAttempts: number;
  lastError: string;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueOptions {
  key?: string;
  /** Not before this time (default now). With a key already queued, the earlier time wins. */
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
}

export type ChatTaskState =
  | "new"
  | "triage"
  | "awaiting_review"
  | "drafting"
  | "ready"
  | "sending"
  | "sent"
  /** Handled without a reply: ack-only, rejection, empty draft, answered by hand. */
  | "closed"
  | "superseded"
  | "failed";

export const OPEN_TASK_STATES: readonly ChatTaskState[] = ["new", "triage", "awaiting_review", "drafting", "ready", "sending"];

/** question | scheduling | test_task | rejection | bot_survey | ack_only (triage). */
export type ChatTurnKind = "question" | "scheduling" | "test_task" | "rejection" | "bot_survey" | "ack_only";

/** A technology/skill the employer asked about. `answer` null = waiting for the human. */
export interface ChatTopic {
  name: string;
  answer: "yes" | "no" | null;
  /** Where the answer came from: the stored skills, a Telegram tap, or the 12 h fallback. */
  by: "profile" | "human" | "fallback" | null;
}

export interface ChatTask {
  id: number;
  userId: number;
  threadId: number;
  state: ChatTaskState;
  messageIds: number[];
  target: string;
  choices: string[];
  kind: ChatTurnKind | "";
  topics: ChatTopic[];
  draft: string;
  tgMessageId: number | null;
  reminded: boolean;
  attempts: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

export type NewChatTask = Pick<ChatTask, "userId" | "threadId" | "messageIds" | "target"> & Partial<Pick<ChatTask, "choices" | "topics" | "state">>;

/** GET /api/agent/jobs item. */
export interface AgentJobDTO {
  id: number;
  kind: string;
  key: string | null;
  state: JobState;
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error: string;
  updated_at: string;
}

/** The thread's latest reply task as the Chats page shows it. */
export interface ChatTaskDTO {
  id: number;
  state: ChatTaskState;
  kind: string;
  /** Topics still waiting for the human's ✅/❌. */
  pending: string[];
  topics: ChatTopic[];
  draft: string;
  last_error: string;
  updated_at: string;
}
