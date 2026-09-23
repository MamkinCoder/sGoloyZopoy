// Weekly retro: last 7 days vs the 7 before, which direction to push and which to cut. Plain numbers from
// userAnalytics (no LLM, nothing to hallucinate); for Telegram (retro_day/retro_at, /week) and the Dashboard.
import { Status, type RetroDTO, type Store, type User } from "@sgz/shared";
import { shortStamp, zonedParts } from "../scheduler/tz.js";
import { digestDue } from "./digest.js";

const DAY = 86_400_000;
/** Fewer sends than this in a week: no retro (this week) or no comparison (the week before). */
export const MIN_SENT = 10;
/** hh sends a direction needs before its invite rate means anything. */
export const MIN_N = 5;
/** hh sends with zero answers before a direction is called a mismatch. */
export const MISMATCH_N = 8;
const STALE_QUEUE_DAYS = 3;

type RetroStore = Pick<Store, "userAnalytics" | "listApplications" | "listChatThreads">;

const ratio = (a: number, b: number) => (b ? Math.min(1, a / b) : null);

export function weeklyRetro(store: RetroStore, user: User, now: Date): RetroDTO | null {
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const w = store.userAnalytics(user.id, since);
  if (w.kpi.sent < MIN_SENT) return null;
  // Every KPI is a sum over ">= since", so the week before is the 14-day total minus this week.
  const two = store.userAnalytics(user.id, new Date(now.getTime() - 14 * DAY).toISOString());
  const p = { sent: two.kpi.sent - w.kpi.sent, resp: two.kpi.responded - w.kpi.responded, inv: two.kpi.invitations - w.kpi.invitations };

  const dirs = two.directions.filter((d) => d.key !== "—" && d.hh !== undefined);
  const best = dirs
    .filter((d) => d.hh! >= MIN_N && d.resp! + d.inv! > 0)
    .sort((a, b) => b.inv! / b.hh! - a.inv! / a.hh! || b.resp! / b.hh! - a.resp! / a.hh!)[0];
  const mismatch = dirs.filter((d) => d.hh! >= MISMATCH_N && d.resp === 0).sort((a, b) => b.hh! - a.hh!)[0];

  const staleBefore = now.getTime() - STALE_QUEUE_DAYS * DAY;
  const queued = store.listApplications({ userId: user.id, status: [Status.QUEUED], page: 1, pageSize: 500 }).items;
  const until = now.getTime() + 7 * DAY;
  const interviews = store
    .listChatThreads(user.id)
    .filter((t) => t.interviewAt && Date.parse(t.interviewAt) >= Date.parse(since) && Date.parse(t.interviewAt) <= until)
    .sort((a, b) => a.interviewAt!.localeCompare(b.interviewAt!))
    .map((t) => ({ employer: t.employer, at: t.interviewAt!, state: t.state }));

  return {
    since,
    sent: w.kpi.sent,
    response_rate: ratio(w.kpi.responded, w.kpi.sent),
    invite_rate: ratio(w.kpi.invitations, w.kpi.sent),
    prev: p.sent >= MIN_SENT ? { sent: p.sent, response_rate: ratio(p.resp, p.sent), invite_rate: ratio(p.inv, p.sent) } : null,
    best: best ? { key: best.key, hh: best.hh!, resp: best.resp!, inv: best.inv! } : null,
    mismatch: mismatch ? { key: mismatch.key, hh: mismatch.hh! } : null,
    stale_queue: queued.filter((r) => Date.parse(r.application.createdAt) < staleBefore).length,
    interviews,
  };
}

const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
/** "↑ 5" / "↓ 3 п.п." / "→" against the week before; "" without one. */
export function delta(cur: number | null, prev: number | null | undefined, points = false): string {
  if (cur === null || prev === null || prev === undefined) return "";
  const d = points ? Math.round((cur - prev) * 100) : cur - prev;
  if (d === 0) return " (→)";
  return ` (${d > 0 ? "↑" : "↓"} ${Math.abs(d)}${points ? " п.п." : ""})`;
}

const STATE_LABEL: Record<string, string> = { invited: "приглашение", needs_human: "ждёт тебя", rejected: "отказ", archived: "архив", viewed: "просмотрено", new: "новое" };

export function formatRetro(r: RetroDTO, tz: string): string {
  const lines = [
    `Неделя: отправлено ${r.sent}${delta(r.sent, r.prev?.sent)} · ответы ${pct(r.response_rate)}${delta(r.response_rate, r.prev?.response_rate, true)} · приглашения ${pct(r.invite_rate)}${delta(r.invite_rate, r.prev?.invite_rate, true)}`,
  ];
  if (!r.prev) lines.push(`С прошлой неделей не сравниваю: там меньше ${MIN_SENT} откликов`);
  if (r.best) lines.push(`Лучше всего заходит: ${r.best.key} - приглашения ${r.best.inv} и ответы ${r.best.resp} из ${r.best.hh} откликов за 2 недели, стоит усилить`);
  if (r.mismatch) lines.push(`Не заходит: ${r.mismatch.key} - ${r.mismatch.hh} откликов за 2 недели и ни одного ответа, стоит урезать или сменить резюме`);
  if (r.stale_queue) lines.push(`В очереди дольше ${STALE_QUEUE_DAYS} дн.: ${r.stale_queue}`);
  if (r.interviews.length) {
    lines.push("Собеседования:");
    for (const i of r.interviews) lines.push(`• ${i.employer} · ${shortStamp(new Date(i.at), tz)} (${STATE_LABEL[i.state] ?? i.state})`);
  }
  return lines.join("\n");
}

/** Telegram text, or null when the week is too small to say anything. */
export function buildRetro(store: RetroStore, user: User, tz: string, now: Date): string | null {
  const r = weeklyRetro(store, user, now);
  return r && formatRetro(r, tz);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** digestDue on `day` ("sun".."sat", "" = off) only: the local date to send the retro for, or null. */
export function retroDue(day: string, at: string, lastDay: string, now: Date, tz: string): string | null {
  const p = zonedParts(now, tz);
  if (WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()] !== day) return null;
  return digestDue(at, lastDay, now, tz);
}
