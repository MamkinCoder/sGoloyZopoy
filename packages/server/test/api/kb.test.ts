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
});
