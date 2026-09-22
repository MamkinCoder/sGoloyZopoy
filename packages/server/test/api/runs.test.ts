import { describe, expect, it } from "vitest";
import { harness } from "./fakes.js";

describe("runs", () => {
  it("creates a run (202), validates body, 409 when busy, 404 unknown user", async () => {
    const h = await harness();
    const res = await h.json("POST", "/api/runs", { user: "yaroslav", source: "hh", dry_run: true, limit: 5 });
    expect(res.status).toBe(202);
    const { run_id } = await res.json();
    expect(h.runner.started[0]).toEqual({ userSlug: "yaroslav", source: "hh", dryRun: true, limit: 5, trigger: "manual" });

    const run = await (await h.get(`/api/runs/${run_id}`)).json();
    expect(run).toMatchObject({ id: run_id, user_slug: "yaroslav", status: "queued", source: "hh" });
    expect(run.stats.dry_run).toBe(true);

    const list = await (await h.get("/api/runs?user=yaroslav&limit=10")).json();
    expect(list).toHaveLength(1);
    expect(await (await h.get("/api/runs/active")).json()).toBeNull();

    expect((await h.json("POST", "/api/runs", { user: "yaroslav", source: "ftp" })).status).toBe(400);
    expect((await h.json("POST", "/api/runs", { user: "ghost", source: "hh" })).status).toBe(404);
    expect((await h.json("POST", "/api/runs", { user: "all", source: "all", stage: "chats" })).status).toBe(202);
    h.runner.busy = true;
    const busy = await h.json("POST", "/api/runs", { user: "yaroslav", source: "hh" });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "a run is already active" });

    const stop = await h.json("POST", `/api/runs/${run_id}/stop`);
    expect(await stop.json()).toEqual({ ok: true });
    expect(h.runner.stopped).toEqual([run_id]);
    expect((await h.get("/api/runs/999")).status).toBe(404);
  });

  it("lists events after an id", async () => {
    const h = await harness();
    const { run_id } = await (await h.json("POST", "/api/runs", { user: "yaroslav", source: "hh" })).json();
    const e1 = h.store.appendRunEvent({ runId: run_id, level: "info", stage: "session", message: "one" });
    h.store.appendRunEvent({ runId: run_id, level: "warn", stage: "search", message: "two" });
    const all = await (await h.get(`/api/runs/${run_id}/events`)).json();
    expect(all.map((e: { message: string }) => e.message)).toEqual(["one", "two"]);
    const after = await (await h.get(`/api/runs/${run_id}/events?after=${e1.id}`)).json();
    expect(after.map((e: { message: string }) => e.message)).toEqual(["two"]);
  });

  it("SSE stream replays backlog, forwards live events, then sends done", async () => {
    const h = await harness();
    const { run_id } = await (await h.json("POST", "/api/runs", { user: "yaroslav", source: "hh" })).json();
    const b1 = h.store.appendRunEvent({ runId: run_id, level: "info", stage: "session", message: "backlog one" });
    h.store.appendRunEvent({ runId: run_id, level: "info", stage: "session", message: "backlog two" });

    const res = await h.get(`/api/runs/${run_id}/events/stream?after=${b1.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const frames = text.split("\n\n").filter((f) => f.trim());
    const events = frames.map((f) => {
      const ev = /^event: (.+)$/m.exec(f)?.[1];
      const id = /^id: (.+)$/m.exec(f)?.[1];
      const data = JSON.parse(/^data: (.+)$/m.exec(f)![1]!);
      return { ev, id, data };
    });
    expect(events.map((e) => e.ev)).toEqual(["run_event", "run_event", "run_event", "done"]);
    expect(events.map((e) => e.data.message ?? e.data.status)).toEqual(["backlog two", "live one", "live two", "done"]);
    expect(events[0]!.id).toBe(String(b1.id + 1));
    expect(events[3]!.data).toMatchObject({ id: run_id, user_slug: "yaroslav", status: "done" });
  });

  it("SSE on a finished run sends backlog + done without subscribing", async () => {
    const h = await harness();
    const { run_id } = await (await h.json("POST", "/api/runs", { user: "yaroslav", source: "hh" })).json();
    h.store.appendRunEvent({ runId: run_id, level: "info", stage: "report", message: "bye" });
    h.store.finishRun({ ...h.store.getRun(run_id)!, status: "failed", error: "boom" });
    const text = await (await h.get(`/api/runs/${run_id}/events/stream`, { headers: { "last-event-id": "0" } })).text();
    expect(text).toContain("event: run_event");
    expect(text).toContain('"message":"bye"');
    expect(text).toContain("event: done");
    expect(text).toContain('"status":"failed"');
    expect((await h.get("/api/runs/999/events/stream")).status).toBe(404);
  });
});
