import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Status, type DedupRowDTO, type Run, type RunDTO, type RunEvent, type RunRequest } from "@sgz/shared";
import type { ApiDeps } from "../deps.js";
import { notFound } from "../errors.js";
import { intParam, parseBody, StartRunSchema } from "../validate.js";
import { idParam, toRunDTO, userOr404 } from "./common.js";

const HEARTBEAT_MS = 15_000;
const DEDUP_STATUSES: Status[] = [Status.SKIP_DEDUP, Status.SKIP_ALREADY_APPLIED, Status.SKIP_FILTER];

const isFinished = (r: Run) => r.status !== "queued" && r.status !== "running";

export function runRoutes(deps: ApiDeps): Hono {
  const { store, runner } = deps;
  const r = new Hono();

  const runOr404 = (id: number): Run => {
    const run = store.getRun(id);
    if (!run) throw notFound("run not found");
    return run;
  };
  const dto = (run: Run): RunDTO => toRunDTO(store, run);

  r.get("/runs", (c) => {
    const slug = c.req.query("user");
    const userId = slug && slug !== "all" ? userOr404(store, slug).id : null;
    const limit = c.req.query("limit") ? intParam(c.req.query("limit"), "limit") : 50;
    const cache = new Map<number, string | null>();
    return c.json(store.listRuns(userId, Math.min(limit || 50, 500)).map((run) => toRunDTO(store, run, cache)));
  });

  r.post("/runs", async (c) => {
    const body = await parseBody(c, StartRunSchema);
    if (body.user !== "all") userOr404(store, body.user);
    const req: RunRequest = {
      userSlug: body.user,
      source: body.source,
      dryRun: body.dry_run ?? false,
      limit: body.limit ?? 0,
      trigger: "manual",
    };
    if (body.stage) req.stage = body.stage;
    const id = await runner.start(req); // RunBusyError → 409 via errorHandler
    return c.json({ run_id: id }, 202);
  });

  // Must precede /runs/:id.
  r.get("/runs/active", (c) => {
    const a = runner.active();
    return c.json(a ? dto(a) : null);
  });

  r.get("/runs/:id", (c) => c.json(dto(runOr404(idParam(c)))));

  r.post("/runs/:id/stop", async (c) => {
    runOr404(idParam(c));
    await runner.stop(idParam(c));
    return c.json({ ok: true });
  });

  r.get("/runs/:id/events", (c) => {
    const id = idParam(c);
    runOr404(id);
    const after = c.req.query("after") ? intParam(c.req.query("after"), "after") : 0;
    return c.json(store.listRunEvents(id, after));
  });

  r.get("/runs/:id/events/stream", (c) => {
    const id = idParam(c);
    runOr404(id);
    const afterRaw = c.req.query("after") ?? c.req.header("last-event-id");
    let lastId = afterRaw ? intParam(afterRaw, "after") : 0;

    return streamSSE(c, async (stream) => {
      let open = true;
      let onAbort = () => {};
      const aborted = new Promise<void>((res) => {
        onAbort = res;
      });
      stream.onAbort(() => {
        open = false;
        onAbort();
      });
      const heartbeat = setInterval(() => {
        if (open) void stream.write(`: ping ${Date.now()}\n\n`).catch(() => {});
      }, HEARTBEAT_MS);

      const send = async (e: RunEvent) => {
        if (e.id <= lastId) return;
        lastId = e.id;
        await stream.writeSSE({ event: "run_event", id: String(e.id), data: JSON.stringify(e) });
      };
      const done = async () => {
        const run = store.getRun(id);
        if (run) await stream.writeSSE({ event: "done", id: String(lastId), data: JSON.stringify(dto(run)) });
      };

      try {
        for (const e of store.listRunEvents(id, lastId)) await send(e);
        const current = store.getRun(id);
        if (current && !isFinished(current)) {
          const it = runner.subscribe(id)[Symbol.asyncIterator]();
          const end = { done: true as const, value: undefined };
          while (open) {
            const next = await Promise.race([it.next(), aborted.then(() => end)]);
            if (next.done) break;
            await send(next.value);
          }
          if (!open) void it.return?.().catch(() => {});
        }
        if (open) await done();
      } finally {
        clearInterval(heartbeat);
        open = false;
      }
    });
  });

  r.get("/runs/:id/dedup", (c) => {
    const id = idParam(c);
    runOr404(id);
    const rows = store.listApplications({ runId: id, status: DEDUP_STATUSES, page: 1, pageSize: 200 }).items;
    const out: DedupRowDTO[] = rows.map((row) => ({
      vacancy: { title: row.vacancy.title, company: row.vacancy.company, url: row.vacancy.url },
      reason: row.application.status,
      detail: row.application.reasonDetail,
    }));
    return c.json(out);
  });

  return r;
}
