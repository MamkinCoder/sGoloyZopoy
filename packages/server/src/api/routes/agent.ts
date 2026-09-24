import { Hono } from "hono";
import type { AgentJobDTO, JobState } from "@sgz/shared";
import type { ApiDeps } from "../deps.js";
import { badRequest } from "../errors.js";

const STATES: readonly JobState[] = ["queued", "running", "done", "failed"];

export function agentRoutes({ agent }: ApiDeps): Hono {
  const r = new Hono();

  // The always-on agent's queue, newest first (100 at most): the panel's «Агент» section.
  r.get("/agent/jobs", (c) => {
    const state = c.req.query("state") || undefined;
    if (state && !STATES.includes(state as JobState)) throw badRequest(`state must be one of ${STATES.join(", ")}`);
    const jobs = agent?.jobs(state as JobState | undefined) ?? [];
    return c.json(
      jobs.map(
        (j): AgentJobDTO => ({ id: j.id, kind: j.kind, key: j.key, state: j.state, attempts: j.attempts, max_attempts: j.maxAttempts, run_after: j.runAfter, last_error: j.lastError, updated_at: j.updatedAt }),
      ),
    );
  });

  return r;
}
