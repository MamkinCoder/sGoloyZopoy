// Agent job queue (docs/ARCHITECTURE.md §2). Times are ISO strings passed in by the caller (fake clocks in tests).
import type { EnqueueOptions, Job, JobState } from "@sgz/shared";
import { json, num, str, strOrNull, toJson, type Row, type Sql } from "./sql.js";

const mapJob = (r: Row): Job => ({
  id: num(r.id),
  kind: str(r.kind),
  key: strOrNull(r.key),
  payload: json<Record<string, unknown>>(r.payload_json, {}),
  state: str(r.state) as JobState,
  priority: num(r.priority),
  runAfter: str(r.run_after),
  attempts: num(r.attempts),
  maxAttempts: num(r.max_attempts),
  lastError: str(r.last_error),
  leaseUntil: strOrNull(r.lease_until),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

export interface JobsRepo {
  /** A new queued job, or the open one with the same key (whose run_after moves earlier when asked, or anywhere with `replace`). */
  enqueueJob(kind: string, payload: Record<string, unknown>, opts: EnqueueOptions, nowISO: string): Job;
  getJob(id: number): Job | null;
  /** Queued jobs due at `nowISO`, highest priority first, then oldest. */
  dueJobs(nowISO: string, limit: number): Job[];
  /** queued -> running with a lease; false when someone else took it. */
  claimJob(id: number, leaseUntilISO: string, nowISO: string): boolean;
  finishJob(id: number, nowISO: string): void;
  /** running -> queued at `retryAtISO` (attempts left) or failed (`final`: failed right away). Returns the new state. */
  failJob(id: number, error: string, retryAtISO: string, nowISO: string, final?: boolean): JobState;
  /** Running jobs whose lease passed, except `except` (still running in this process): back to queued. */
  requeueExpired(nowISO: string, except: number[]): number;
  listJobs(state: JobState | undefined, limit: number): Job[];
  /** updated_at of the latest job of `kind` in `state`, or null. */
  lastJobAt(kind: string, state: JobState): string | null;
  /** Deletes finished (done/failed) jobs last updated before `beforeISO`. */
  pruneJobs(beforeISO: string): number;
}

export function jobsRepo(s: Sql): JobsRepo {
  const get = (id: number) => {
    const r = s.get("SELECT * FROM jobs WHERE id = ?", id);
    return r ? mapJob(r) : null;
  };
  return {
    enqueueJob(kind, payload, opts, nowISO) {
      return s.transaction(() => {
        const runAfter = (opts.runAfter ?? new Date(nowISO)).toISOString();
        if (opts.key) {
          const open = s.get("SELECT * FROM jobs WHERE key = ? AND state IN ('queued','running')", opts.key);
          if (open) {
            if (str(open.state) === "queued" && (opts.replace ? runAfter !== str(open.run_after) : runAfter < str(open.run_after))) s.run("UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ?", runAfter, nowISO, open.id);
            return get(num(open.id))!;
          }
        }
        const { lastId } = s.run(
          `INSERT INTO jobs (kind, key, payload_json, state, priority, run_after, max_attempts, created_at, updated_at)
           VALUES (?,?,?,'queued',?,?,?,?,?)`,
          kind,
          opts.key ?? null,
          toJson(payload),
          opts.priority ?? 0,
          runAfter,
          opts.maxAttempts ?? 5,
          nowISO,
          nowISO,
        );
        return get(lastId)!;
      });
    },
    getJob: get,
    dueJobs(nowISO, limit) {
      return s.all("SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? ORDER BY priority DESC, run_after, id LIMIT ?", nowISO, limit).map(mapJob);
    },
    claimJob(id, leaseUntilISO, nowISO) {
      const { changes } = s.run("UPDATE jobs SET state = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = ? AND state = 'queued'", leaseUntilISO, nowISO, id);
      return changes > 0;
    },
    finishJob(id, nowISO) {
      s.run("UPDATE jobs SET state = 'done', lease_until = NULL, last_error = '', updated_at = ? WHERE id = ?", nowISO, id);
    },
    failJob(id, error, retryAtISO, nowISO, final = false) {
      return s.transaction(() => {
        const j = get(id);
        if (!j) return "failed";
        const state: JobState = !final && j.attempts < j.maxAttempts ? "queued" : "failed";
        s.run("UPDATE jobs SET state = ?, run_after = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?", state, state === "queued" ? retryAtISO : j.runAfter, error.slice(0, 1000), nowISO, id);
        return state;
      });
    },
    requeueExpired(nowISO, except) {
      const rows = s.all("SELECT id FROM jobs WHERE state = 'running' AND (lease_until IS NULL OR lease_until < ?)", nowISO);
      let n = 0;
      for (const r of rows) {
        if (except.includes(num(r.id))) continue;
        n += s.run("UPDATE jobs SET state = 'queued', lease_until = NULL, last_error = 'lease expired', updated_at = ? WHERE id = ? AND state = 'running'", nowISO, r.id).changes;
      }
      return n;
    },
    listJobs(state, limit) {
      const rows = state ? s.all("SELECT * FROM jobs WHERE state = ? ORDER BY updated_at DESC, id DESC LIMIT ?", state, limit) : s.all("SELECT * FROM jobs ORDER BY updated_at DESC, id DESC LIMIT ?", limit);
      return rows.map(mapJob);
    },
    lastJobAt(kind, state) {
      const r = s.get("SELECT MAX(updated_at) AS at FROM jobs WHERE kind = ? AND state = ?", kind, state);
      return strOrNull(r?.at);
    },
    pruneJobs(beforeISO) {
      return s.run("DELETE FROM jobs WHERE state IN ('done','failed') AND updated_at < ?", beforeISO).changes;
    },
  };
}
