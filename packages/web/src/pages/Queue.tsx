import type { QueueItemDTO } from "@sgz/shared";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useApplicationAction, useQueue } from "../api/hooks";
import { RunProgress, runStartError } from "../components/RunProgress";
import { Empty, Section, Spinner } from "../components/Ui";
import { fmtRel, fmtSalary } from "../lib/format";
import { toast } from "../lib/toast";

type Answer = { text?: string; option_idx?: number; option_idxs?: number[] };

function answerText(q: { options?: string[] }, raw: unknown): string {
  const a = (raw ?? {}) as Answer;
  if (a.option_idxs?.length) return a.option_idxs.map((i) => q.options?.[i] ?? `#${i}`).join(", ");
  if (a.option_idx !== undefined) return q.options?.[a.option_idx] ?? `#${a.option_idx}`;
  return a.text ?? "—";
}

function QueueCard({ item, slug }: { item: QueueItemDTO; slug: string }) {
  const act = useApplicationAction();
  const [letter, setLetter] = useState(item.cover_letter);
  const [runId, setRunId] = useState<number | null>(null);
  const dirty = letter.trim() !== item.cover_letter.trim();
  const v = item.vacancy;

  const saveLetter = () => act.mutateAsync({ id: item.id, action: "cover-letter", text: letter });
  const start = async (action: "send" | "inspect" | "retailor") => {
    try {
      if (dirty) await saveLetter();
      const r = await act.mutateAsync({ id: item.id, action });
      if (r.run_id) setRunId(r.run_id);
      toast.ok(action === "send" ? "Отправка запущена" : action === "inspect" ? "Проверка формы запущена" : "Пересобираю CV и письмо");
    } catch (e) {
      runStartError(e);
    }
  };
  const skip = () => act.mutate({ id: item.id, action: "skip" }, { onError: runStartError });

  const form: [string, string][] = [
    ["Имя", item.form.full_name],
    ["Email", item.form.email],
    ["Телефон", item.form.phone],
    ["Файл CV", item.form.cv_file_name],
    ["Письмо", letter.trim() ? "текст ниже" : "—"],
  ];

  return (
    <section id={`app-${item.id}`} className="card p-3 grid gap-3 min-w-0 scroll-mt-4">
      <div className="min-w-0">
        <a href={v.url} target="_blank" rel="noreferrer" className="text-[15px] font-semibold break-words">
          {v.title}
        </a>
        <div className="text-[12px] muted flex flex-wrap gap-x-2">
          <span>{v.company}</span>
          {item.site && <span>· {item.site.name}</span>}
          {v.area && <span>· {v.area}</span>}
          {v.work_format && <span>· {v.work_format}</span>}
          {(v.salary_from > 0 || v.salary_to > 0) && <span>· {fmtSalary(v.salary_from, v.salary_to, v.currency)}</span>}
          <span className="faint">· {fmtRel(item.created_at)}</span>
        </div>
        {item.reason && <div className="text-[13px] mt-1">Claude: {item.reason}</div>}
        {item.detail && <div className="text-[12px] faint mt-0.5">{item.detail}</div>}
      </div>

      <div className="grid gap-3 lg:grid-cols-2 min-w-0">
        <div className="grid gap-1 min-w-0">
          {item.pdf_url ? (
            <>
              <iframe src={`${item.pdf_url}#view=FitH`} loading="lazy" title={`CV ${v.title}`} className="w-full h-[420px] sm:h-[560px] rounded border border-[var(--border)] bg-white" />
              <a href={item.pdf_url} target="_blank" rel="noreferrer" className="text-[12px]">
                Открыть PDF
              </a>
            </>
          ) : (
            <Empty>PDF нет</Empty>
          )}
        </div>

        <div className="grid gap-3 content-start min-w-0">
          <label className="block">
            <span className="label">Сопроводительное письмо</span>
            <textarea className="input w-full" rows={8} value={letter} onChange={(e) => setLetter(e.target.value)} />
          </label>
          <div className="flex gap-1.5">
            <button type="button" className="btn btn-sm" disabled={!dirty || !letter.trim() || act.isPending} onClick={() => saveLetter().then(() => toast.ok("Письмо сохранено"))}>
              Сохранить письмо
            </button>
            {dirty && (
              <button type="button" className="btn btn-sm" onClick={() => setLetter(item.cover_letter)}>
                Отменить
              </button>
            )}
          </div>

          <div>
            <div className="section-title">Что будет заполнено</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
              {form.map(([k, val]) => (
                <div key={k} className="contents">
                  <dt className="muted">{k}</dt>
                  <dd className="break-all">{val || "—"}</dd>
                </div>
              ))}
            </dl>
          </div>

          {item.questionnaire.length > 0 && (
            <div>
              <div className="section-title">Вопросы формы и ответы бота</div>
              <ol className="grid gap-1.5 text-[13px] list-decimal pl-5">
                {item.questionnaire.map((qa, i) => (
                  <li key={i}>
                    <div>
                      {qa.question.text}
                      {qa.question.required && <span className="faint"> *</span>}
                    </div>
                    <div className="muted">{answerText(qa.question, qa.answer)}</div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className="btn btn-primary" disabled={act.isPending || !letter.trim()} onClick={() => start("send")}>
          Отправить
        </button>
        <button type="button" className="btn" disabled={act.isPending} onClick={() => start("inspect")}>
          Проверить форму
        </button>
        <button type="button" className="btn" disabled={act.isPending} onClick={() => start("retailor")}>
          Пересобрать CV
        </button>
        <button type="button" className="btn btn-danger" disabled={act.isPending} onClick={skip}>
          Пропустить
        </button>
        {runId && <RunProgress slug={slug} runId={runId} />}
      </div>
    </section>
  );
}

export function QueuePage() {
  const { slug = "" } = useParams();
  const q = useQueue(slug);
  // Telegram cards link to /queue#app-<id>: the list loads async, so scroll once it's there.
  const loaded = Boolean(q.data);
  useEffect(() => {
    if (loaded && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [loaded]);
  if (q.isLoading) return <Spinner />;
  const items = q.data ?? [];
  return (
    <div className="grid gap-4">
      <p className="text-[13px] muted">Отклики на сайты компаний. Ничего не отправляется без кнопки «Отправить».</p>
      {items.length ? (
        items.map((it) => <QueueCard key={it.id} item={it} slug={slug} />)
      ) : (
        <Section>
          <Empty>Очередь пуста</Empty>
        </Section>
      )}
    </div>
  );
}
