// Review gate: before a reply is drafted, every skill the employer asked about must be known. The chat task
// state machine (tasks.ts) only talks to this interface; phase 3 swaps the knowledge-base review in here.
// Phase 1 (skillsReviewGate): known = profile verified_skills / never_claim_skills + the learned ✅/❌ answers;
// the rest goes into ONE grouped Telegram card per task, one ✅/❌ row per topic.
import type { ChatTask, ChatTopic, Notifier, Store, TapReply, TgButton } from "@sgz/shared";
import { escapeHtml } from "../../notify/format.js";
import { knownSkill, learnSkill, learnedSkills, withLearnedSkills } from "../../runner/skills.js";

export interface ReviewGate {
  /** The task's topics with everything already known filled in; `answer: null` = the human must say. */
  prefill(task: ChatTask): ChatTopic[];
  /** Shows the pending topics to the human (one card); resolves to the Telegram message id when known. */
  ask(task: ChatTask, reminder: boolean): Promise<number | null>;
  /** Keeps a human answer beyond this task (phase 1: the learned skills; phase 3: the KB tag status). */
  record(userId: number, topic: string, has: boolean): void;
  /** The card for the task as it is now (after a tap it replaces the tapped message). */
  card(task: ChatTask, footer?: string): Omit<TapReply, "note">;
}

/** Callback data of a card button: `ct:<taskId>:<topicIndex>:<y|n>` (well under Telegram's 64 bytes). */
export const cardCallback = (taskId: number, idx: number, has: boolean): string => `ct:${taskId}:${idx}:${has ? "y" : "n"}`;

export function parseCardCallback(data: string): { taskId: number; idx: number; has: boolean } | null {
  const m = /^ct:(\d+):(\d+):([yn])$/.exec(data);
  return m ? { taskId: Number(m[1]), idx: Number(m[2]), has: m[3] === "y" } : null;
}

const MARK = { yes: "✅ есть", no: "❌ нет" } as const;

type GateStore = Pick<Store, "getProfile" | "saveProfile" | "getSetting" | "setSetting" | "listUsers" | "listChatThreads" | "listChatMessages">;

export function skillsReviewGate(store: GateStore, notifier: Pick<Notifier, "ask" | "alert">): ReviewGate {
  const thread = (task: ChatTask) => store.listChatThreads(task.userId).find((t) => t.id === task.threadId) ?? null;

  const card: ReviewGate["card"] = (task, footer) => {
    const t = thread(task);
    const asked = store
      .listChatMessages(task.threadId)
      .filter((m) => task.messageIds.includes(m.id))
      .map((m) => m.text.trim())
      .join("\n")
      .slice(0, 600);
    const lines = task.topics.map((tp) => `• ${escapeHtml(tp.name)} - ${tp.answer ? MARK[tp.answer] : "ждёт ответа"}`);
    const pending = task.topics.map((tp, i) => ({ tp, i })).filter(({ tp }) => tp.answer === null);
    const buttons: TgButton[][] = pending.map(({ tp, i }) => [
      { text: `✅ ${tp.name}`, data: cardCallback(task.id, i, true) },
      { text: `❌ ${tp.name}`, data: cardCallback(task.id, i, false) },
    ]);
    const tail = footer ?? (pending.length ? "Есть такие навыки? Ответ работодателю уйдёт, когда ответишь на все." : "Все ответы есть, готовлю ответ работодателю.");
    const text = `<b>${escapeHtml(t?.employer || "Работодатель")}</b> спрашивает:\n«${escapeHtml(asked)}»\n\n${lines.join("\n")}\n\n${tail}`;
    return { text, buttons };
  };

  return {
    prefill(task) {
      const p = store.getProfile(task.userId);
      const known = p ? withLearnedSkills(p, learnedSkills(store, task.userId)) : { verified_skills: [], never_claim_skills: [] };
      return task.topics.map((tp) => {
        if (tp.answer) return tp;
        const k = knownSkill(known, tp.name);
        return k ? { ...tp, answer: k, by: "profile" } : tp;
      });
    },
    async ask(task, reminder) {
      if (!notifier.ask) {
        // No Telegram buttons (no token): the 12 h fallback answers honestly without the human.
        await notifier.alert("Навыки ждут ответа", `${thread(task)?.employer ?? ""}: ${task.topics.filter((t) => !t.answer).map((t) => t.name).join(", ")}`).catch(() => undefined);
        return null;
      }
      const c = card(task);
      const id = await notifier.ask(reminder ? `⏰ Напоминание: работодатель ждёт ответа уже 2 часа\n\n${c.text}` : c.text, c.buttons);
      return typeof id === "number" ? id : null;
    },
    record: (userId, topic, has) => learnSkill(store, userId, topic, has),
    card,
  };
}
