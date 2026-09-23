import type { CareerSite, SiteProfile, Store } from "@sgz/shared";
import { bool, json, num, str, strOrNull, toJson, type Row, type Sql } from "./sql.js";

export const mapSite = (r: Row): CareerSite => ({
  id: num(r.id),
  userId: num(r.user_id),
  slug: str(r.slug),
  name: str(r.name),
  baseUrl: str(r.base_url),
  ats: str(r.ats) as CareerSite["ats"],
  profile: json<SiteProfile>(r.profile_json, {}),
  enabled: bool(r.enabled),
  lastRunAt: strOrNull(r.last_run_at),
});

type CareerRepo = Pick<Store, "listCareerSites" | "getCareerSite" | "upsertCareerSite" | "deleteCareerSite" | "careerSiteYield">;

export function careerRepo(s: Sql): CareerRepo {
  return {
    listCareerSites(userId, onlyEnabled = false) {
      const rows = onlyEnabled
        ? s.all("SELECT * FROM career_sites WHERE user_id = ? AND enabled = 1 ORDER BY id", userId)
        : s.all("SELECT * FROM career_sites WHERE user_id = ? ORDER BY id", userId);
      return rows.map(mapSite);
    },
    getCareerSite(id) {
      const r = s.get("SELECT * FROM career_sites WHERE id = ?", id);
      return r ? mapSite(r) : null;
    },
    upsertCareerSite(c) {
      const vals = [c.userId, c.slug, c.name, c.baseUrl, c.ats, toJson(c.profile ?? {}), c.enabled, c.lastRunAt];
      if (c.id !== undefined) {
        const { changes } = s.run(
          `UPDATE career_sites SET user_id=?, slug=?, name=?, base_url=?, ats=?, profile_json=?, enabled=?,
             last_run_at=? WHERE id=?`,
          ...vals,
          c.id,
        );
        if (!changes) throw new Error(`career site ${c.id} not found`);
        return mapSite(s.get("SELECT * FROM career_sites WHERE id = ?", c.id) as Row);
      }
      const r = s.get(
        `INSERT INTO career_sites (user_id, slug, name, base_url, ats, profile_json, enabled, last_run_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, slug) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, ats=excluded.ats,
           profile_json=excluded.profile_json, enabled=excluded.enabled, last_run_at=excluded.last_run_at
         RETURNING *`,
        ...vals,
      );
      return mapSite(r as Row);
    },
    deleteCareerSite(id) {
      s.run("DELETE FROM career_sites WHERE id = ?", id);
    },
    careerSiteYield(userId, sinceISO) {
      const out: Record<string, { found: number; queued: number }> = {};
      for (const r of s.all(
        `SELECT v.source AS slug, COUNT(DISTINCT a.vacancy_id) AS found,
           COUNT(DISTINCT CASE WHEN a.status IN ('QUEUED','SENT') THEN a.vacancy_id END) AS queued
         FROM applications a JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.user_id = ? AND a.created_at >= ? AND v.source <> 'hh' GROUP BY v.source`,
        userId,
        sinceISO,
      ))
        out[str(r.slug)] = { found: num(r.found), queued: num(r.queued) };
      return out;
    },
  };
}
