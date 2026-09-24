import { describe, expect, it } from "vitest";
import { defaultProfile } from "../../src/config/profile.js";
import { harness } from "./fakes.js";

describe("knowledge base API", () => {
  it("tags with counts, status update syncs the profile, stories CRUD + confirm, other users' stories are 404", async () => {
    const h = await harness();
    const u = h.store.getUserBySlug("yaroslav")!;
    const other = h.store.upsertUser({ ...u, id: undefined, slug: "other", name: "Other" });
    h.store.saveProfile(u.id, { ...defaultProfile(), verified_skills: ["Go"] });
    const go = h.store.upsertKbTag(u.id, { name: "Go", aliases: ["golang"], status: "yes" });
    const seed = h.store.saveKbStory({ userId: u.id, title: "Сервис", company: "X", period: "", context: "", did: "Писал на Go", result: "", source: "seed", confirmed: false, hash: "h1", tagIds: [go.id] });
    const foreign = h.store.saveKbStory({ userId: other.id, title: "Чужая", company: "", period: "", context: "", did: "x", result: "", source: "panel", confirmed: false, hash: "", tagIds: [] });

    const tags = await (await h.get("/api/users/yaroslav/kb/tags")).json();
    expect(tags).toEqual([expect.objectContaining({ name: "Go", aliases: ["golang"], status: "yes", storyCount: 1 })]);

    // create: title from the text, new tag becomes `yes` (a human wrote the story), existing `yes` tag kept
    const created = await h.json("POST", "/api/users/yaroslav/kb/stories", { did: "Настроил дашборды. Потом алерты.", tags: ["Grafana", "golang"] });
    expect(created.status).toBe(201);
    const story = await created.json();
    expect(story).toMatchObject({ title: "Настроил дашборды.", source: "panel", confirmed: true });
    expect(story.tags.map((t: { name: string }) => t.name)).toEqual(["Go", "Grafana"]);
    expect(h.store.getProfile(u.id)!.verified_skills).toEqual(["Go", "Grafana"]);
    expect((await h.json("POST", "/api/users/yaroslav/kb/stories", { did: "" })).status).toBe(400);

    const byTag = await (await h.get(`/api/users/yaroslav/kb/stories?tag=${go.id}`)).json();
    expect(byTag.map((s: { id: number }) => s.id)).toEqual([story.id, seed.id]);

    const edited = await (await h.json("PUT", `/api/users/yaroslav/kb/stories/${seed.id}`, { result: "Работает", tags: ["Go"] })).json();
    expect(edited).toMatchObject({ id: seed.id, result: "Работает", did: "Писал на Go", hash: "h1", confirmed: false, source: "seed" });
    expect((await (await h.json("POST", `/api/users/yaroslav/kb/stories/${seed.id}/confirm`)).json()).confirmed).toBe(true);

    const grafana = h.store.listKbTags(u.id).find((t) => t.name === "Grafana")!;
    const put = await (await h.json("PUT", `/api/users/yaroslav/kb/tags/${grafana.id}`, { status: "no" })).json();
    expect(put).toMatchObject({ id: grafana.id, status: "no" });
    expect(h.store.getProfile(u.id)).toMatchObject({ verified_skills: ["Go"], never_claim_skills: ["Grafana"] });
    expect((await h.json("PUT", `/api/users/yaroslav/kb/tags/${grafana.id}`, { status: "maybe" })).status).toBe(400);
    expect((await h.json("PUT", "/api/users/other/kb/tags/" + grafana.id, { status: "yes" })).status).toBe(404);

    expect((await h.json("PUT", `/api/users/yaroslav/kb/stories/${foreign.id}`, { title: "x" })).status).toBe(404);
    expect((await h.json("DELETE", `/api/users/yaroslav/kb/stories/${foreign.id}`)).status).toBe(404);
    expect((await h.json("DELETE", `/api/users/yaroslav/kb/stories/${story.id}`)).status).toBe(200);
    expect(await (await h.get("/api/users/yaroslav/kb/stories")).json()).toHaveLength(1);
  });

  it("editing a story keeps the status of the tags already on it; only newly added ones become `yes`", async () => {
    const h = await harness();
    const u = h.store.getUserBySlug("yaroslav")!;
    h.store.saveProfile(u.id, { ...defaultProfile(), verified_skills: ["Docker"] });
    const docker = h.store.upsertKbTag(u.id, { name: "Docker", status: "yes" });
    const k8s = h.store.upsertKbTag(u.id, { name: "Kubernetes" });
    const s = h.store.saveKbStory({ userId: u.id, title: "Деплой", company: "", period: "", context: "", did: "Докер", result: "", source: "seed", confirmed: false, hash: "h", tagIds: [docker.id, k8s.id] });
    // the panel editor re-sends the full tag list with a typo fix
    expect((await h.json("PUT", `/api/users/yaroslav/kb/stories/${s.id}`, { did: "Docker", tags: ["Docker", "Kubernetes", "Grafana"] })).status).toBe(200);
    const status = (n: string) => h.store.listKbTags(u.id).find((t) => t.name === n)!.status;
    expect([status("Kubernetes"), status("Grafana")]).toEqual(["unknown", "yes"]);
    expect(h.store.getProfile(u.id)!.verified_skills).toEqual(["Docker", "Grafana"]);
  });

  it("a panel edit of the profile skill lists moves the KB tags, so the next sync keeps it", async () => {
    const h = await harness();
    const u = h.store.getUserBySlug("yaroslav")!;
    h.store.saveProfile(u.id, { ...defaultProfile(), verified_skills: ["Go"], never_claim_skills: ["Kafka"] });
    const kafka = h.store.upsertKbTag(u.id, { name: "Kafka", status: "no" });
    const go = h.store.upsertKbTag(u.id, { name: "Go", status: "yes" });
    const put = await h.json("PUT", "/api/users/yaroslav/profile", { ...defaultProfile(), verified_skills: ["Kafka"], never_claim_skills: ["Go"] });
    expect(put.status).toBe(200);
    expect(h.store.listKbTags(u.id).map((t) => [t.id, t.status])).toEqual([[go.id, "no"], [kafka.id, "yes"]]);
    await h.json("PUT", `/api/users/yaroslav/kb/tags/${kafka.id}`, { status: "yes" }); // any later sync
    expect(h.store.getProfile(u.id)).toMatchObject({ verified_skills: ["Kafka"], never_claim_skills: ["Go"] });
    // dropped from both lists -> unknown, not re-added
    await h.json("PUT", "/api/users/yaroslav/profile", { ...defaultProfile(), verified_skills: [], never_claim_skills: [] });
    expect(h.store.listKbTags(u.id).map((t) => t.status)).toEqual(["unknown", "unknown"]);
    expect(h.store.getProfile(u.id)).toMatchObject({ verified_skills: [], never_claim_skills: [] });
  });
});
