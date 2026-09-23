import { describe, expect, it } from "vitest";
import { RunBusyError, Status, type RunRequest } from "@sgz/shared";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { formatQueueCard, handleQueueTap, parseQueueCallback, queueButtons, startPendingSend } from "./queue-cards.js";

function setup() {
  const store = openStore(":memory:");
  seedDefaultUsers(store);
  const user = store.listUsers(true)[0]!;
  const queue = (ext: string) => {
    const v = store.upsertVacancy({ source: "acme", externalId: ext, url: `https://acme.ru/${ext}`, title: "Go dev", company: "Acme", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "" });
    return store.insertApplication({ userId: user.id, vacancyId: v.id, hhResumeId: null, generatedResumeId: null, runId: 0, status: Status.QUEUED, reasonDetail: "", direction: "", coverLetter: "", llmDecision: null }).id;
  };
  const started: RunRequest[] = [];
  let busy = false;
  const runner = {
    active: () => (busy ? ({ id: 1 } as never) : null),
    start: async (r: RunRequest) => {
      if (busy) throw new RunBusyError();
      started.push(r);
      return started.length;
    },
  };
  return { store, user, queue, started, runner, setBusy: (b: boolean) => (busy = b) };
}

describe("telegram queue cards", () => {
  it("round-trips callback data within Telegram's 64 bytes", () => {
    const [send, skip] = queueButtons(123456);
    expect(parseQueueCallback(send!.data)).toEqual({ send: true, id: 123456 });
    expect(parseQueueCallback(skip!.data)).toEqual({ send: false, id: 123456 });
    expect(parseQueueCallback("s:1:1:go")).toBeNull();
    expect(Buffer.byteLength(send!.data)).toBeLessThanOrEqual(64);
  });

  it("escapes HTML and trims the letter", () => {
    const card = formatQueueCard({ title: "Go <dev>", company: "A&B", url: "https://x.ru/1", salaryFrom: 200000, salaryTo: 0, currency: "RUR" }, "подходит", "П".repeat(500), "http://pi/u/y/queue#app-1");
    expect(card).toContain("Go &lt;dev&gt;");
    expect(card).toContain("A&amp;B");
    expect(card).toContain("от 200 000 RUR");
    expect(card).toContain("…");
    expect(card).toContain("http://pi/u/y/queue#app-1");
  });

  it("skips, sends, and ignores a second tap", async () => {
    const { store, user, queue, started, runner } = setup();
    const a = queue("1");
    const b = queue("2");
    expect(await handleQueueTap(store, runner, { send: false, id: a })).toMatch(/пропущено/);
    expect(store.getApplication(a)!.application.status).toBe(Status.SKIP_MANUAL);
    expect(await handleQueueTap(store, runner, { send: true, id: a })).toMatch(/уже обработано/);
    expect(await handleQueueTap(store, runner, { send: true, id: b })).toMatch(/отправляю/);
    expect(started).toEqual([{ userSlug: user.slug, source: "career", stage: `send:${b}`, dryRun: false, limit: 0, trigger: "manual" }]);
  });

  it("parks a send while the runner is busy and starts it later", async () => {
    const { store, queue, started, runner, setBusy } = setup();
    const a = queue("1");
    const b = queue("2");
    setBusy(true);
    expect(await handleQueueTap(store, runner, { send: true, id: a })).toMatch(/занят/);
    await handleQueueTap(store, runner, { send: true, id: b });
    await expect(startPendingSend(store, runner)).rejects.toThrow(RunBusyError); // stays parked after a race
    setBusy(false);
    store.updateApplicationStatus(a, Status.SKIP_MANUAL, "skipped in panel"); // handled elsewhere meanwhile
    expect(await startPendingSend(store, runner)).toBe(true);
    expect(started.map((r) => r.stage)).toEqual([`send:${b}`]);
    expect(await startPendingSend(store, runner)).toBe(false);
  });
});
