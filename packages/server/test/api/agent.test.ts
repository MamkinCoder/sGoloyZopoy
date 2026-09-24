import { describe, expect, it } from "vitest";
import type { ChatTask, Job } from "@sgz/shared";
import { harness } from "./fakes.js";

const job = (id: number, state: Job["state"]): Job => ({ id, kind: "chats.sync", key: "chats.sync", payload: {}, state, priority: 0, runAfter: "2026-09-25T10:00:00.000Z", attempts: 1, maxAttempts: 5, lastError: state === "failed" ? "boom" : "", leaseUntil: null, createdAt: "", updatedAt: "2026-09-25T10:00:00.000Z" });

describe("agent API", () => {
  it("lists jobs, filters by state, rejects a bad state, and is empty without an agent", async () => {
    const jobs = [job(1, "queued"), job(2, "failed")];
    const h = await harness({ agent: { jobs: (s) => jobs.filter((j) => !s || j.state === s), tasks: () => new Map() } });
    expect(await (await h.get("/api/agent/jobs")).json()).toHaveLength(2);
    expect(await (await h.get("/api/agent/jobs?state=failed")).json()).toEqual([
      { id: 2, kind: "chats.sync", key: "chats.sync", state: "failed", attempts: 1, max_attempts: 5, run_after: "2026-09-25T10:00:00.000Z", last_error: "boom", updated_at: "2026-09-25T10:00:00.000Z" },
    ]);
    expect((await h.get("/api/agent/jobs?state=nope")).status).toBe(400);
    expect(await (await (await harness()).get("/api/agent/jobs")).json()).toEqual([]);
  });

  it("chats carry the thread's latest reply task with the topics still waiting", async () => {
    let threadId = 0;
    const task = (): ChatTask => ({ id: 7, userId: 1, threadId, state: "awaiting_review", messageIds: [1], target: "", choices: [], kind: "question", topics: [{ name: "Jest", answer: "yes", by: "human" }, { name: "Vitest", answer: null, by: null }], draft: "", tgMessageId: 5, reminded: false, attempts: 0, lastError: "", createdAt: "", updatedAt: "2026-09-25T10:00:00.000Z" });
    const h = await harness({ agent: { jobs: () => [], tasks: () => new Map([[threadId, task()]]) } });
    const u = h.store.getUserBySlug("yaroslav")!;
    threadId = h.store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: null, employer: "Acme", state: "new", lastSeenAt: "" }).id;
    const [t] = await (await h.get("/api/users/yaroslav/chats")).json();
    expect(t.task).toMatchObject({ id: 7, state: "awaiting_review", pending: ["Vitest"] });
  });
});
