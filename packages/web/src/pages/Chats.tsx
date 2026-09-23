import type { ChatThreadDTO, InterviewOutcome, InterviewPrep } from "@sgz/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useChatMessages, useChats, useSetInterview, useSetOutcome } from "../api/hooks";
import { ThreadStateBadge } from "../components/StatusBadge";
import { Empty, Spinner } from "../components/Ui";
import { fmtDateTime, fmtRel } from "../lib/format";
import { toast } from "../lib/toast";

export function ChatsPage() {
  const { slug = "", id } = useParams();
  const nav = useNavigate();
  const threadId = id ? Number(id) : null;
  const chats = useChats(slug);
  const current = chats.data?.find((t) => t.id === threadId) ?? null;

  const sorted = [...(chats.data ?? [])].sort((a, b) => {
    const pa = a.state === "needs_human" ? 0 : a.unanswered > 0 ? 1 : 2;
    const pb = b.state === "needs_human" ? 0 : b.unanswered > 0 ? 1 : 2;
    return pa - pb || b.lastSeenAt.localeCompare(a.lastSeenAt);
  });

  return (
    <div className="grid gap-3 lg:grid-cols-[360px_minmax(0,1fr)] items-start">
      <div className={`card ${threadId ? "hidden lg:block" : ""}`}>
        <div className="px-3 py-2 border-b border-[var(--border)] text-[13px] font-semibold">
          Диалоги <span className="faint font-normal">{chats.data?.length ?? ""}</span>
        </div>
        {chats.isLoading && <Spinner />}
        {chats.data && chats.data.length === 0 && <Empty>Диалогов нет</Empty>}
        <ul className="max-h-[75vh] overflow-y-auto">
          {sorted.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => nav(`/u/${slug}/chats/${t.id}`)}
                className={`w-full text-left px-3 py-2 border-b border-[var(--border)] hover:bg-[var(--surface-2)] ${t.id === threadId ? "bg-[var(--surface-2)]" : ""} ${t.state === "needs_human" ? "border-l-2 border-l-[var(--human)]" : ""}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-medium truncate flex-1 text-[13px]">{t.employer}</span>
                  {t.unanswered > 0 && (
                    <span className="rounded-full bg-[var(--accent)] text-white text-[11px] px-1.5 min-w-5 text-center" title="Без ответа">
                      {t.unanswered}
                    </span>
                  )}
                </div>
                <div className="muted text-[12px] truncate">{t.vacancy?.title ?? "без вакансии"}</div>
                <div className="flex items-center gap-1.5 mt-1 text-[11px]">
                  <ThreadStateBadge state={t.state} />
                  {t.isBot && <span className="chip py-0">бот</span>}
                  {upcoming(t.interviewAt) && <span className="chip py-0" title="Собеседование">📅 {fmtDateTime(t.interviewAt)}</span>}
                  <span className="faint ml-auto">{fmtRel(t.lastSeenAt)}</span>
                </div>
                {t.last_message && <div className="faint text-[12px] truncate mt-0.5">{t.last_message}</div>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0">
        {threadId == null ? (
          <div className="card hidden lg:block faint text-center py-16">Выберите диалог</div>
        ) : (
          <ThreadView thread={current} threadId={threadId} slug={slug} />
        )}
      </div>
    </div>
  );
}

function ThreadView({ thread, threadId, slug }: { thread: ChatThreadDTO | null; threadId: number; slug: string }) {
  const msgs = useChatMessages(threadId);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [msgs.data?.length]);

  return (
    <div className="card">
      <div className="px-3 py-2 border-b border-[var(--border)] flex flex-wrap items-center gap-2">
        <Link to={`/u/${slug}/chats`} className="lg:hidden muted text-[13px]">
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[13px] truncate">{thread?.employer ?? `Диалог #${threadId}`}</div>
          {thread?.vacancy && (
            <a href={thread.vacancy.url} target="_blank" rel="noreferrer" className="text-[12px] truncate block">
              {thread.vacancy.title} ↗
            </a>
          )}
        </div>
        {thread && <ThreadStateBadge state={thread.state} />}
        {thread?.isBot && <span className="chip">бот</span>}
        {thread && (
          <a href={`https://hh.ru/applicant/negotiations/item?id=${thread.hhNegotiationId}`} target="_blank" rel="noreferrer" className="text-[12px]">
            на hh ↗
          </a>
        )}
      </div>
      {thread?.state === "needs_human" && (
        <div className="px-3 py-2 bg-[var(--human-soft)] text-[var(--human)] text-[13px]">
          Нужен человек: бот не стал отвечать сам. Ответьте на hh.ru вручную.
        </div>
      )}
      {thread && <InterviewBar thread={thread} slug={slug} />}
      {thread?.prep && <PrepCard prep={thread.prep} />}
      <div className="p-3 max-h-[70vh] overflow-y-auto grid gap-2">
        {msgs.isLoading && <Spinner />}
        {msgs.data?.length === 0 && <Empty>Сообщений нет</Empty>}
        {msgs.data?.map((m) => {
          const out = m.direction === "out";
          const flag = m.isQuestion && !m.answered;
          return (
            <div key={m.id} className={`max-w-[85%] ${out ? "justify-self-end" : "justify-self-start"}`}>
              <div
                className={`rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap ${
                  out ? "bg-[var(--accent-soft)]" : flag ? "bg-[var(--human-soft)] border border-[var(--human)]" : "bg-[var(--surface-2)]"
                }`}
              >
                {m.text}
              </div>
              <div className={`faint text-[11px] mt-0.5 ${out ? "text-right" : ""}`}>
                {m.author === "me" ? "мы" : m.author === "bot" ? "бот работодателя" : "работодатель"} · {fmtDateTime(m.createdAt)}
                {flag && <span className="text-[var(--human)]"> · вопрос без ответа</span>}
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
    </div>
  );
}

const upcoming = (iso: string | null | undefined): iso is string => !!iso && Date.parse(iso) > Date.now();

/** ISO -> value for <input type="datetime-local"> in the browser's timezone. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const OUTCOME_LABEL: Record<InterviewOutcome, string> = { next: "Прошёл дальше", rejected: "Отказ", silence: "Тишина", offer: "Оффер" };

/** Interview time: captured by the bot from the chat, or set by hand for a time agreed elsewhere. */
function InterviewBar({ thread, slug }: { thread: ChatThreadDTO; slug: string }) {
  const save = useSetInterview(slug);
  const outcome = useSetOutcome(slug);
  const [value, setValue] = useState(toLocalInput(thread.interviewAt));
  useEffect(() => setValue(toLocalInput(thread.interviewAt)), [thread.interviewAt]);
  const put = (at: string | null) =>
    save.mutate({ id: thread.id, at }, { onSuccess: () => toast.ok(at ? "Время собеседования сохранено, напомню за 2 часа" : "Время собеседования убрано") });
  return (
    <div className="px-3 py-2 border-b border-[var(--border)] flex flex-wrap items-center gap-2 text-[13px]">
      <span className="muted">📅 Собеседование</span>
      <input className="input w-auto" type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Время собеседования" />
      <button
        type="button"
        className="btn btn-sm"
        disabled={save.isPending || !value || value === toLocalInput(thread.interviewAt)}
        onClick={() => put(new Date(value).toISOString())}
      >
        Сохранить
      </button>
      {thread.interviewAt && (
        <button type="button" className="btn btn-sm" disabled={save.isPending} onClick={() => put(null)}>
          Убрать
        </button>
      )}
      {thread.interviewAt && (
        <select
          className="input w-auto"
          aria-label="Итог собеседования"
          value={thread.interviewOutcome ?? ""}
          disabled={outcome.isPending}
          onChange={(e) => outcome.mutate({ id: thread.id, outcome: (e.target.value || null) as InterviewOutcome | null }, { onSuccess: () => toast.ok("Итог сохранён") })}
        >
          <option value="">Итог: не указан</option>
          {(Object.keys(OUTCOME_LABEL) as InterviewOutcome[]).map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABEL[o]}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function PrepCard({ prep }: { prep: InterviewPrep }) {
  const block = (title: string, xs: string[]) =>
    xs.length > 0 && (
      <div>
        <div className="font-semibold mt-2">{title}</div>
        <ul className="list-disc pl-5">
          {xs.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <details className="px-3 py-2 border-b border-[var(--border)] text-[13px]">
      <summary className="cursor-pointer font-semibold">📝 Подготовка к собеседованию</summary>
      {block("Вероятные вопросы", prep.questions)}
      {block("Что рассказать", prep.stories.map((s) => `${s.skill}: ${s.prompt}`))}
      {block("Пробелы и как ответить", prep.gaps)}
      {block("Спросить у них", prep.ask_them)}
    </details>
  );
}
