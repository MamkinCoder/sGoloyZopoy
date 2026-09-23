import type {
  Answer,
  Application,
  ApplicationFilter,
  ApplicationRow,
  Decision,
  Question,
  QuestionnaireAnswer,
  Store,
} from "@sgz/shared";
import { basename } from "node:path";
import {
  json,
  jsonObjOrNull,
  num,
  numOrNull,
  placeholders,
  str,
  toJson,
  type Param,
  type Row,
  type Sql,
  nowISO,
} from "./sql.js";
import { VACANCY_COLS, mapPrefixedVacancy } from "./vacancies.js";

export const mapApplication = (r: Row): Application => ({
  id: num(r.id),
  userId: num(r.user_id),
  vacancyId: num(r.vacancy_id),
  hhResumeId: numOrNull(r.hh_resume_id),
  generatedResumeId: numOrNull(r.generated_resume_id),
  runId: num(r.run_id),
  attempt: num(r.attempt),
  status: str(r.status) as Application["status"],
  reasonDetail: str(r.reason_detail),
  coverLetter: str(r.cover_letter),
  llmDecision: jsonObjOrNull<Decision>(r.llm_decision_json),
  direction: str(r.direction),
  createdAt: str(r.created_at),
});

const ROW_SELECT = `SELECT a.*, ${VACANCY_COLS}, hr.title AS resume_title, gr.tex_path AS gen_tex_path
  FROM applications a
  JOIN vacancies v ON v.id = a.vacancy_id
  LEFT JOIN hh_resumes hr ON hr.id = a.hh_resume_id
  LEFT JOIN generated_resumes gr ON gr.id = a.generated_resume_id`;

const mapRow = (r: Row): ApplicationRow => ({
  application: mapApplication(r),
  vacancy: mapPrefixedVacancy(r),
  resumeTitle: str(r.resume_title) || (r.gen_tex_path ? basename(str(r.gen_tex_path), ".tex") : ""),
});

/** "hh" and site slugs match exactly; "career" means every non-hh source. */
export function sourceClause(alias: string, source: string): { sql: string; params: Param[] } {
  if (source === "career") return { sql: `${alias}.source <> 'hh'`, params: [] };
  return { sql: `${alias}.source = ?`, params: [source] };
}

type ApplicationsRepo = Pick<
  Store,
  | "hasSentApplication"
  | "hasRecentRejection"
  | "lastApplication"
  | "insertApplication"
  | "getApplication"
  | "updateApplicationStatus"
  | "updateApplicationCoverLetter"
  | "touchApplication"
  | "listApplications"
  | "countSentToday"
  | "insertQuestionnaireAnswers"
  | "listQuestionnaireAnswers"
  | "deleteQuestionnaireAnswers"
>;

export function applicationsRepo(s: Sql): ApplicationsRepo {
  return {
    hasSentApplication(userId, vacancyId) {
      return (
        s.get(
          "SELECT 1 AS x FROM applications WHERE user_id = ? AND vacancy_id = ? AND status IN ('SENT','QUEUED','SKIP_MANUAL') LIMIT 1",
          userId,
          vacancyId,
        ) !== undefined
      );
    },
    hasRecentRejection(userId, vacancyId, sinceISO) {
      return (
        s.get(
          `SELECT 1 AS x FROM applications
           WHERE user_id = ? AND vacancy_id = ? AND status = 'SKIP_LLM_REJECT' AND created_at >= ? LIMIT 1`,
          userId,
          vacancyId,
          sinceISO,
        ) !== undefined
      );
    },
    lastApplication(userId, vacancyId) {
      const r = s.get("SELECT * FROM applications WHERE user_id = ? AND vacancy_id = ? ORDER BY id DESC LIMIT 1", userId, vacancyId);
      return r ? mapApplication(r as Row) : null;
    },
    insertApplication(a) {
      // The partial unique index ux_applications_sent rejects a second SENT; that error propagates.
      return s.transaction(() => {
        const r = s.get(
          `INSERT INTO applications (user_id, vacancy_id, hh_resume_id, generated_resume_id, run_id, attempt,
             status, reason_detail, cover_letter, llm_decision_json, direction, created_at)
           VALUES (?,?,?,?,?,
             (SELECT COALESCE(MAX(attempt), 0) + 1 FROM applications WHERE user_id = ? AND vacancy_id = ?),
             ?,?,?,?,?,?)
           RETURNING *`,
          a.userId,
          a.vacancyId,
          a.hhResumeId,
          a.generatedResumeId,
          a.runId,
          a.userId,
          a.vacancyId,
          a.status,
          a.reasonDetail,
          a.coverLetter,
          a.llmDecision ? toJson(a.llmDecision) : null,
          a.direction,
          nowISO(),
        );
        return mapApplication(r as Row);
      });
    },
    getApplication(id) {
      const r = s.get(`${ROW_SELECT} WHERE a.id = ?`, id);
      return r ? mapRow(r) : null;
    },
    updateApplicationStatus(id, status, detail, from) {
      const sql = `UPDATE applications SET status = ?, reason_detail = ? WHERE id = ?${from ? " AND status = ?" : ""}`;
      return s.run(sql, status, detail, id, ...(from ? [from] : [])).changes > 0;
    },
    updateApplicationCoverLetter(id, text) {
      s.run("UPDATE applications SET cover_letter = ? WHERE id = ?", text, id);
    },
    touchApplication(id) {
      s.run("UPDATE applications SET created_at = ? WHERE id = ?", nowISO(), id);
    },
    listApplications(f) {
      const where: string[] = [];
      const params: Param[] = [];
      if (f.userId !== undefined) (where.push("a.user_id = ?"), params.push(f.userId));
      if (f.runId !== undefined) (where.push("a.run_id = ?"), params.push(f.runId));
      if (f.status && f.status.length > 0) {
        where.push(`a.status IN (${placeholders(f.status.length)})`);
        params.push(...f.status);
      }
      if (f.source) {
        const c = sourceClause("v", f.source);
        where.push(c.sql);
        params.push(...c.params);
      }
      if (f.since) (where.push("a.created_at >= ?"), params.push(f.since));
      if (f.until) (where.push("a.created_at < ?"), params.push(f.until));
      if (f.latestPerVacancy) where.push("a.id = (SELECT MAX(b.id) FROM applications b WHERE b.user_id = a.user_id AND b.vacancy_id = a.vacancy_id)");
      if (f.q && f.q.trim()) {
        const like = `%${f.q.trim()}%`;
        where.push("(v.title LIKE ? OR v.company LIKE ?)");
        params.push(like, like);
      }
      const cond = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize ?? 50)));
      const page = Math.max(1, Math.floor(f.page ?? 1));
      const total = num(
        (s.get(`SELECT COUNT(*) AS n FROM applications a JOIN vacancies v ON v.id = a.vacancy_id${cond}`, ...params) as Row).n,
      );
      const items = s
        .all(
          `${ROW_SELECT}${cond} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
          ...params,
          pageSize,
          (page - 1) * pageSize,
        )
        .map(mapRow);
      return { items, total };
    },
    // QUEUED/SKIP_MANUAL only exist for career sites, where the daily limit means "queued per day".
    // created_at is UTC ISO; the runner passes the local day's UTC bounds.
    countSentToday(userId, source, sinceISO, untilISO) {
      const c = sourceClause("v", source);
      const r = s.get(
        `SELECT COUNT(*) AS n FROM applications a JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.user_id = ? AND a.status IN ('SENT','QUEUED','SKIP_MANUAL') AND ${c.sql} AND a.created_at >= ? AND a.created_at < ?`,
        userId,
        ...c.params,
        sinceISO,
        untilISO,
      );
      return num((r as Row).n);
    },
    insertQuestionnaireAnswers(applicationId, qs: Question[], as: Answer[]) {
      const byIdx = new Map(as.map((a) => [a.idx, a]));
      s.transaction(() => {
        qs.forEach((q, i) => {
          const a = byIdx.get(q.idx) ?? as[i] ?? { idx: q.idx };
          s.run(
            "INSERT INTO questionnaire_answers (application_id, question_json, answer_json, created_at) VALUES (?,?,?,?)",
            applicationId,
            toJson(q),
            toJson(a),
            nowISO(),
          );
        });
      });
    },
    deleteQuestionnaireAnswers(applicationId) {
      s.run("DELETE FROM questionnaire_answers WHERE application_id = ?", applicationId);
    },
    listQuestionnaireAnswers(applicationId) {
      return s
        .all("SELECT * FROM questionnaire_answers WHERE application_id = ? ORDER BY id", applicationId)
        .map(
          (r): QuestionnaireAnswer => ({
            id: num(r.id),
            applicationId: num(r.application_id),
            question: json<Question>(r.question_json, { idx: 0, text: "", kind: "text", required: false }),
            answer: json<Answer>(r.answer_json, { idx: 0 }),
            createdAt: str(r.created_at),
          }),
        );
    },
  };
}
