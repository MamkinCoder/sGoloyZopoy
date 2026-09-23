// Outcome aggregates over SENT applications: per-employer reply history, per-resume conversion and
// sent letters with a known outcome. Plain SQL over applications / chat_threads / chat_messages.
import type { CompanyIntel, LetterOutcome, ResumeStat, Store } from "@sgz/shared";
import { plural } from "../notify/format.js";
import { threadIs } from "./analytics.js";
import { num, placeholders, str, strOrNull, type Sql } from "./sql.js";

/** Below this many sends a company's history is noise: decide never sees it. */
export const INTEL_MIN_SENT = 3;
/** Below this many sends a resume's conversion is noise. */
export const RESUME_STATS_MIN_SENT = 10;
/** No invite / rejection this long after the send counts as silence. */
export const SILENT_AFTER_DAYS = 14;

const HOUR_MS = 3600_000;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

type IntelRepo = Pick<Store, "companyIntel" | "resumeStats" | "letterOutcomes">;

export function intelRepo(s: Sql): IntelRepo {
  return {
    companyIntel(userId, keys) {
      const ks = [...new Set(keys.filter(Boolean))];
      if (!ks.length) return {};
      const rows = s.all(
        `SELECT v.company_key AS k, v.company AS name, a.created_at AS sent_at,
           ${threadIs("'invited'")} AS inv, ${threadIs("'rejected'")} AS rej,
           (SELECT MIN(m.created_at) FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
            WHERE t.user_id = a.user_id AND t.vacancy_id = a.vacancy_id AND m.direction = 'in') AS first_in
         FROM applications a JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.user_id = ? AND a.status = 'SENT' AND v.company_key IN (${placeholders(ks.length)})`,
        userId,
        ...ks,
      );
      const acc = new Map<string, CompanyIntel & { hours: number[] }>();
      for (const r of rows) {
        const k = str(r.k);
        let x = acc.get(k);
        if (!x) acc.set(k, (x = { name: str(r.name), sent: 0, replied: 0, invited: 0, rejected: 0, medianReplyH: null, hours: [] }));
        const firstIn = strOrNull(r.first_in);
        x.sent++;
        x.invited += num(r.inv);
        x.rejected += num(r.rej);
        if (firstIn || num(r.inv) || num(r.rej)) x.replied++;
        const h = firstIn ? (Date.parse(firstIn) - Date.parse(str(r.sent_at))) / HOUR_MS : NaN;
        if (h >= 0) x.hours.push(h); // NaN / negative (imported history older than the row) is skipped
      }
      const out: Record<string, CompanyIntel> = {};
      for (const [k, { hours, ...x }] of acc) out[k] = { ...x, medianReplyH: median(hours) };
      return out;
    },

    resumeStats(userId, sinceISO) {
      return s
        .all(
          `SELECT r.hh_resume_id AS id, r.title AS title, COUNT(*) AS n,
             SUM(${threadIs("'viewed','invited','rejected'")}) AS resp, SUM(${threadIs("'invited'")}) AS inv
           FROM applications a JOIN hh_resumes r ON r.id = a.hh_resume_id
           WHERE a.user_id = ? AND a.status = 'SENT' AND a.created_at >= ?
           GROUP BY r.id ORDER BY n DESC`,
          userId,
          sinceISO,
        )
        .map((r) => ({ hhResumeId: str(r.id), title: str(r.title), sent: num(r.n), resp: num(r.resp), inv: num(r.inv) }));
    },

    letterOutcomes(userId, limit) {
      const silentBefore = new Date(Date.now() - SILENT_AFTER_DAYS * 24 * HOUR_MS).toISOString();
      // hh only: career sends never get a negotiation thread, so their silence says nothing.
      return s
        .all(
          `SELECT v.title AS title, a.cover_letter AS letter, ${threadIs("'invited'")} AS inv
           FROM applications a JOIN vacancies v ON v.id = a.vacancy_id
           WHERE a.user_id = ? AND a.status = 'SENT' AND v.source = 'hh' AND a.cover_letter <> ''
             AND (${threadIs("'invited','rejected'")} OR a.created_at < ?)
           ORDER BY a.created_at DESC LIMIT ?`,
          userId,
          silentBefore,
          limit,
        )
        .map((r): LetterOutcome => ({ title: str(r.title), letter: str(r.letter), invited: num(r.inv) > 0 }));
    },
  };
}

const hours = (h: number): string => (h < 1 ? "<1ч" : h < 48 ? `~${Math.round(h)}ч` : `~${Math.round(h / 24)}д`);

/** One Russian line for decide prompts and cards: «Точка: 4 отклика, 2 приглашения, отвечают ~6ч». */
export function formatIntel(i: CompanyIntel): string {
  const parts = [`${i.sent} ${plural(i.sent, ["отклик", "отклика", "откликов"])}`];
  if (i.invited) parts.push(`${i.invited} ${plural(i.invited, ["приглашение", "приглашения", "приглашений"])}`);
  else parts.push(`${i.replied} ${plural(i.replied, ["ответ", "ответа", "ответов"])}`);
  if (i.rejected) parts.push(`${i.rejected} ${plural(i.rejected, ["отказ", "отказа", "отказов"])}`);
  if (i.medianReplyH !== null) parts.push(`отвечают ${hours(i.medianReplyH)}`);
  return `${i.name}: ${parts.join(", ")}`;
}

/** «Резюме Go-разработчик (id abc): 40 откликов, 6 ответов, 5 приглашений». */
export function formatResumeStat(r: ResumeStat): string {
  const n = (x: number, f: [string, string, string]) => `${x} ${plural(x, f)}`;
  return `Резюме ${r.title} (id ${r.hhResumeId}): ${n(r.sent, ["отклик", "отклика", "откликов"])}, ${n(r.resp, ["ответ", "ответа", "ответов"])}, ${n(r.inv, ["приглашение", "приглашения", "приглашений"])}`;
}
