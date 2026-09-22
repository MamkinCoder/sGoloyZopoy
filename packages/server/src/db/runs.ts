import type { Run, RunEvent, RunStats, Store } from "@sgz/shared";
import { emptyRunStats } from "@sgz/shared";
import { bool, json, num, numOrNull, str, strOrNull, toJson, type Row, type Sql, nowISO } from "./sql.js";

export const mapRun = (r: Row): Run => ({
  id: num(r.id),
  userId: numOrNull(r.user_id),
  source: str(r.source) as Run["source"],
  trigger: str(r.trigger) as Run["trigger"],
  startedAt: str(r.started_at),
  finishedAt: strOrNull(r.finished_at),
  status: str(r.status) as Run["status"],
  stats: { ...emptyRunStats(), ...json<Partial<RunStats>>(r.stats_json, {}) },
  tgSent: bool(r.tg_sent),
  error: str(r.error),
});

export const mapEvent = (r: Row): RunEvent => {
  const e: RunEvent = {
    id: num(r.id),
    runId: num(r.run_id),
    ts: str(r.ts),
    level: str(r.level) as RunEvent["level"],
    stage: str(r.stage),
    message: str(r.message),
  };
  const data = json<Record<string, unknown> | null>(r.data_json, null);
  if (data) e.data = data;
  return e;
};

type RunsRepo = Pick<Store, "insertRun" | "finishRun" | "getRun" | "listRuns" | "appendRunEvent" | "listRunEvents">;

export function runsRepo(s: Sql): RunsRepo {
  return {
    insertRun(r) {
      const row = s.get(
        `INSERT INTO runs (user_id, source, trigger, started_at, status, stats_json, tg_sent, error)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
        r.userId,
        r.source,
        r.trigger,
        nowISO(),
        r.status,
        toJson(r.stats),
        r.tgSent,
        r.error,
      );
      return mapRun(row as Row);
    },
    finishRun(r) {
      s.run(
        "UPDATE runs SET finished_at = ?, status = ?, stats_json = ?, tg_sent = ?, error = ? WHERE id = ?",
        r.finishedAt ?? nowISO(),
        r.status,
        toJson(r.stats),
        r.tgSent,
        r.error,
        r.id,
      );
    },
    getRun(id) {
      const r = s.get("SELECT * FROM runs WHERE id = ?", id);
      return r ? mapRun(r) : null;
    },
    listRuns(userId, limit) {
      const lim = Math.max(1, Math.floor(limit || 50));
      const rows =
        userId === null
          ? s.all("SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?", lim)
          : s.all("SELECT * FROM runs WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT ?", userId, lim);
      return rows.map(mapRun);
    },
    appendRunEvent(e) {
      const r = s.get(
        "INSERT INTO run_events (run_id, ts, level, stage, message, data_json) VALUES (?,?,?,?,?,?) RETURNING *",
        e.runId,
        nowISO(),
        e.level,
        e.stage,
        e.message,
        e.data ? toJson(e.data) : null,
      );
      return mapEvent(r as Row);
    },
    listRunEvents(runId, afterId) {
      return s
        .all("SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id", runId, afterId)
        .map(mapEvent);
    },
  };
}
