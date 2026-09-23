import type { GeneratedResume, HHResume, ResumeSummary, Store } from "@sgz/shared";
import { bool, jsonObjOrNull, num, str, toJson, type Row, type Sql, nowISO } from "./sql.js";

const mapHHResume = (r: Row): HHResume => ({
  id: num(r.id),
  userId: num(r.user_id),
  hhResumeId: str(r.hh_resume_id),
  title: str(r.title),
  url: str(r.url),
  direction: str(r.direction),
  summary: jsonObjOrNull<ResumeSummary>(r.summary_json),
  isGenerated: bool(r.is_generated),
  syncedAt: str(r.synced_at),
});

const mapGenerated = (r: Row): GeneratedResume => ({
  id: num(r.id),
  userId: num(r.user_id),
  vacancyId: num(r.vacancy_id),
  texPath: str(r.tex_path),
  pdfPath: str(r.pdf_path),
  model: str(r.model),
  createdAt: str(r.created_at),
});

type ResumesRepo = Pick<
  Store,
  | "upsertHHResume"
  | "listHHResumes"
  | "getHHResumeByHHId"
  | "countHHResumesCreatedToday"
  | "insertGeneratedResume"
  | "listGeneratedResumes"
  | "getGeneratedResume"
>;

export function resumesRepo(s: Sql): ResumesRepo {
  return {
    upsertHHResume(r) {
      const summary = r.summary ? toJson(r.summary) : "{}";
      const syncedAt = r.syncedAt || nowISO();
      if (r.id !== undefined) {
        const { changes } = s.run(
          `UPDATE hh_resumes SET user_id=?, hh_resume_id=?, title=?, url=?, direction=?, summary_json=?,
             is_generated=?, synced_at=? WHERE id=?`,
          r.userId,
          r.hhResumeId,
          r.title,
          r.url,
          r.direction,
          summary,
          r.isGenerated,
          syncedAt,
          r.id,
        );
        if (!changes) throw new Error(`hh resume ${r.id} not found`);
        return mapHHResume(s.get("SELECT * FROM hh_resumes WHERE id = ?", r.id) as Row);
      }
      const row = s.get(
        `INSERT INTO hh_resumes (user_id, hh_resume_id, title, url, direction, summary_json, is_generated,
           synced_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(hh_resume_id) DO UPDATE SET user_id=excluded.user_id, title=excluded.title, url=excluded.url,
           direction=excluded.direction,
           summary_json=CASE WHEN excluded.summary_json='{}' THEN hh_resumes.summary_json ELSE excluded.summary_json END,
           is_generated=excluded.is_generated, synced_at=excluded.synced_at
         RETURNING *`,
        r.userId,
        r.hhResumeId,
        r.title,
        r.url,
        r.direction,
        summary,
        r.isGenerated,
        syncedAt,
        syncedAt,
      );
      return mapHHResume(row as Row);
    },
    listHHResumes(userId) {
      return s.all("SELECT * FROM hh_resumes WHERE user_id = ? ORDER BY id", userId).map(mapHHResume);
    },
    getHHResumeByHHId(hhResumeId) {
      const r = s.get("SELECT * FROM hh_resumes WHERE hh_resume_id = ?", hhResumeId);
      return r ? mapHHResume(r) : null;
    },
    countHHResumesCreatedToday(userId, dayISO) {
      const r = s.get(
        `SELECT COUNT(*) AS n FROM hh_resumes
         WHERE user_id = ? AND is_generated = 1 AND substr(created_at, 1, 10) = ?`,
        userId,
        dayISO.slice(0, 10),
      );
      return num((r as Row).n);
    },
    insertGeneratedResume(g) {
      const r = s.get(
        `INSERT INTO generated_resumes (user_id, vacancy_id, tex_path, pdf_path, model, created_at)
         VALUES (?,?,?,?,?,?) RETURNING *`,
        g.userId,
        g.vacancyId,
        g.texPath,
        g.pdfPath,
        g.model,
        nowISO(),
      );
      return mapGenerated(r as Row);
    },
    listGeneratedResumes(userId) {
      return s
        .all("SELECT * FROM generated_resumes WHERE user_id = ? ORDER BY id DESC", userId)
        .map(mapGenerated);
    },
    getGeneratedResume(id) {
      const r = s.get("SELECT * FROM generated_resumes WHERE id = ?", id);
      return r ? mapGenerated(r) : null;
    },
  };
}
