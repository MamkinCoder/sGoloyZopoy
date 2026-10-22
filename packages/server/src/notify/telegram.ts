import { errMessage } from "@sgz/shared";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Notifier, Run, Store, TapReply, TgButton, User } from "@sgz/shared";
import { chunkMessage, formatAlert, formatReport } from "./format.js";

export interface TelegramOptions {
  /** With a store, a forum supergroup (`chatId`) gets one topic per user, created on demand (setting `tg_topic:<userId>`). */
  store?: Pick<Store, "getSetting" | "setSetting">;
  fetch?: typeof fetch;
  tz?: string;
  warn?: (msg: string) => void;
}

/** What a binding needs of a user; callers often hold only part of a User (tests, fakes), then there is no topic. */
type Who = Pick<User, "tgChatId"> & Partial<Pick<User, "id" | "name" | "slug">>;

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
        lastErr = errMessage(e);
        if (attempt < RETRIES) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) {
        // createForumTopic answers with message_thread_id instead of message_id; both are the number the caller wants.
        const j = (await res.json().catch(() => null)) as { result?: { message_id?: number; message_thread_id?: number } } | null;
        return j?.result?.message_id ?? j?.result?.message_thread_id ?? null;
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

  async function send(chat: string, text: string, thread: number | null = null): Promise<void> {
    if (!chat) {
      warn("telegram: no chat id, message dropped");
      return;
    }
    for (const part of chunkMessage(text)) await sendOne(chat, part, thread ? { message_thread_id: thread } : {});
  }

  // ---- group topics: the user's own topic in the forum supergroup, created by the bot (needs «Manage topics»).
  const topicKey = (u: Who) => `tg_topic:${u.id}`;
  const topicFailedAt = new Map<number, number>();
  async function threadOf(user: Who): Promise<number | null> {
    const store = opts.store;
    if (!store || !chatId || user.id === undefined) return null;
    const known = Number(store.getSetting(topicKey(user)));
    if (known) return known;
    if (Date.now() - (topicFailedAt.get(user.id!) ?? 0) < 10 * 60_000) return null; // no right / not a forum: retry later, quietly
    try {
      const id = await call("createForumTopic", { chat_id: chatId, name: (user.name || user.slug || String(user.id)).slice(0, 128) });
      if (id) store.setSetting(topicKey(user), String(id));
      return id;
    } catch (e) {
      topicFailedAt.set(user.id!, Date.now());
      warn(`telegram: no topic for ${user.slug ?? user.id} (make the bot an admin with «Manage topics» in a group with Topics on): ${errMessage(e)}`);
      return null;
    }
  }
  /** `fn` with the user's topic id; a topic deleted by hand is forgotten and made again once. */
  async function inTopic<T>(user: Who, fn: (thread: number | null) => Promise<T>): Promise<T> {
    try {
      return await fn(await threadOf(user));
    } catch (e) {
      if (!/thread not found/i.test(errMessage(e))) throw e;
      opts.store?.setSetting(topicKey(user), "");
      return fn(await threadOf(user));
    }
  }
  /** To the user's personal chat `dm` when given, else to her topic (or the group's General when she has none). */
  const speak = (user: Who | undefined, dm: string, text: string): Promise<void> => (user && !dm ? inTopic(user, (t) => send(chatId, text, t)) : send(dm || chatId, text));
  /** sendDocument via a hand-built multipart body (a Buffer, not FormData): the Pi's CONNECT-proxy fetch
   *  only forwards string/Buffer bodies, so FormData/Blob would arrive empty. Retries like `call`. */
  async function sendDocument(chat: string, doc: { path: string; filename?: string; caption?: string }, thread: number | null = null): Promise<void> {
    if (!chat) {
      warn("telegram: no chat id, document dropped");
      return;
    }
    const data = await readFile(doc.path);
    const fields: Record<string, string> = { chat_id: chat };
    if (thread) fields.message_thread_id = String(thread);
    if (doc.caption) fields.caption = doc.caption.slice(0, 1024);
    const { body, contentType } = multipart(fields, { field: "document", filename: doc.filename || basename(doc.path), contentType: /\.txt$/i.test(doc.filename || doc.path) ? "text/plain" : "application/pdf", data });
    let lastErr = "";
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${BASE}/bot${token}/sendDocument`, { method: "POST", headers: { "content-type": contentType }, body });
      } catch (e) {
        lastErr = errMessage(e);
        if (attempt < RETRIES) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) return;
      let errBody: { description?: string; parameters?: { retry_after?: number } } = {};
      try {
        errBody = (await res.json()) as typeof errBody;
      } catch {
        /* non-json error body */
      }
      lastErr = `${res.status} ${errBody.description ?? ""}`.trim();
      if (res.status === 429 && attempt < RETRIES) {
        await sleep(Math.max(1, errBody.parameters?.retry_after ?? 1) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < RETRIES) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`telegram sendDocument: ${lastErr}`);
    }
    throw new Error(`telegram sendDocument: giving up after ${RETRIES} attempts: ${lastErr}`);
  }

  // A bound notifier talks to one place: the owner chat (no user), the user's topic in the group (the feed, default) or
  // her personal chat (place "dm"; the topic when she has none). `edit` edits a card sent by `ask` of the same binding.
  const bound = (user?: Who, place?: "dm"): Notifier => {
    const dm = place === "dm" && user?.tgChatId && user.tgChatId !== chatId ? user.tgChatId : "";
    const home = dm || chatId;
    const where = <T>(fn: (thread: number | null) => Promise<T>): Promise<T> => (user && !dm ? inTopic(user, fn) : fn(null));
    return {
      report: (u: User, run: Run) => speak(u, "", formatReport(u, run, panelUrl, opts.tz)),
      alert: (title: string, body: string) => speak(user, dm, formatAlert(title, body)),
      ask: async (text: string, buttons: TgButton[] | TgButton[][]) =>
        (await where((t) => sendOne(home, text, { ...(buttons.length ? { reply_markup: keyboard(buttons) } : {}), ...(t ? { message_thread_id: t } : {}) }))) ?? undefined,
      // A card edit is cosmetic: retried like a send, then only logged.
      edit: async (messageId: number, text: string, buttons: TgButton[][]) => {
        await call("editMessageText", { chat_id: home, message_id: messageId, text, reply_markup: keyboard(buttons) }).catch((e: unknown) => warn(`telegram: editMessageText: ${errMessage(e)}`));
      },
      document: (doc) => where((t) => sendDocument(home, doc, t)),
      forUser: (u, p) => bound(u, p),
    };
  };
  return bound();
}

/** multipart/form-data body as a single Buffer (one text/file part set) plus its content-type header. */
function multipart(fields: Record<string, string>, file: { field: string; filename: string; contentType: string; data: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----sgz${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8"));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const isRows = (b: TgButton[] | TgButton[][]): b is TgButton[][] => Array.isArray(b[0]);
const keyboard = (buttons: TgButton[] | TgButton[][]) => ({
  inline_keyboard: (isRows(buttons) ? buttons : [buttons]).filter((row) => row.length).map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))),
});

/** Slash commands (/status, /queue …) accepted only from these chats; the reply is sent as plain text. */
export interface TelegramCommands {
  /** Chats allowed to use commands. Read on every update, so a getter can grow it (e.g. a panel-set user id). */
  chatIds: string[];
  /** Registered once via setMyCommands as the bot's command menu (the client-side tooltip / «/» autocomplete). */
  menu?: { command: string; description: string }[];
  /** `args`: the rest of the message after the command; `chatId`: where it came from. */
  onCommand: (command: string, args?: string, chatId?: string) => Promise<string>;
  /** Plain (non-command) messages from those chats; null = no reply. Not awaited by the poll loop.
   *  `msg.remove()` deletes the message from the chat (a password the user just typed). */
  onText?: (chatId: string, text: string, msg?: { remove(): Promise<void> }) => Promise<string | null>;
  /** A file sent by those chats (the CV as PDF); `download` fetches it (Bot API: up to 20 MB). Not awaited by the poll loop. */
  onDocument?: (chatId: string, doc: { name: string; size: number; download(): Promise<Buffer> }) => Promise<string | null>;
  /** Text from a chat that is not allowed (yet): an invite link «/start <code>». The answer is sent back, null stays silent. */
  onStranger?: (chatId: string, text: string) => Promise<string | null>;
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
  // The bot's @name, for «open in private chat» link buttons on group cards (setting tg_bot_username).
  if (opts.store) void api<{ username?: string }>("getMe", {}).then((me) => me.username && opts.store?.setSetting("tg_bot_username", me.username)).catch(() => undefined);
  // Register the command menu (tooltip) once; a failure here must not stop the poller.
  if (opts.commands?.menu?.length) {
    void api("setMyCommands", { commands: opts.commands.menu }).catch((e: unknown) => warn(`telegram setMyCommands: ${errMessage(e)}`));
  }
  void (async () => {
    while (!stopped) {
      try {
        type Msg = { chat: { id: number }; message_id: number; message_thread_id?: number; is_topic_message?: boolean; text?: string; document?: { file_id: string; file_name?: string; file_size?: number } };
        type Update = { update_id: number; callback_query?: { id: string; data?: string; message?: Msg }; message?: Msg };
        const cmds = opts.commands;
        const updates = await api<Update[]>("getUpdates", { offset, timeout: 50, allowed_updates: cmds ? ["callback_query", "message"] : ["callback_query"] });
        for (const u of updates) {
          offset = u.update_id + 1;
          opts.store?.setSetting(TG_OFFSET, String(offset));
          const m = u.message;
          // Strangers can message the bot too: only the configured chats get answers.
          const reply = async (text: string | null) => {
            for (const part of text ? chunkMessage(text) : []) await api("sendMessage", { chat_id: m!.chat.id, text: part, disable_web_page_preview: true, ...(m!.is_topic_message && m!.message_thread_id ? { message_thread_id: m!.message_thread_id } : {}) }).catch(() => undefined);
          };
          const allowed = !!cmds && !!m && cmds.chatIds.includes(String(m.chat.id));
          if (cmds?.onStranger && m?.text && !allowed) {
            await reply(await cmds.onStranger(String(m.chat.id), m.text).catch((e: unknown) => `ошибка: ${errMessage(e)}`));
            continue;
          }
          if (cmds?.onDocument && m?.document && allowed) {
            const d = m.document;
            const download = async (): Promise<Buffer> => {
              const { file_path } = await api<{ file_path: string }>("getFile", { file_id: d.file_id });
              const res = await doFetch(`${BASE}/file/bot${token}/${file_path}`);
              if (!res.ok) throw new Error(`telegram file: ${res.status}`);
              return Buffer.from(await res.arrayBuffer());
            };
            void cmds.onDocument(String(m.chat.id), { name: d.file_name ?? "file", size: d.file_size ?? 0, download }).catch((e: unknown) => `ошибка: ${errMessage(e)}`).then(reply);
            continue;
          }
          if (cmds && m?.text?.startsWith("/") && allowed) {
            const args = m.text.replace(/^\S+\s*/, "");
            await reply(await cmds.onCommand(m.text.split(/[\s@]/)[0]!.toLowerCase(), args, String(m.chat.id)).catch((e: unknown) => `ошибка: ${errMessage(e)}`));
            continue;
          }
          // A slow reply (an LLM call) must not hold up button taps: answered in the background.
          if (cmds?.onText && m?.text && allowed) {
            const remove = async () => void (await api("deleteMessage", { chat_id: m.chat.id, message_id: m.message_id }).catch(() => undefined));
            void cmds.onText(String(m.chat.id), m.text, { remove }).catch((e: unknown) => `ошибка: ${errMessage(e)}`).then(reply);
            continue;
          }
          const q = u.callback_query;
          if (!q?.data) continue;
          const r = await onTap(q.data, q.message ? String(q.message.chat.id) : "").catch((e: unknown) => `ошибка: ${errMessage(e)}`);
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
        warn(`telegram callbacks: ${errMessage(e)}`);
        await sleep(10_000);
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
