import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type SqliteStore } from "../db/index.js";
import { backoffMs, createAgent, type JobHandler } from "./queue.js";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let store: SqliteStore;
let clock: number;
const now = () => new Date(clock);
const alerts: string[] = [];
const notifier = { alert: async (t: string) => void alerts.push(t) };

beforeEach(() => {
  vi.useFakeTimers();
  store = openStore(":memory:");
  clock = Date.parse("2026-09-25T10:00:00Z");
  alerts.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
});

/** A handler whose runs stay open until released. */
function gated(needs: JobHandler["needs"]) {
  const release: (() => void)[] = [];
  const ran: number[] = [];
  const handler: JobHandler = { needs, run: (job) => new Promise<void>((r) => (ran.push(job.id), release.push(r))) };
  return { handler, ran, releaseAll: () => release.splice(0).forEach((r) => r()) };
}

describe("agent queue", () => {
  it("dedupes by key while open; a second enqueue can only pull run_after earlier", () => {
    const agent = createAgent({ store, handlers: {}, notifier, now, log: silent });
    const a = agent.enqueue("chats.sync", {}, { key: "sync", runAfter: new Date(clock + 60_000) });
    const b = agent.enqueue("chats.sync", {}, { key: "sync", runAfter: new Date(clock + 120_000) });
    expect(b.id).toBe(a.id);
    expect(b.runAfter).toBe(new Date(clock + 60_000).toISOString());
    const c = agent.enqueue("chats.sync", {}, { key: "sync", runAfter: new Date(clock + 30_000) });
    expect(c.id).toBe(a.id);
    expect(c.runAfter).toBe(new Date(clock + 30_000).toISOString());
    expect(agent.enqueue("chats.sync").id).not.toBe(a.id); // no key, no dedupe
  });

  it("runs due jobs by priority, honours run_after, and a done key can be enqueued again", async () => {
    const order: string[] = [];
    const h: JobHandler = { needs: "none", run: async (job) => void order.push(String(job.payload.n)) };
    const agent = createAgent({ store, handlers: { k: h }, notifier, now, log: silent });
    agent.enqueue("k", { n: "late" }, { runAfter: new Date(clock + 5000) });
    agent.enqueue("k", { n: "low" });
    agent.enqueue("k", { n: "high" }, { priority: 5, key: "x" });
    agent.tick();
    await agent.settle();
    expect(order).toEqual(["high", "low"]);
    clock += 5000;
    agent.tick();
    await agent.settle();
    expect(order).toEqual(["high", "low", "late"]);
    expect(agent.enqueue("k", { n: "again" }, { key: "x" }).state).toBe("queued");
  });

  it("one browser job at a time, llm jobs up to the slots, none jobs freely", async () => {
    const browser = gated("browser");
    const llm = gated("llm");
    const none = gated("none");
    const agent = createAgent({ store, handlers: { b: browser.handler, l: llm.handler, n: none.handler }, notifier, now, log: silent, llmSlots: 2 });
    for (let i = 0; i < 3; i++) {
      agent.enqueue("b");
      agent.enqueue("l");
      agent.enqueue("n");
    }
    agent.tick();
    expect(browser.ran).toHaveLength(1);
    expect(llm.ran).toHaveLength(2);
    expect(none.ran).toHaveLength(3);
    agent.tick(); // still busy: nothing new
    expect(browser.ran).toHaveLength(1);
    browser.releaseAll();
    llm.releaseAll();
    await vi.advanceTimersByTimeAsync(0);
    agent.tick();
    expect(browser.ran).toHaveLength(2);
    expect(llm.ran).toHaveLength(3);
    browser.releaseAll();
    llm.releaseAll();
    none.releaseAll();
    await vi.advanceTimersByTimeAsync(0);
    agent.tick();
    browser.releaseAll();
    await agent.settle();
    expect(store.listJobs("done", 20)).toHaveLength(9);
  });

  it("retries with backoff, then fails with one alert per kind and calls onFailed", async () => {
    const onFailed = vi.fn();
    const h: JobHandler = { needs: "none", run: async () => Promise.reject(new Error("boom")), onFailed };
    const agent = createAgent({ store, handlers: { k: h }, notifier, now, log: silent });
    const job = agent.enqueue("k", {}, { maxAttempts: 3 });
    agent.tick();
    await agent.settle();
    expect(store.getJob(job.id)).toMatchObject({ state: "queued", attempts: 1, lastError: "boom" });
    expect(Date.parse(store.getJob(job.id)!.runAfter) - clock).toBe(backoffMs(1));
    agent.tick(); // not due yet
    await agent.settle();
    expect(store.getJob(job.id)!.attempts).toBe(1);
    clock += backoffMs(1);
    agent.tick();
    await agent.settle();
    clock += backoffMs(2);
    agent.tick();
    await agent.settle();
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", attempts: 3 });
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual(["Агент: задача k не выполнена"]);
    // A second failed job of the same kind: no second alert until one succeeds.
    agent.enqueue("k", {}, { maxAttempts: 1 });
    agent.tick();
    await agent.settle();
    expect(alerts).toHaveLength(1);
    expect(backoffMs(30)).toBe(30 * 60_000);
  });

  it("a hung job times out at its lease and frees the browser for the next one", async () => {
    const close = vi.fn(async () => undefined);
    const hang: JobHandler = { needs: "browser", leaseMs: 60_000, run: () => new Promise<void>(() => undefined) };
    const agent = createAgent({ store, handlers: { hang }, notifier, now, log: silent, browser: { close } });
    const job = agent.enqueue("hang", {}, { maxAttempts: 1 });
    agent.tick();
    await vi.advanceTimersByTimeAsync(60_000);
    await agent.settle();
    expect(store.getJob(job.id)).toMatchObject({ state: "failed" });
    expect(store.getJob(job.id)!.lastError).toContain("timeout");
    expect(close).toHaveBeenCalled();
  });

  it("boot requeues jobs a dead process left running; the loop requeues expired leases of others", async () => {
    const job = store.enqueueJob("k", {}, {}, now().toISOString());
    store.claimJob(job.id, new Date(clock + 3600_000).toISOString(), now().toISOString());
    const ran: number[] = [];
    const agent = createAgent({ store, handlers: { k: { needs: "none", run: async (j) => void ran.push(j.id) } }, notifier, now, log: silent, pollMs: 1000 });
    agent.start();
    await agent.settle();
    expect(ran).toEqual([job.id]);
    expect(store.getJob(job.id)!.state).toBe("done");
    // Another row left running with a lease that has passed (not ours): requeued by the loop.
    const other = store.enqueueJob("k", {}, {}, now().toISOString());
    store.claimJob(other.id, new Date(clock - 1).toISOString(), now().toISOString());
    await vi.advanceTimersByTimeAsync(1000);
    await agent.settle();
    expect(store.getJob(other.id)!.state).toBe("done");
    await agent.stop();
  });

  it("closes the browser after the idle time without browser jobs", async () => {
    const close = vi.fn(async () => undefined);
    const agent = createAgent({ store, handlers: { b: { needs: "browser", run: async () => undefined } }, notifier, now, log: silent, browser: { close }, browserIdleMs: 60_000 });
    agent.enqueue("b");
    agent.tick();
    await agent.settle();
    clock += 59_000;
    agent.tick();
    expect(close).not.toHaveBeenCalled();
    clock += 1000;
    agent.tick();
    expect(close).toHaveBeenCalledTimes(1);
    clock += 60_000;
    agent.tick();
    expect(close).toHaveBeenCalledTimes(1); // already closed
  });

  it("schedules enqueue by key: a still-open job is not doubled", async () => {
    const g = gated("browser");
    const agent = createAgent({ store, handlers: { "chats.sync": g.handler }, schedules: [{ kind: "chats.sync", everyMs: 60_000 }], notifier, now, log: silent });
    agent.tick();
    clock += 60_000;
    agent.tick(); // the first sync still runs: same key, no second job
    expect(store.listJobs(undefined, 10)).toHaveLength(1);
    g.releaseAll();
    await agent.settle();
    clock += 60_000;
    agent.tick();
    expect(g.ran).toHaveLength(2);
    g.releaseAll();
    await agent.settle();
  });

  it("an unknown kind fails instead of blocking the queue", () => {
    const agent = createAgent({ store, handlers: {}, notifier, now, log: silent });
    const j = agent.enqueue("gone");
    agent.tick();
    expect(store.getJob(j.id)).toMatchObject({ state: "failed", lastError: "no handler for gone" });
  });
});
