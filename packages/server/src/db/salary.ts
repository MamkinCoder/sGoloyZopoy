// Market salary band over scraped vacancies: one point per posting (fork midpoint, or the single bound),
// percentiles in JS. For the seeker only (Telegram, panel); never sent to employers.
import type { SalaryBand, SalaryQuery } from "@sgz/shared";
import { num, type Param, type Sql } from "./sql.js";

/** Fewer postings than this and the band is noise: return null. */
export const SALARY_MIN_N = 15;
/** Below this a "salary" is an hourly rate or junk. */
const MIN_POINT = 10_000;

/** Nearest-rank percentile over an ascending array. */
const pick = (xs: number[], q: number): number => xs[Math.round(q * (xs.length - 1))]!;

export function salaryBand(s: Sql, q: SalaryQuery, now = new Date()): SalaryBand | null {
  const since = new Date(now.getTime() - (q.days ?? 90) * 86_400_000).toISOString();
  const where = ["v.currency IN ('RUR','RUB')", "(v.salary_from > 0 OR v.salary_to > 0)", "v.last_seen_at >= ?"];
  const params: Param[] = [since];
  if (q.userId !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM applications a WHERE a.vacancy_id = v.id AND a.user_id = ?${
        q.direction ? " AND COALESCE(NULLIF(a.direction,''), json_extract(a.llm_decision_json,'$.direction'), '') = ?" : ""
      })`,
    );
    params.push(q.userId, ...(q.direction ? [q.direction] : []));
  }
  // Title match in JS: SQLite lower()/LIKE are ASCII-only case-insensitive, titles are mostly Cyrillic.
  const needle = q.titleLike?.trim().toLowerCase();
  const points = s
    .all(`SELECT v.title, v.salary_from AS f, v.salary_to AS t FROM vacancies v WHERE ${where.join(" AND ")}`, ...params)
    .filter((r) => !needle || String(r.title).toLowerCase().includes(needle))
    .map((r) => {
      const f = num(r.f);
      const t = num(r.t);
      return f > 0 && t > 0 ? (f + t) / 2 : f || t;
    })
    .filter((p) => p >= MIN_POINT)
    .sort((a, b) => a - b);
  if (points.length < SALARY_MIN_N) return null;
  const k = (x: number) => Math.round(x / 1000) * 1000;
  return { n: points.length, p25: k(pick(points, 0.25)), p50: k(pick(points, 0.5)), p75: k(pick(points, 0.75)) };
}

/** «250-350k, медиана 290k (n=42)». */
export const formatBand = (b: SalaryBand): string => {
  const k = (x: number) => `${Math.round(x / 1000)}k`;
  return `${k(b.p25)}-${k(b.p75)}, медиана ${k(b.p50)} (n=${b.n})`;
};
