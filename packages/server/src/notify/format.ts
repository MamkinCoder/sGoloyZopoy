// Telegram message bodies (HTML). Russian, terse, no links in the report except the panel + vacancies.
import type { Run, User } from "@sgz/shared";
import { shortStamp } from "../scheduler/tz.js";

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SKIP_LABELS: Record<string, string> = {
  SKIP_TEST_REQUIRED: "тест",
  SKIP_DEDUP: "дедуп",
  SKIP_LLM_REJECT: "LLM",
  SKIP_FILTER: "фильтр",
  SKIP_LIMIT: "лимит",
  SKIP_ALREADY_APPLIED: "уже откликались",
  SKIP_ARCHIVED: "архив",
  SKIP_FOREIGN: "другая страна",
  SKIP_DRY_RUN: "dry-run",
};

export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

const fmtMoney = (n: number): string => n.toLocaleString("ru-RU").replace(/ /g, " ");

export function formatReport(user: User, run: Run, panelUrl: string, tz = "Europe/Moscow"): string {
  const st = run.stats;
  const by = st.by_status;
  const sent = by.SENT ?? 0;
  const skipParts: string[] = [];
  let skipped = 0;
  let failed = 0;
  for (const [k, v] of Object.entries(by)) {
    if (!v) continue;
    if (k.startsWith("SKIP_")) {
      skipped += v;
      skipParts.push(`${v} ${SKIP_LABELS[k] ?? k}`);
    } else if (k.startsWith("FAILED_")) failed += v;
  }
  const lines: string[] = [];
  lines.push(`<b>${escapeHtml(user.name)} · ${escapeHtml(run.source)}</b> · ${shortStamp(new Date(run.startedAt), tz)}${st.dry_run ? " · dry-run" : ""}`);
  lines.push(`Отправлено: ${sent} · Пропущено: ${skipped}${skipParts.length ? ` (${skipParts.join(", ")})` : ""} · Ошибок: ${failed}`);
  const chat: string[] = [];
  if (st.chat_replies) chat.push(`${st.chat_replies} ${plural(st.chat_replies, ["ответ", "ответа", "ответов"])}`);
  if (st.invitations) chat.push(`${st.invitations} ${plural(st.invitations, ["приглашение", "приглашения", "приглашений"])}`);
  if (st.rejections) chat.push(`${st.rejections} ${plural(st.rejections, ["отказ", "отказа", "отказов"])}`);
  if (chat.length) lines.push(`Чаты: ${chat.join(" · ")}`);
  if (run.status !== "done") {
    const label = run.status === "stopped" ? "остановлен" : run.status === "failed" ? "ошибка" : run.status;
    lines.push(`Статус: ${label}${run.error ? ` · ${escapeHtml(run.error)}` : ""}`);
  }
  if (st.top_vacancies.length) {
    lines.push("Топ:");
    for (const t of st.top_vacancies) {
      const salary = t.salary_from || t.salary_to ? ` · ${t.salary_from ? `от ${fmtMoney(t.salary_from)}` : ""}${t.salary_from && t.salary_to ? " " : ""}${t.salary_to ? `до ${fmtMoney(t.salary_to)}` : ""}` : "";
      lines.push(`• <a href="${escapeHtml(t.url)}">${escapeHtml(t.title)}</a> · ${escapeHtml(t.company)}${salary}`);
    }
  }
  if (panelUrl) lines.push(`Панель: ${escapeHtml(panelUrl)}`);
  return lines.join("\n");
}

export function formatAlert(title: string, body: string): string {
  return `<b>${escapeHtml(title)}</b>${body ? `\n${escapeHtml(body)}` : ""}`;
}

/** Split into ≤ max-char chunks on line boundaries (hard split as a last resort). */
export function chunkMessage(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    let l = line;
    while (l.length > max) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(l.slice(0, max));
      l = l.slice(max);
    }
    const candidate = cur ? `${cur}\n${l}` : l;
    if (candidate.length > max) {
      out.push(cur);
      cur = l;
    } else cur = candidate;
  }
  if (cur) out.push(cur);
  return out;
}
