// userAnalytics: every dashboard aggregate in one pass of small GROUP BY queries.
// Bot replies = outgoing messages WITHOUT hh_message_id (history imported from hh carries one).
import type { AnalyticsCount, AnalyticsDTO, AnalyticsDay, AnalyticsEvent } from "@sgz/shared";
import { salaryBand } from "./salary.js";
import { num, str, type Param, type Row, type Sql } from "./sql.js";

/** Messages the bot itself sent: no hh id (they're inserted locally) and not hh's «Отклик на вакансию» placeholder. */
export const BOT_OUT = "m.direction='out' AND m.hh_message_id IS NULL AND m.text NOT LIKE 'Отклик на вакансию%'";

const DAY_MS = 24 * 3600 * 1000;

// ponytail: keyword buckets over free-form LLM reasons; move to an LLM-returned reason code if buckets drift.
const REJECT_BUCKETS: [string, RegExp][] = [
  ["не разработка", /не\s+(it|айти|разработ|программ|инженер)|не\s+связан|продаж|маркетолог|менеджер\s+по|дизайнер|поддержк|оператор/i],
  ["уровень / опыт", /senior|lead|лид|сеньор|head|architect|архитект|уровен|старш|опыт|\d\+?\s*(лет|год)/i],
  ["стек", /стек|stack|технолог|навык|язык|1с|1c|php|c\+\+|\.net|c#|ruby|swift|kotlin|java\b|scala|rust|flutter|android|ios/i],
  ["формат / локация", /офис|релок|переезд|город|локац|гибрид|страна|регион/i],
  ["зарплата", /зарплат|оклад|доход|salary|вилк/i],
];

function rejectBucket(reason: string): string {
  for (const [label, re] of REJECT_BUCKETS) if (re.test(reason)) return label;
  return "другое";
}

const counts = (rows: Row[]): AnalyticsCount[] =>
  rows.map((r) => ({ key: str(r.k) || "—", n: num(r.n), ...(r.hh === undefined ? {} : { hh: num(r.hh), resp: num(r.resp), inv: num(r.inv), pass: num(r.pass) }) }));

/** Per-key conversion columns over SENT rows `a`/`v`: only hh sends have negotiation threads, so rates use
 * `hh` as the denominator. "Responded" matches the funnel (thread viewed / invited / rejected). */
export const threadIs = (states: string) =>
  `EXISTS (SELECT 1 FROM chat_threads t WHERE t.user_id = a.user_id AND t.vacancy_id = a.vacancy_id AND t.state IN (${states}))`;
const passedIt = "EXISTS (SELECT 1 FROM chat_threads t WHERE t.user_id = a.user_id AND t.vacancy_id = a.vacancy_id AND t.interview_outcome IN ('next','offer'))";
const RATE_COLS = `SUM(v.source = 'hh') AS hh, SUM(${threadIs("'viewed','invited','rejected'")}) AS resp, SUM(${threadIs("'invited'")}) AS inv, SUM(${passedIt}) AS pass`;

export function userAnalytics(s: Sql, userId: number, sinceISO: string | null): AnalyticsDTO {
  const since = sinceISO ?? "";
  const one = (sql: string, ...p: Param[]): Row => s.get(sql, ...p) ?? {};
  const top = (sql: string, ...p: Param[]): AnalyticsCount[] => counts(s.all(sql, ...p));

  // ---- daily series (UTC days)
  const byDay = new Map<string, AnalyticsDay>();
  const day = (d: string): AnalyticsDay => {
    let x = byDay.get(d);
    if (!x) byDay.set(d, (x = { day: d, sent: 0, skipped: 0, failed: 0, msgs_in: 0, bot_out: 0, llm_calls: 0 }));
    return x;
  };
  for (const r of s.all(
    `SELECT substr(created_at,1,10) AS d, SUM(status='SENT') AS sent, SUM(status GLOB 'SKIP_*') AS skipped,
       SUM(status GLOB 'FAILED_*') AS failed
     FROM applications WHERE user_id = ? AND created_at >= ? GROUP BY d`,
    userId,
    since,
  )) Object.assign(day(str(r.d)), { sent: num(r.sent), skipped: num(r.skipped), failed: num(r.failed) });
  for (const r of s.all(
    `SELECT substr(m.created_at,1,10) AS d, SUM(m.direction='in') AS i, SUM(${BOT_OUT}) AS o
     FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
     WHERE t.user_id = ? AND m.created_at >= ? GROUP BY d`,
    userId,
    since,
  )) Object.assign(day(str(r.d)), { msgs_in: num(r.i), bot_out: num(r.o) });
  for (const r of s.all(
    `SELECT substr(l.created_at,1,10) AS d, COUNT(*) AS n FROM llm_calls l JOIN runs r ON r.id = l.run_id
     WHERE r.user_id = ? AND l.created_at >= ? GROUP BY d`,
    userId,
    since,
  )) day(str(r.d)).llm_calls = num(r.n);

  // gap-fill from range start (or first data day) to today so the x-axis is continuous
  const today = new Date().toISOString().slice(0, 10);
  const first = sinceISO ? sinceISO.slice(0, 10) : [...byDay.keys()].sort()[0];
  const daily: AnalyticsDay[] = [];
  if (first) for (let t = Date.parse(first); t <= Date.parse(today); t += DAY_MS) daily.push(day(new Date(t).toISOString().slice(0, 10)));

  // ---- KPIs
  const sum = (k: keyof AnalyticsDay) => daily.reduce((a, d) => a + (d[k] as number), 0);
  const sent = sum("sent");
  const th = one(
    `SELECT COUNT(*) AS n, SUM(state IN ('viewed','invited','rejected')) AS resp, SUM(state='invited') AS inv,
       SUM(state='rejected') AS rej, SUM(interview_outcome IN ('next','offer')) AS passed,
       SUM(interview_outcome = 'offer') AS offers FROM chat_threads WHERE user_id = ? AND last_seen_at >= ?`,
    userId,
    since,
  );
  const res = one("SELECT COUNT(*) AS n, SUM(is_generated) AS g FROM hh_resumes WHERE user_id = ?", userId);
  const llm = one(
    `SELECT COUNT(*) AS n, SUM(l.ok = 0) AS bad, SUM(l.prompt_chars) AS pc, SUM(l.result_chars) AS rc, AVG(l.duration_ms) AS ms
     FROM llm_calls l JOIN runs r ON r.id = l.run_id WHERE r.user_id = ? AND l.created_at >= ?`,
    userId,
    since,
  );
  const runs = one(
    "SELECT COUNT(*) AS n, SUM(json_extract(stats_json,'$.found')) AS found FROM runs WHERE user_id = ? AND started_at >= ?",
    userId,
    since,
  );
  // career applies pick a CV without a stored Decision, so a SENT row counts as decided+approved too
  const dec = one(
    `SELECT COUNT(DISTINCT vacancy_id) AS n,
       COUNT(DISTINCT CASE WHEN status='SENT' OR json_extract(llm_decision_json,'$.apply') THEN vacancy_id END) AS ok
     FROM applications WHERE user_id = ? AND created_at >= ? AND (llm_decision_json IS NOT NULL OR status='SENT')`,
    userId,
    since,
  );
  const responded = num(th.resp);

  // ---- breakdowns over SENT applications
  const sentFrom = (join = "") =>
    `FROM applications a JOIN vacancies v ON v.id = a.vacancy_id ${join} WHERE a.user_id = ? AND a.status = 'SENT' AND a.created_at >= ?`;
  const sentBy = (expr: string, join = "", rates = false) =>
    top(`SELECT ${expr} AS k, COUNT(*) AS n${rates ? `, ${RATE_COLS}` : ""} ${sentFrom(join)} GROUP BY 1 ORDER BY n DESC, k LIMIT 10`, userId, since);

  const rejects = new Map<string, number>();
  for (const r of s.all("SELECT reason_detail FROM applications WHERE user_id = ? AND status = 'SKIP_LLM_REJECT' AND created_at >= ?", userId, since)) {
    const b = rejectBucket(str(r.reason_detail));
    rejects.set(b, (rejects.get(b) ?? 0) + 1);
  }

  const recent: AnalyticsEvent[] = s
    .all(
      `SELECT a.created_at AS at, 'sent' AS kind, v.title AS title, v.company AS detail ${sentFrom()}
       UNION ALL
       SELECT m.created_at, CASE WHEN m.direction='in' THEN 'employer' ELSE 'bot' END, t.employer, substr(m.text,1,160)
       FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
       WHERE t.user_id = ? AND m.created_at >= ? AND (m.direction='in' OR (${BOT_OUT}))
       ORDER BY at DESC LIMIT 20`,
      userId,
      since,
      userId,
      since,
    )
    .map((r) => ({ at: str(r.at), kind: str(r.kind) as AnalyticsEvent["kind"], title: str(r.title), detail: str(r.detail) }));

  return {
    since: sinceISO,
    kpi: {
      sent,
      skipped: sum("skipped"),
      failed: sum("failed"),
      negotiations: num(th.n),
      responded,
      response_rate: sent ? responded / sent : null,
      invitations: num(th.inv),
      rejections: num(th.rej),
      employer_messages: sum("msgs_in"),
      bot_replies: sum("bot_out"),
      needs_human_open: num(one("SELECT COUNT(*) AS n FROM chat_threads WHERE user_id = ? AND state = 'needs_human'", userId).n),
      resumes_total: num(res.n),
      resumes_generated: num(res.g),
      llm_calls: num(llm.n),
      llm_failed: num(llm.bad),
      llm_prompt_chars: num(llm.pc),
      llm_result_chars: num(llm.rc),
      llm_avg_ms: Math.round(num(llm.ms)),
      runs: num(runs.n),
    },
    daily,
    funnel: [
      { key: "found", n: num(runs.found) },
      { key: "decided", n: num(dec.n) },
      { key: "approved", n: num(dec.ok) },
      { key: "sent", n: sent },
      { key: "viewed", n: responded },
      { key: "invited", n: num(th.inv) },
      // tapped by the seeker after the interview (Telegram «как прошло?» or the panel)
      { key: "passed", n: num(th.passed) },
      { key: "offer", n: num(th.offers) },
    ],
    skip_reasons: top(
      "SELECT status AS k, COUNT(*) AS n FROM applications WHERE user_id = ? AND created_at >= ? AND status GLOB 'SKIP_*' GROUP BY k ORDER BY n DESC",
      userId,
      since,
    ),
    companies: top(
      `SELECT MAX(v.company) AS k, COUNT(*) AS n, ${RATE_COLS} ${sentFrom()} GROUP BY CASE WHEN v.company_key <> '' THEN v.company_key ELSE v.company END
       ORDER BY n DESC, k LIMIT 10`,
      userId,
      since,
    ),
    sources: sentBy(
      "CASE WHEN v.source IN ('hh','habr') THEN v.source ELSE 'career · ' || COALESCE(cs.ats, v.source) END",
      "LEFT JOIN career_sites cs ON cs.user_id = a.user_id AND cs.slug = v.source",
      true,
    ),
    resumes: sentBy(
      "COALESCE(r.title, CASE WHEN a.generated_resume_id IS NOT NULL THEN 'PDF под вакансию' END, '')",
      "LEFT JOIN hh_resumes r ON r.id = a.hh_resume_id",
      true,
    ),
    directions: sentBy("COALESCE(NULLIF(a.direction,''), json_extract(a.llm_decision_json,'$.direction'), '')", "", true),
    reject_reasons: [...rejects].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
    work_formats: sentBy("v.work_format"),
    areas: sentBy("v.area"),
    llm_tasks: top(
      `SELECT l.task AS k, COUNT(*) AS n FROM llm_calls l JOIN runs r ON r.id = l.run_id
       WHERE r.user_id = ? AND l.created_at >= ? GROUP BY k ORDER BY n DESC`,
      userId,
      since,
    ),
    recent,
    salary: salaryBand(s, { userId }),
  };
}
