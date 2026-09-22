import type { Notifier, Run, User } from "@sgz/shared";
import { chunkMessage, formatAlert, formatReport } from "./format.js";

export interface TelegramOptions {
  baseUrl?: string; // default https://api.telegram.org
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  tz?: string;
  warn?: (msg: string) => void;
}

const RETRIES = 3;

export function createTelegram(token: string, chatId: string, panelUrl: string, opts: TelegramOptions = {}): Notifier {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  if (!token) {
    warn("telegram: no bot token, notifications disabled");
    return { report: async () => undefined, alert: async () => undefined };
  }
  const base = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function sendOne(chat: string, text: string): Promise<void> {
    let lastErr = "";
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
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
  };
}
