// Knowledge base panel API: tags (status, story counts) and stories (list by tag, create, edit, confirm, delete).
// Any status change is mirrored into profile.verified_skills / never_claim_skills (kb/write.ts syncProfileSkills).
import { Hono } from "hono";
import { z } from "zod";
import { tagIs, tagKey, type KbStory, type Store, type User } from "@sgz/shared";
import { syncProfileSkills } from "../../kb/write.js";
import type { ApiDeps } from "../deps.js";
import { notFound } from "../errors.js";
import { intParam, parseBody } from "../validate.js";
import { idParam, userOr404 } from "./common.js";

const text = (max: number) => z.string().trim().max(max);
const StoryFields = {
  title: text(200),
  company: text(200),
  period: text(100),
  context: text(2000),
  did: text(4000),
  result: text(2000),
  tags: z.array(z.string().trim().min(1).max(80)).max(20),
};
const NewStorySchema = z.object({
  ...StoryFields,
  title: StoryFields.title.default(""),
  company: StoryFields.company.default(""),
  period: StoryFields.period.default(""),
  context: StoryFields.context.default(""),
  did: StoryFields.did.min(1),
  result: StoryFields.result.default(""),
  tags: StoryFields.tags.default([]),
});
const StoryPatchSchema = z.object({ ...StoryFields, confirmed: z.boolean() }).partial();
const TagPatchSchema = z.object({ status: z.enum(["yes", "no", "unknown"]) });

/** Tag ids for names; a tag the human writes a story about is real experience, so unknown/new become `yes`.
 * Tags already on the story (`onStory`) keep their id and status: the editor re-sends the whole list on any save. */
function humanTagIds(store: Store, userId: number, names: string[], onStory: KbStory["tags"] = []): number[] {
  return names.map((name) => {
    const own = onStory.find((t) => tagKey(t.name) === tagKey(name));
    if (own) return own.id;
    const cur = store.listKbTags(userId).find((t) => tagIs(t, name));
    return cur && cur.status !== "unknown" ? cur.id : store.upsertKbTag(userId, { name, status: "yes" }).id;
  });
}

/** First sentence of the text, for a story added without a title. */
const titleFrom = (s: string) => (s.split(/(?<=[.!?])\s|\n/)[0] ?? s).slice(0, 80).trim();

export function kbRoutes({ store }: ApiDeps): Hono {
  const r = new Hono();

  const storyOr404 = (u: User, id: number): KbStory => {
    const s = store.getKbStory(id);
    if (!s || s.userId !== u.id) throw notFound("story not found");
    return s;
  };

  r.get("/users/:slug/kb/tags", (c) => c.json(store.listKbTags(userOr404(store, c.req.param("slug")).id)));

  r.put("/users/:slug/kb/tags/:id", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const id = idParam(c);
    if (!store.listKbTags(u.id).some((t) => t.id === id)) throw notFound("tag not found");
    const b = await parseBody(c, TagPatchSchema);
    const tag = store.setKbTagStatus(id, b.status);
    syncProfileSkills(store, u.id);
    return c.json(tag);
  });

  r.get("/users/:slug/kb/stories", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const tag = c.req.query("tag");
    return c.json(store.listKbStories(u.id, tag ? intParam(tag, "tag") : undefined));
  });

  r.post("/users/:slug/kb/stories", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const b = await parseBody(c, NewStorySchema);
    const { tags, ...fields } = b;
    const story = store.saveKbStory({ ...fields, title: fields.title || titleFrom(fields.did), userId: u.id, source: "panel", confirmed: true, hash: "", tagIds: humanTagIds(store, u.id, tags) });
    syncProfileSkills(store, u.id);
    return c.json(story, 201);
  });

  r.put("/users/:slug/kb/stories/:id", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const cur = storyOr404(u, idParam(c));
    const { tags, ...patch } = await parseBody(c, StoryPatchSchema);
    const tagIds = tags ? humanTagIds(store, u.id, tags, cur.tags) : cur.tags.map((t) => t.id);
    const story = store.saveKbStory({ ...cur, ...patch, tagIds });
    if (tags) syncProfileSkills(store, u.id);
    return c.json(story);
  });

  r.post("/users/:slug/kb/stories/:id/confirm", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const cur = storyOr404(u, idParam(c));
    return c.json(store.saveKbStory({ ...cur, confirmed: true, tagIds: cur.tags.map((t) => t.id) }));
  });

  r.delete("/users/:slug/kb/stories/:id", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    store.deleteKbStory(storyOr404(u, idParam(c)).id);
    return c.json({ ok: true });
  });

  return r;
}
