// Chat reply tasks (docs/ARCHITECTURE.md §3): one per employer turn. State changes are compare-and-set so
// concurrent jobs (a sync superseding a task while its draft is being written) never overwrite each other.
import { OPEN_TASK_STATES, type ChatTask, type ChatTaskState, type ChatTopic, type NewChatTask } from "@sgz/shared";
import { bool, json, num, numOrNull, placeholders, str, toJson, type Row, type Sql } from "./sql.js";

const mapTask = (r: Row): ChatTask => ({
  id: num(r.id),
  userId: num(r.user_id),
  threadId: num(r.thread_id),
  state: str(r.state) as ChatTaskState,
  messageIds: json<number[]>(r.message_ids_json, []),
  target: str(r.target),
  choices: json<string[]>(r.choices_json, []),
  kind: str(r.kind) as ChatTask["kind"],
  topics: json<ChatTopic[]>(r.topics_json, []),
  draft: str(r.draft),
  tgMessageId: numOrNull(r.tg_message_id),
  reminded: bool(r.reminded),
  attempts: num(r.attempts),
  lastError: str(r.last_error),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

/** Fields a transition may change together with the state. */
export type ChatTaskPatch = Partial<Pick<ChatTask, "kind" | "topics" | "draft" | "tgMessageId" | "reminded" | "lastError" | "messageIds" | "choices" | "target">>;

export interface ChatTasksRepo {
  insertChatTask(t: NewChatTask, nowISO: string): ChatTask;
  getChatTask(id: number): ChatTask | null;
  /** The thread's open (not finished) task, newest first. */
  openChatTask(threadId: number): ChatTask | null;
  /** Latest task per thread of a user (any state), keyed by thread id. */
  latestChatTasks(userId: number): Map<number, ChatTask>;
  listChatTasks(state: ChatTaskState): ChatTask[];
  /** Compare-and-set: only a task still in one of `from` moves. False when it had moved on. */
  moveChatTask(id: number, from: ChatTaskState | ChatTaskState[], to: ChatTaskState, patch: ChatTaskPatch, nowISO: string): boolean;
  /** Same state, new fields (compare-and-set on the state too). */
  patchChatTask(id: number, inState: ChatTaskState, patch: ChatTaskPatch, nowISO: string): boolean;
}

const COLS: Record<keyof ChatTaskPatch, [string, (v: never) => unknown]> = {
  kind: ["kind", (v) => v],
  topics: ["topics_json", toJson],
  draft: ["draft", (v) => v],
  tgMessageId: ["tg_message_id", (v) => v],
  reminded: ["reminded", (v: boolean) => (v ? 1 : 0)],
  lastError: ["last_error", (v: string) => v.slice(0, 1000)],
  messageIds: ["message_ids_json", toJson],
  choices: ["choices_json", toJson],
  target: ["target", (v) => v],
};

export function chatTasksRepo(s: Sql): ChatTasksRepo {
  const get = (id: number) => {
    const r = s.get("SELECT * FROM chat_tasks WHERE id = ?", id);
    return r ? mapTask(r) : null;
  };
  const update = (id: number, from: ChatTaskState[], to: ChatTaskState, patch: ChatTaskPatch, nowISO: string) => {
    const sets = ["state = ?", "updated_at = ?"];
    const vals: unknown[] = [to, nowISO];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      const [col, conv] = COLS[k as keyof ChatTaskPatch];
      sets.push(`${col} = ?`);
      vals.push(conv(v as never));
    }
    const { changes } = s.run(`UPDATE chat_tasks SET ${sets.join(", ")} WHERE id = ? AND state IN (${placeholders(from.length)})`, ...(vals as never[]), id, ...from);
    return changes > 0;
  };
  return {
    insertChatTask(t, nowISO) {
      const { lastId } = s.run(
        `INSERT INTO chat_tasks (user_id, thread_id, state, message_ids_json, target, choices_json, topics_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        t.userId,
        t.threadId,
        t.state ?? "new",
        toJson(t.messageIds),
        t.target,
        toJson(t.choices ?? []),
        toJson(t.topics ?? []),
        nowISO,
        nowISO,
      );
      return get(lastId)!;
    },
    getChatTask: get,
    openChatTask(threadId) {
      const r = s.get(`SELECT * FROM chat_tasks WHERE thread_id = ? AND state IN (${placeholders(OPEN_TASK_STATES.length)}) ORDER BY id DESC LIMIT 1`, threadId, ...OPEN_TASK_STATES);
      return r ? mapTask(r) : null;
    },
    latestChatTasks(userId) {
      const rows = s.all("SELECT * FROM chat_tasks WHERE id IN (SELECT MAX(id) FROM chat_tasks WHERE user_id = ? GROUP BY thread_id)", userId);
      return new Map(rows.map((r) => [num(r.thread_id), mapTask(r)]));
    },
    listChatTasks(state) {
      return s.all("SELECT * FROM chat_tasks WHERE state = ? ORDER BY id", state).map(mapTask);
    },
    moveChatTask(id, from, to, patch, nowISO) {
      return update(id, Array.isArray(from) ? from : [from], to, patch, nowISO);
    },
    patchChatTask(id, inState, patch, nowISO) {
      return update(id, [inState], inState, patch, nowISO);
    },
  };
}
