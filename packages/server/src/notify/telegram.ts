import type { Notifier, Run, User } from "@sgz/shared";
import { chunkMessage, formatAlert, formatReport } from "./format.js";

export interface TelegramOptions {
  fetch?: typeof fetch;
  tz?: string;
  warn?: (msg: string) => void;
}

const RETRIES = 3;
const BASE = "https://api.telegram.org";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createTelegram(token: string, chatId: string, panelUrl: string, opts: TelegramOptions = {}): Notifier {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  if (!token) {
    warn("telegram: no bot token, notifications disabled");
    return { report: async () => undefined, alert: async () => undefined };
  }
  const doFetch = opts.fetch ?? fetch;

  async function sendOne(chat: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    let lastErr = "";
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${BASE}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra }),
        });
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (attempt < RETRIES) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) return;
      let body: { description?: string; parameters?: { retry_after?: number } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* non-json error body */
      }
      lastErr = `${res.status} ${body.description ?? ""}`.trim();
      if (res.status === 429) {
        if (attempt < RETRIES) await sleep(Math.max(1, body.parameters?.retry_after ?? 1) * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (attempt < RETRIES) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`telegram: ${lastErr}`);
    }
    throw new Error(`telegram: giving up after ${RETRIES} attempts: ${lastErr}`);
  }

  async function send(chat: string, text: string): Promise<void> {
    if (!chat) {
      warn("telegram: no chat id, message dropped");
      return;
    }
    for (const part of chunkMessage(text)) await sendOne(chat, part);
  }

  return {
    report: (user: User, run: Run) => send(user.tgChatId || chatId, formatReport(user, run, panelUrl, opts.tz)),
    alert: (title: string, body: string) => send(chatId, formatAlert(title, body)),
    ask: (text: string, buttons: { text: string; data: string }[]) =>
      sendOne(chatId, text, { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } }),
  };
}

/** Slash commands (/status, /queue …) accepted only from these chats; the reply is sent as plain text. */
export interface TelegramCommands {
  chatIds: string[];
  onCommand: (command: string) => Promise<string>;
}

/**
 * Long-polls getUpdates for inline-button taps and hands each callback's data to `onTap`, whose return
 * text is appended to the original message. With `commands`, also answers «/command» messages.
 * Returns a stop function. One consumer per bot token.
 */
export function startTelegramCallbacks(token: string, onTap: (data: string) => Promise<string>, opts: TelegramOptions & { commands?: TelegramCommands } = {}): () => void {
  const doFetch = opts.fetch ?? fetch;
  const warn = opts.warn ?? ((m: string) => console.error(m));
  const api = async <T>(method: string, body: unknown): Promise<T> => {
    const res = await doFetch(`${BASE}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
    return j.result;
  };
  let stopped = false;
  let offset = 0;
  void (async () => {
    while (!stopped) {
      try {
        type Msg = { chat: { id: number }; message_id: number; text?: string };
        type Update = { update_id: number; callback_query?: { id: string; data?: string; message?: Msg }; message?: Msg };
        const cmds = opts.commands;
        const updates = await api<Update[]>("getUpdates", { offset, timeout: 50, allowed_updates: cmds ? ["callback_query", "message"] : ["callback_query"] });
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          // Strangers can message the bot too: only the configured chats get answers.
          if (cmds && m?.text?.startsWith("/") && cmds.chatIds.includes(String(m.chat.id))) {
            const reply = await cmds.onCommand(m.text.split(/[\s@]/)[0]!.toLowerCase()).catch((e: unknown) => `ошибка: ${e instanceof Error ? e.message : String(e)}`);
            for (const part of chunkMessage(reply)) await api("sendMessage", { chat_id: m.chat.id, text: part, disable_web_page_preview: true }).catch(() => undefined);
            continue;
          }
          const q = u.callback_query;
          if (!q?.data) continue;
          const note = await onTap(q.data).catch((e: unknown) => `ошибка: ${e instanceof Error ? e.message : String(e)}`);
          await api("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => undefined);
          if (q.message) await api("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `${q.message.text ?? ""}\n\n${note}` }).catch(() => undefined);
        }
      } catch (e) {
        warn(`telegram callbacks: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(10_000);
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
