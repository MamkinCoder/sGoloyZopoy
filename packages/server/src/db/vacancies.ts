import type { Store, Vacancy } from "@sgz/shared";
import { companyKey, normalizeDedup } from "@sgz/shared";
import { bool, num, str, strOrNull, type Row, type Sql, nowISO } from "./sql.js";

export const mapVacancy = (r: Row): Vacancy => ({
  id: num(r.id),
  source: str(r.source),
  externalId: str(r.external_id),
  url: str(r.url),
  title: str(r.title),
  company: str(r.company),
  salaryFrom: num(r.salary_from),
  salaryTo: num(r.salary_to),
  currency: str(r.currency),
  descriptionText: str(r.description_text),
  hasTest: bool(r.has_test),
  requiresLetter: bool(r.requires_letter),
  area: str(r.area),
  workFormat: str(r.work_format),
  publishedAt: strOrNull(r.published_at),
  firstSeenAt: str(r.first_seen_at),
  lastSeenAt: str(r.last_seen_at),
  archived: bool(r.archived),
  dedupHash: str(r.dedup_hash),
});

/** Columns prefixed `v_` so joins can carry a vacancy next to another row. */
export const VACANCY_COLS = [
  "id",
  "source",
  "external_id",
  "url",
  "title",
  "company",
  "salary_from",
  "salary_to",
  "currency",
  "description_text",
  "has_test",
  "requires_letter",
  "area",
  "work_format",
  "published_at",
  "first_seen_at",
  "last_seen_at",
  "archived",
  "dedup_hash",
]
  .map((c) => `v.${c} AS v_${c}`)
  .join(", ");

export const mapPrefixedVacancy = (r: Row): Vacancy => {
  const sub: Row = {};
  for (const [k, v] of Object.entries(r)) if (k.startsWith("v_")) sub[k.slice(2)] = v;
  return mapVacancy(sub);
};

type VacanciesRepo = Pick<
  Store,
  | "upsertVacancy"
  | "getVacancy"
  | "findVacancyByExternal"
  | "hasRecentApplicationByDedup"
  | "countRecentApplicationsByCompany"
  | "companyLockDirection"
>;

export function vacanciesRepo(s: Sql): VacanciesRepo {
  const getVacancy = (id: number): Vacancy | null => {
    const r = s.get("SELECT * FROM vacancies WHERE id = ?", id);
    return r ? mapVacancy(r) : null;
  };
  return {
    upsertVacancy(v) {
      const dedupHash = v.dedupHash || normalizeDedup(v.company, v.title);
      const companyKeyVal = companyKey(v.company);
      const now = nowISO();
      const vals = [
        v.source,
        v.externalId,
        v.url,
        v.title,
        v.company,
        v.salaryFrom,
        v.salaryTo,
        v.currency,
        v.descriptionText,
        v.hasTest,
        v.requiresLetter,
        v.area,
        v.workFormat,
        v.publishedAt,
        v.archived,
        dedupHash,
        companyKeyVal,
      ];
      if (v.id !== undefined) {
        // A listing-only upsert must not wipe a description fetched earlier.
        const { changes } = s.run(
          `UPDATE vacancies SET source=?, external_id=?, url=?, title=?, company=?, salary_from=?, salary_to=?,
             currency=?, description_text=CASE WHEN ?='' THEN description_text ELSE ? END, has_test=?,
             requires_letter=?, area=?, work_format=?, published_at=?, archived=?, dedup_hash=?, company_key=?,
             last_seen_at=?
           WHERE id=?`,
          v.source,
          v.externalId,
          v.url,
          v.title,
          v.company,
          v.salaryFrom,
          v.salaryTo,
          v.currency,
          v.descriptionText,
          v.descriptionText,
          v.hasTest,
          v.requiresLetter,
          v.area,
          v.workFormat,
          v.publishedAt,
          v.archived,
          dedupHash,
          companyKeyVal,
          now,
          v.id,
        );
        if (!changes) throw new Error(`vacancy ${v.id} not found`);
        return getVacancy(v.id) as Vacancy;
      }
      const r = s.get(
        `INSERT INTO vacancies (source, external_id, url, title, company, salary_from, salary_to, currency,
           description_text, has_test, requires_letter, area, work_format, published_at, archived, dedup_hash,
           company_key, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source, external_id) DO UPDATE SET
           url=excluded.url, title=excluded.title, company=excluded.company, salary_from=excluded.salary_from,
           salary_to=excluded.salary_to, currency=excluded.currency,
           description_text=CASE WHEN excluded.description_text='' THEN vacancies.description_text
                                 ELSE excluded.description_text END,
           has_test=excluded.has_test, requires_letter=excluded.requires_letter, area=excluded.area,
           work_format=excluded.work_format, published_at=excluded.published_at, archived=excluded.archived,
           dedup_hash=excluded.dedup_hash, company_key=excluded.company_key, last_seen_at=excluded.last_seen_at
         RETURNING *`,
        ...vals,
        now,
        now,
      );
      return mapVacancy(r as Row);
    },
    getVacancy,
    findVacancyByExternal(source, externalId) {
      const r = s.get("SELECT * FROM vacancies WHERE source = ? AND external_id = ?", source, externalId);
      return r ? mapVacancy(r) : null;
    },
    hasRecentApplicationByDedup(userId, dedupHash, sinceISO) {
      if (!dedupHash) return false;
      const r = s.get(
        `SELECT 1 AS x FROM applications a JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.user_id = ? AND v.dedup_hash = ? AND a.status IN ('SENT','QUEUED') AND a.created_at >= ? LIMIT 1`,
        userId,
        dedupHash,
        sinceISO,
      );
      return r !== undefined;
    },
    countRecentApplicationsByCompany(userId, key, sinceISO) {
      if (!key) return 0;
      const r = s.get(
        `SELECT COUNT(*) AS n FROM applications a JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.user_id = ? AND v.company_key = ? AND a.status IN ('SENT','QUEUED') AND a.created_at >= ?`,
        userId,
        key,
        sinceISO,
      );
      return num((r as Row).n);
    },
    companyLockDirection(userId, key, sinceISO) {
      if (!key) return "";
      const r = s.get(
        `SELECT a.direction AS direction FROM applications a JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.user_id = ? AND v.company_key = ? AND a.status IN ('SENT','QUEUED') AND a.created_at >= ?
         ORDER BY a.created_at ASC, a.id ASC LIMIT 1`,
        userId,
        key,
        sinceISO,
      );
      return r ? str(r.direction) : "";
    },
  };
}
