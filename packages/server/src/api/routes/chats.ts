import { Hono } from "hono";
import type { ChatThreadDTO } from "@sgz/shared";
import type { ApiDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import { InterviewSchema, parseBody } from "../validate.js";
import { idParam, userOr404 } from "./common.js";

export function chatRoutes({ store }: ApiDeps): Hono {
  const r = new Hono();

  r.get("/users/:slug/chats", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const threads = store.listChatThreads(u.id, c.req.query("state") || undefined);
    const out: ChatThreadDTO[] = threads.map((t) => {
      const msgs = store.listChatMessages(t.id);
      const v = t.vacancyId === null ? null : store.getVacancy(t.vacancyId);
      return {
        ...t,
        vacancy: v ? { id: v.id, title: v.title, company: v.company, url: v.url } : null,
        unanswered: msgs.filter((m) => m.direction === "in" && m.isQuestion && !m.answered).length,
        last_message: msgs.at(-1)?.text ?? null,
      };
    });
    return c.json(out);
  });

  r.get("/chats/:id/messages", (c) => {
    const id = idParam(c);
    if (id === 0) throw badRequest("invalid id");
    return c.json(store.listChatMessages(id));
  });

  // Interview time agreed outside the bot (phone, e-mail): the serve tick reminds ~2h before it.
  r.put("/users/:slug/chats/:id/interview", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const id = idParam(c);
    if (!store.listChatThreads(u.id).some((t) => t.id === id)) throw notFound(`chat not found: ${id}`);
    const b = await parseBody(c, InterviewSchema);
    store.setChatInterview(id, b.interview_at);
    return c.json(store.listChatThreads(u.id).find((t) => t.id === id));
  });

  return r;
}
