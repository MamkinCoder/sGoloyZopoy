// Per-user switch for the bot answering employers in chats, per site: hh.ru on by default, Habr Career off.
// Off = the bot never writes in those chats (replies, feedback requests, survey answers, follow-ups): a new employer
// message only goes to the user's topic in Telegram and she answers by hand. Stored as setting `auto_reply:<site>:<userId>`.
import type { Store } from "@sgz/shared";

export type ReplySite = "hh" | "habr";
export const AUTO_REPLY_DEFAULT: Record<ReplySite, boolean> = { hh: true, habr: false };
const key = (site: ReplySite, userId: number) => `auto_reply:${site}:${userId}`;

export const autoReply = (store: Pick<Store, "getSetting">, userId: number, site: ReplySite): boolean => {
  const v = store.getSetting(key(site, userId));
  return v ? v === "1" : AUTO_REPLY_DEFAULT[site];
};
export const setAutoReply = (store: Pick<Store, "setSetting">, userId: number, site: ReplySite, on: boolean): void => store.setSetting(key(site, userId), on ? "1" : "0");
