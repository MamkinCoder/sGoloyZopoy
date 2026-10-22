import { afterEach, expect, it, vi } from "vitest";
import { cvSyncJob } from "../../src/agent/chats/cvsync.js";
import { chatHarness } from "./harness.js";

let h: ReturnType<typeof chatHarness>;
afterEach(() => {
  h?.store.close();
  h = undefined as never;
});

it("hh: confirmed skills are added where they fit (LLM plan, guarded), denied ones are taken off, the report goes to the user", async () => {
  h = chatHarness(); // verified: Go, React; never_claim: Kafka
  h.store.upsertHHResume({ userId: h.user.id, hhResumeId: "r1", title: "Go-разработчик", url: "", direction: "go-backend", summary: { direction: "go-backend", seniority: "", key_skills: ["Go"], one_line: "" }, isGenerated: false, syncedAt: "" });
  const hh = h.hh as unknown as Record<string, unknown>;
  hh.readResumeSkills = vi.fn(async () => ["Go", "Kafka"]);
  hh.setResumeSkills = vi.fn(async () => undefined);
  // The model also proposes a skill nobody confirmed: the guard drops it.
  h.llm.onJson = () => [{ id: "r1", add: ["React", "Haskell"] }];
  await cvSyncJob(h.env, h.user.id);
  expect(hh.setResumeSkills).toHaveBeenCalledWith(expect.anything(), "r1", ["Go", "React"]);
  expect(h.store.listHHResumes(h.user.id)[0]!.summary!.key_skills).toEqual(["Go", "React"]);
  const [title, body] = h.notifier.alert.mock.calls.at(-1)!;
  expect(title).toBe("Резюме обновлены по твоим навыкам");
  expect(body).toContain("+React");
  expect(body).toContain("−Kafka");
});

it("nothing to change: no edit, no LLM call", async () => {
  h = chatHarness();
  h.store.upsertHHResume({ userId: h.user.id, hhResumeId: "r1", title: "Fullstack", url: "", direction: "fullstack", summary: null, isGenerated: false, syncedAt: "" });
  const hh = h.hh as unknown as Record<string, unknown>;
  hh.readResumeSkills = vi.fn(async () => ["Go", "React", "Docker"]);
  hh.setResumeSkills = vi.fn(async () => undefined);
  await cvSyncJob(h.env, h.user.id);
  expect(hh.setResumeSkills).not.toHaveBeenCalled();
  expect(h.llm.calls.filter((c) => c.method === "json")).toHaveLength(0);
  expect(h.notifier.alert.mock.calls.at(-1)![1]).toContain("уже актуальны");
});
