import { setTimeout as sleep } from "node:timers/promises";
import type { Notifier, Run, Store, TapReply, TgButton, User } from "@sgz/shared";
import { chunkMessage, formatAlert, formatReport } from "./format.js";

export interface TelegramOptions {
  fetch?: typeof fetch;
  tz?: string;
  warn?: (msg: string) => void;
}

const RETRIES = 3;
const BASE = "https://api.telegram.org";

export function createTelegram(token: string, chatId: string, panelUrl: string, opts: TelegramOptions = {}): Notifier {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  if (!token) {
    warn("telegram: no bot token, notifications disabled");
    return { report: async () => undefined, alert: async () => undefined };
  }
  const doFetch = opts.fetch ?? fetch;

  /** sendMessage / editMessageText with retries (network, 429, 5xx); resolves to the message id (null when
   *  Telegram's answer had none). */
  async function call(method: string, payload: Record<string, unknown>): Promise<number | null> {
    let lastErr = "";
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${BASE}/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parse_mode: "HTML", disable_web_page_preview: true, ...payload }),
        });
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (attempt < RETRIES) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
        return j?.result?.message_id ?? null;
      }
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
  const sendOne = (chat: string, text: string, extra: Record<string, unknown> = {}) => call("sendMessage", { chat_id: chat, text, ...extra });

  async function send(chat: string, text: string): Promise<void> {
    if (!chat) {
      warn("telegram: no chat id, message dropped");
      return;
    }
    for (const part of chunkMessage(text)) await sendOne(chat, part);
  }

  // Every method of a bound notifier talks to one chat; `edit` edits a card sent by `ask` of the same binding.
  const bound = (chat: string): Notifier => ({
    report: (user: User, run: Run) => send(user.tgChatId || chat, formatReport(user, run, panelUrl, opts.tz)),
    alert: (title: string, body: string) => send(chat, formatAlert(title, body)),
    ask: async (text: string, buttons: TgButton[] | TgButton[][]) => (await sendOne(chat, text, buttons.length ? { reply_markup: keyboard(buttons) } : {})) ?? undefined,
    // A card edit is cosmetic: retried like a send, then only logged.
    edit: async (messageId: number, text: string, buttons: TgButton[][]) => {
      await call("editMessageText", { chat_id: chat, message_id: messageId, text, reply_markup: keyboard(buttons) }).catch((e: unknown) => warn(`telegram: editMessageText: ${e instanceof Error ? e.message : String(e)}`));
    },
    forUser: (user) => bound(user.tgChatId || chatId),
  });
  return bound(chatId);
}

const isRows = (b: TgButton[] | TgButton[][]): b is TgButton[][] => Array.isArray(b[0]);
const keyboard = (buttons: TgButton[] | TgButton[][]) => ({
  inline_keyboard: (isRows(buttons) ? buttons : [buttons]).filter((row) => row.length).map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
});

/** Slash commands (/status, /queue …) accepted only from these chats; the reply is sent as plain text. */
export interface TelegramCommands {
  chatIds: string[];
  /** `args`: the rest of the message after the command; `chatId`: where it came from. */
  onCommand: (command: string, args?: string, chatId?: string) => Promise<string>;
  /** Plain (non-command) messages from those chats; null = no reply. Not awaited by the poll loop. */
  onText?: (chatId: string, text: string) => Promise<string | null>;
}

/**
 * Long-polls getUpdates for inline-button taps and hands each callback's data to `onTap`. A string answer is
 * appended to the original message (its buttons go away); a TapReply replaces the message text and buttons
 * (a grouped card that stays tappable), its `say` follows as a new message. `onTap` gets the tapped chat's id.
 * With `commands`, also answers «/command» messages.
 * With `store`, the update offset lives in setting `tg_offset`, read at start and saved before each update is
 * handled: a restart (every deploy) never hands the same update over again. At most once on purpose: a replayed
 * free text would go to the next waiting KB review and save the story under the wrong tag.
 * Returns a stop function. One consumer per bot token.
 */
export const TG_OFFSET = "tg_offset";
export function startTelegramCallbacks(
  token: string,
  onTap: (data: string, chatId: string) => Promise<string | TapReply>,
  opts: TelegramOptions & { commands?: TelegramCommands; store?: Pick<Store, "getSetting" | "setSetting"> } = {},
): () => void {
  const doFetch = opts.fetch ?? fetch;
  const warn = opts.warn ?? ((m: string) => console.error(m));
  const api = async <T>(method: string, body: unknown): Promise<T> => {
    const res = await doFetch(`${BASE}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
    return j.result;
  };
  let stopped = false;
  let offset = Number(opts.store?.getSetting(TG_OFFSET)) || 0;
  void (async () => {
    while (!stopped) {
      try {
        type Msg = { chat: { id: number }; message_id: number; text?: string };
        type Update = { update_id: number; callback_query?: { id: string; data?: string; message?: Msg }; message?: Msg };
        const cmds = opts.commands;
        const updates = await api<Update[]>("getUpdates", { offset, timeout: 50, allowed_updates: cmds ? ["callback_query", "message"] : ["callback_query"] });
        for (const u of updates) {
          offset = u.update_id + 1;
          opts.store?.setSetting(TG_OFFSET, String(offset));
          const m = u.message;
          // Strangers can message the bot too: only the configured chats get answers.
          const reply = async (text: string | null) => {
            for (const part of text ? chunkMessage(text) : []) await api("sendMessage", { chat_id: m!.chat.id, text: part, disable_web_page_preview: true }).catch(() => undefined);
          };
          if (cmds && m?.text?.startsWith("/") && cmds.chatIds.includes(String(m.chat.id))) {
            const args = m.text.replace(/^\S+\s*/, "");
            await reply(await cmds.onCommand(m.text.split(/[\s@]/)[0]!.toLowerCase(), args, String(m.chat.id)).catch((e: unknown) => `ошибка: ${e instanceof Error ? e.message : String(e)}`));
            continue;
          }
          // A slow reply (an LLM call) must not hold up button taps: answered in the background.
          if (cmds?.onText && m?.text && cmds.chatIds.includes(String(m.chat.id))) {
            void cmds.onText(String(m.chat.id), m.text).catch((e: unknown) => `ошибка: ${e instanceof Error ? e.message : String(e)}`).then(reply);
            continue;
          }
          const q = u.callback_query;
          if (!q?.data) continue;
          const r = await onTap(q.data, q.message ? String(q.message.chat.id) : "").catch((e: unknown) => `ошибка: ${e instanceof Error ? e.message : String(e)}`);
          const note = typeof r === "string" ? r : r.note;
          await api("answerCallbackQuery", { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => undefined);
          if (!q.message) continue;
          const at = { chat_id: q.message.chat.id, message_id: q.message.message_id };
          if (typeof r === "string") await api("editMessageText", { ...at, text: `${q.message.text ?? ""}\n\n${note}` }).catch(() => undefined);
          else {
            await api("editMessageText", { ...at, text: r.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard(r.buttons) }).catch(() => undefined);
            if (r.say) await api("sendMessage", { chat_id: at.chat_id, text: r.say, parse_mode: "HTML", disable_web_page_preview: true }).catch(() => undefined);
          }
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
