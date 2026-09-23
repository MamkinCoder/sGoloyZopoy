// Evening digest and the /status, /queue Telegram commands: plain text (sent through alert(), which
// escapes it; Telegram auto-links the bare URLs).
import { Status, type Store, type User } from "@sgz/shared";
import { dayInTz, zonedParts, zonedToUtc } from "../scheduler/tz.js";
import { plural } from "./format.js";

const STALE_DAYS = 5;

/** Start of `now`'s day in `tz`, as an ISO instant. */
function dayStartISO(now: Date, tz: string): string {
  const p = zonedParts(now, tz);
  return zonedToUtc(p.y, p.m, p.d, 0, 0, tz).toISOString();
}

type DigestStore = Pick<Store, "userStats" | "listApplications" | "listChatThreads">;

/** Today's numbers plus what waits for the human: the review queue (stale items first) and chats. */
export function buildDigest(store: DigestStore, user: User, tz: string, now: Date, panelUrl: string): string {
  const st = store.userStats(user.id, dayStartISO(now, tz));
  const lines = [`Сегодня: отправлено ${st.sent} · в очередь ${st.byStatus.QUEUED ?? 0} · пропущено ${st.skipped} · ошибок ${st.failed}`];
  const chat = [
    st.chatReplies && `${st.chatReplies} ${plural(st.chatReplies, ["ответ бота", "ответа бота", "ответов бота"])}`,
    st.invitations && `${st.invitations} ${plural(st.invitations, ["приглашение", "приглашения", "приглашений"])}`,
    st.rejections && `${st.rejections} ${plural(st.rejections, ["отказ", "отказа", "отказов"])}`,
  ].filter(Boolean);
  if (chat.length) lines.push(`Чаты: ${chat.join(" · ")}`);

  const queued = store.listApplications({ userId: user.id, status: [Status.QUEUED], page: 1, pageSize: 200 });
  if (queued.total) {
    lines.push(`\nВ очереди на проверку: ${queued.total}${panelUrl ? ` · ${panelUrl}/u/${user.slug}/queue` : ""}`);
    const staleBefore = now.getTime() - STALE_DAYS * 86_400_000;
    const stale = queued.items
      .filter((r) => Date.parse(r.application.createdAt) < staleBefore)
      .sort((a, b) => a.application.createdAt.localeCompare(b.application.createdAt));
    if (stale.length) {
      lines.push(`Протухают (старше ${STALE_DAYS} дн.): ${stale.length}`);
      for (const r of stale.slice(0, 5)) {
        const days = Math.floor((now.getTime() - Date.parse(r.application.createdAt)) / 86_400_000);
        lines.push(`• ${r.vacancy.title} · ${r.vacancy.company} (${days} дн.)`);
      }
    }
  }
  const human = store.listChatThreads(user.id, "needs_human");
  if (human.length) {
    lines.push(`\nЧаты ждут тебя: ${human.length}${panelUrl ? ` · ${panelUrl}/u/${user.slug}/chats` : ""}`);
    for (const t of human.slice(0, 5)) lines.push(`• ${t.employer}`);
  }
  return lines.join("\n");
}

/** One line per QUEUED item, oldest first, for /queue. */
export function queueList(store: Pick<Store, "listApplications">, user: User, panelUrl: string): string {
  const { items, total } = store.listApplications({ userId: user.id, status: [Status.QUEUED], page: 1, pageSize: 200 });
  if (!total) return `${user.name}: очередь пуста`;
  const rows = [...items].sort((a, b) => a.application.createdAt.localeCompare(b.application.createdAt)).slice(0, 30);
  return [
    `${user.name}: в очереди ${total}${panelUrl ? ` · ${panelUrl}/u/${user.slug}/queue` : ""}`,
    ...rows.map((r) => `• ${r.vacancy.title} · ${r.vacancy.company}`),
    ...(total > rows.length ? [`… и ещё ${total - rows.length}`] : []),
  ].join("\n");
}

/** The day to send the digest for, or null: once per day, at or after `at` (HH:MM, "" = off) in `tz`. */
export function digestDue(at: string, lastDay: string, now: Date, tz: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(at);
  if (!m) return null;
  const day = dayInTz(now, tz);
  if (day === lastDay) return null;
  const p = zonedParts(now, tz);
  return p.h * 60 + p.mi >= Number(m[1]) * 60 + Number(m[2]) ? day : null;
}
