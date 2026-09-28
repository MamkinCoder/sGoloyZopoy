import type { QueueItemDTO } from "@sgz/shared";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useApplicationAction, useQueue } from "../api/hooks";
import { RunProgress, runStartError } from "../components/RunProgress";
import { FitBadge } from "../components/StatusBadge";
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

const SORTS = {
  new: { label: "Сначала новые", cmp: (a: QueueItemDTO, b: QueueItemDTO) => b.created_at.localeCompare(a.created_at) },
  old: { label: "Сначала старые", cmp: (a: QueueItemDTO, b: QueueItemDTO) => a.created_at.localeCompare(b.created_at) },
  fit: { label: "По совпадению", cmp: (a: QueueItemDTO, b: QueueItemDTO) => (b.fit_score ?? -1) - (a.fit_score ?? -1) },
  salary: { label: "По зарплате", cmp: (a: QueueItemDTO, b: QueueItemDTO) => (b.vacancy.salary_to || b.vacancy.salary_from) - (a.vacancy.salary_to || a.vacancy.salary_from) },
  company: { label: "Компания А-Я", cmp: (a: QueueItemDTO, b: QueueItemDTO) => a.vacancy.company.localeCompare(b.vacancy.company, "ru") },
} as const;
type SortKey = keyof typeof SORTS;
const FIT_MINS = [50, 70, 80];
const FILTER_KEYS = ["q", "site", "format", "fit", "how", "sort"];

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));

/** Search / filters / sort for the queue, kept in the query string so a reload keeps them. */
function useQueueView(items: QueueItemDTO[]) {
  const [sp, setSp] = useSearchParams();
  const get = (k: string) => sp.get(k) ?? "";
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };
  const q = get("q");
  const site = get("site");
  const format = get("format");
  const fit = Number(get("fit")) || 0;
  const how = get("how");
  const sort: SortKey = get("sort") in SORTS ? (get("sort") as SortKey) : "new";

  const options = useMemo(
    () => ({
      sites: uniq(items.map((it) => it.site?.name ?? "")),
      formats: uniq(items.map((it) => it.vacancy.work_format)),
      hasFit: items.some((it) => it.fit_score !== null),
      hasSalary: items.some((it) => it.vacancy.salary_from > 0 || it.vacancy.salary_to > 0),
      mixedHow: items.some((it) => it.manual_apply) && items.some((it) => !it.manual_apply),
    }),
    [items],
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // The Telegram link target stays visible whatever the filters say.
    const pinned = location.hash.startsWith("#app-") ? Number(location.hash.slice(5)) : 0;
    return items
      .filter(
        (it) =>
          it.id === pinned ||
          ((!needle || `${it.vacancy.title} ${it.vacancy.company} ${it.site?.name ?? ""} ${it.cover_letter}`.toLowerCase().includes(needle)) &&
            (!site || it.site?.name === site) &&
            (!format || it.vacancy.work_format === format) &&
            (!fit || (it.fit_score ?? 0) >= fit) &&
            (!how || (how === "manual") === it.manual_apply)),
      )
      .sort(SORTS[sort].cmp);
  }, [items, q, site, format, fit, how, sort]);

  const active = FILTER_KEYS.some((k) => sp.has(k));
  const reset = () => {
    const next = new URLSearchParams(sp);
    for (const k of FILTER_KEYS) next.delete(k);
    setSp(next, { replace: true });
  };
  return { q, site, format, fit, how, sort, set, options, visible, active, reset };
}

function QueueToolbar({ view, total }: { view: ReturnType<typeof useQueueView>; total: number }) {
  const { options: o, set } = view;
  const [draft, setDraft] = useState(view.q);
  useEffect(() => {
    const t = setTimeout(() => draft !== view.q && set({ q: draft }), 250);
    return () => clearTimeout(t);
  }, [draft]);
  return (
    <div className="card p-2 flex flex-wrap gap-2 items-center">
      <input className="input flex-1 min-w-[160px]" placeholder="Поиск: вакансия, компания, сайт, письмо" value={draft} onChange={(e) => setDraft(e.target.value)} />
      {o.sites.length > 1 && (
        <select className="input w-auto" value={view.site} onChange={(e) => set({ site: e.target.value })}>
          <option value="">Все сайты</option>
          {o.sites.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}
      {o.formats.length > 1 && (
        <select className="input w-auto" value={view.format} onChange={(e) => set({ format: e.target.value })}>
          <option value="">Любой формат</option>
          {o.formats.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}
      {o.hasFit && (
        <select className="input w-auto" value={view.fit || ""} onChange={(e) => set({ fit: e.target.value })}>
          <option value="">Любое совпадение</option>
          {FIT_MINS.map((m) => (
            <option key={m} value={m}>
              fit {m}+
            </option>
          ))}
        </select>
      )}
      {o.mixedHow && (
        <select className="input w-auto" value={view.how} onChange={(e) => set({ how: e.target.value })}>
          <option value="">Бот и вручную</option>
          <option value="bot">Отправит бот</option>
          <option value="manual">Только вручную</option>
        </select>
      )}
      <select className="input w-auto" value={view.sort} onChange={(e) => set({ sort: e.target.value === "new" ? "" : e.target.value })}>
        {(Object.keys(SORTS) as SortKey[])
          .filter((k) => (k !== "fit" || o.hasFit) && (k !== "salary" || o.hasSalary))
          .map((k) => (
            <option key={k} value={k}>
              {SORTS[k].label}
            </option>
          ))}
      </select>
      <span className="text-[12px] muted whitespace-nowrap">
        {view.visible.length} из {total}
      </span>
      {view.active && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setDraft("");
            view.reset();
          }}
        >
          Сбросить
        </button>
      )}
    </div>
  );
}

function QueueCard({ item, slug, active }: { item: QueueItemDTO; slug: string; active: boolean }) {
  const act = useApplicationAction();
  const [letter, setLetter] = useState(item.cover_letter);
  const [runId, setRunId] = useState<number | null>(null);
  const dirty = letter.trim() !== item.cover_letter.trim();
  const v = item.vacancy;

  const saveLetter = () => act.mutateAsync({ id: item.id, action: "cover-letter", text: letter });
  const start = async (action: "send" | "inspect" | "retailor") => {
    try {
      if (dirty && letter.trim()) await saveLetter();
      const r = await act.mutateAsync({ id: item.id, action });
      if (r.run_id) setRunId(r.run_id);
      toast.ok(action === "send" ? "Отправка запущена" : action === "inspect" ? "Проверка формы запущена" : "Пересобираю CV и письмо");
    } catch (e) {
      runStartError(e);
    }
  };
  const skip = () => act.mutate({ id: item.id, action: "skip" }, { onError: runStartError });
  const markSent = () => act.mutate({ id: item.id, action: "mark-sent" }, { onSuccess: () => toast.ok("Отмечено как отправленное"), onError: runStartError });

  const form: [string, string][] = [
    ["Имя", item.form.full_name],
    ["Email", item.form.email],
    ["Телефон", item.form.phone],
    ["Файл CV", item.form.cv_file_name],
  ];

  return (
    <section id={`app-${item.id}`} className={`card p-3 grid gap-3 min-w-0 scroll-mt-4 ${active ? "outline-2 outline-[var(--accent)]" : ""}`}>
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
          <FitBadge score={item.fit_score} reason={item.fit_reason} />
        </div>
        {item.reason && <div className="text-[13px] mt-1">Claude: {item.reason}</div>}
        {item.fit_reason && <div className="text-[12px] muted mt-0.5">Совпадение: {item.fit_reason}</div>}
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
            <textarea data-key="e" className="input w-full" rows={8} value={letter} onChange={(e) => setLetter(e.target.value)} />
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
        {item.manual_apply ? (
          <a href={v.url} target="_blank" rel="noreferrer" className="btn btn-primary">
            Откликнуться на сайте
          </a>
        ) : (
          <button type="button" data-key="s" className="btn btn-primary" disabled={act.isPending || !letter.trim()} onClick={() => start("send")}>
            Отправить
          </button>
        )}
        <button type="button" className="btn" disabled={act.isPending} onClick={() => start("inspect")}>
          Проверить форму
        </button>
        <button type="button" data-key="r" className="btn" disabled={act.isPending} onClick={() => start("retailor")}>
          Пересобрать CV
        </button>
        <button type="button" className="btn" disabled={act.isPending} onClick={markSent} title="Откликнулся сам на сайте по ссылке">
          Отправил вручную
        </button>
        <button type="button" data-key="x" className="btn btn-danger" disabled={act.isPending} onClick={skip}>
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
  const view = useQueueView(q.data ?? []);
  const [cur, setCur] = useState(0);
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem("sgz_queue_hint") !== "0";
    } catch {
      return true;
    }
  });
  // Telegram cards link to /queue#app-<id>: the list loads async, so scroll once it's there.
  const loaded = Boolean(q.data);
  useEffect(() => {
    if (!loaded || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
    const i = view.visible.findIndex((it) => `#app-${it.id}` === location.hash);
    if (i >= 0) setCur(i);
  }, [loaded]);

  // Desktop triage: j/k move between cards, s send (confirmed), x skip, r rebuild CV, e edit letter, ? hint.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || document.querySelector("[role=dialog]")) return;
      if (e.key === "?") {
        setHint((h) => {
          try {
            localStorage.setItem("sgz_queue_hint", h ? "0" : "1");
          } catch {
            /* not persisted */
          }
          return !h;
        });
        return;
      }
      const cards = [...document.querySelectorAll<HTMLElement>("section[id^='app-']")];
      if (!cards.length) return;
      const i = Math.min(cur, cards.length - 1);
      const btn = (k: string) => cards[i]!.querySelector<HTMLElement>(`[data-key="${k}"]`);
      if (e.key === "j" || e.key === "k") {
        const n = Math.max(0, Math.min(cards.length - 1, i + (e.key === "j" ? 1 : -1)));
        setCur(n);
        cards[n]!.scrollIntoView({ block: "start", behavior: "smooth" });
      } else if (e.key === "s") {
        const title = cards[i]!.querySelector("a")?.textContent ?? "";
        if (btn("s") && confirm(`Отправить отклик: ${title}?`)) btn("s")!.click();
      } else if (e.key === "x" || e.key === "r") btn(e.key)?.click();
      else if (e.key === "e") {
        e.preventDefault();
        btn("e")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur]);

  if (q.isLoading) return <Spinner />;
  const all = q.data ?? [];
  const items = view.visible;
  return (
    <div className="grid gap-4">
      <p className="text-[13px] muted">Отклики на сайты компаний. Ничего не отправляется без кнопки «Отправить».</p>
      {all.length > 1 && <QueueToolbar view={view} total={all.length} />}
      {hint && items.length > 0 && (
        <p className="hidden sm:block text-[12px] faint">
          Клавиши: <span className="kbd">j</span>/<span className="kbd">k</span> - следующая/предыдущая, <span className="kbd">s</span> - отправить, <span className="kbd">x</span> - пропустить,{" "}
          <span className="kbd">r</span> - пересобрать CV, <span className="kbd">e</span> - письмо, <span className="kbd">?</span> - скрыть подсказку
        </p>
      )}
      {items.length ? (
        items.map((it, i) => <QueueCard key={it.id} item={it} slug={slug} active={i === Math.min(cur, items.length - 1)} />)
      ) : (
        <Section>
          <Empty>{all.length ? "Ничего не найдено" : "Очередь пуста"}</Empty>
        </Section>
      )}
    </div>
  );
}
