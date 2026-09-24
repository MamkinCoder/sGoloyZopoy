import { Hono } from "hono";
import type { ChatTask, ChatTaskDTO, ChatThreadDTO, StudyDTO } from "@sgz/shared";
import type { ApiDeps } from "../deps.js";
import { badRequest, HttpError, notFound } from "../errors.js";
import { startStudy, studyStatus } from "../../runner/study.js";
import { InterviewSchema, OutcomeSchema, parseBody } from "../validate.js";
import { idParam, userOr404 } from "./common.js";

const taskDTO = (t: ChatTask): ChatTaskDTO => ({
  id: t.id,
  state: t.state,
  kind: t.kind,
  pending: t.topics.filter((x) => x.answer === null).map((x) => x.name),
  topics: t.topics,
  draft: t.draft,
  last_error: t.lastError,
  updated_at: t.updatedAt,
});

export function chatRoutes({ store, llm, agent }: ApiDeps): Hono {
  const r = new Hono();

  r.get("/users/:slug/chats", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const threads = store.listChatThreads(u.id, c.req.query("state") || undefined);
    const tasks = agent?.tasks(u.id) ?? new Map<number, ChatTask>();
    // The study pack (~15 KB with the prompt) comes from GET …/study; the list only says whether one exists.
    const out: ChatThreadDTO[] = threads.map(({ study, ...t }) => {
      const msgs = store.listChatMessages(t.id);
      const v = t.vacancyId === null ? null : store.getVacancy(t.vacancyId);
      return {
        ...t,
        has_study: !!study,
        task: tasks.has(t.id) ? taskDTO(tasks.get(t.id)!) : null,
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

  // Post-interview outcome (also tapped in Telegram): feeds the funnel and per-resume conversion.
  r.put("/users/:slug/chats/:id/outcome", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const id = idParam(c);
    if (!store.listChatThreads(u.id).some((t) => t.id === id)) throw notFound(`chat not found: ${id}`);
    const b = await parseBody(c, OutcomeSchema);
    store.setInterviewOutcome(id, b.outcome);
    return c.json(store.listChatThreads(u.id).find((t) => t.id === id));
  });

  const ownThread = (slug: string | undefined, id: number) => {
    const t = store.listChatThreads(userOr404(store, slug).id).find((x) => x.id === id);
    if (!t) throw notFound(`chat not found: ${id}`);
    return t;
  };

  // Interview study pack: POST starts the build in the background (one LLM call), GET is polled for it.
  r.post("/users/:slug/chats/:id/study", (c) => {
    const t = ownThread(c.req.param("slug"), idParam(c));
    if (t.vacancyId === null) throw badRequest("у диалога нет вакансии");
    if (!llm) throw new HttpError(503, "LLM недоступен");
    startStudy(store, llm, t.id).catch(() => undefined); // the failure is reported by GET
    return c.json({ generating: true }, 202);
  });

  r.get("/users/:slug/chats/:id/study", (c) => {
    const t = ownThread(c.req.param("slug"), idParam(c));
    return c.json({ pack: t.study ?? null, ...studyStatus(t.id) } satisfies StudyDTO);
  });

  return r;
}
