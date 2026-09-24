import { tagKey, type KbStory, type KbTag, type KbTagStatus } from "@sgz/shared";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useKbMutations, useKbStories, useKbTags, type KbStoryBody } from "../api/hooks";
import { ChipInput } from "../components/ChipInput";
import { Empty, Field, Section, Spinner } from "../components/Ui";
import { fmtDateTime } from "../lib/format";
import { toast } from "../lib/toast";

const STATUS: Record<KbTagStatus, { label: string; cls: string }> = {
  yes: { label: "есть", cls: "text-[var(--ok)]" },
  no: { label: "нет", cls: "text-[var(--bad)]" },
  unknown: { label: "?", cls: "faint" },
};
const SOURCE: Record<KbStory["source"], string> = { seed: "из резюме", telegram: "Telegram", panel: "панель" };
type Filter = "all" | KbTagStatus;
const FILTERS: [Filter, string][] = [["all", "Все"], ["yes", "Есть"], ["no", "Нет"], ["unknown", "Не ясно"]];

function StoryForm({ initial, onSave, onCancel, busy }: { initial: KbStoryBody; onSave: (b: KbStoryBody) => void; onCancel?: () => void; busy: boolean }) {
  const [b, setB] = useState<KbStoryBody>(initial);
  const set = (k: keyof KbStoryBody) => (e: { target: { value: string } }) => setB({ ...b, [k]: e.target.value });
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (b.did?.trim()) onSave(b);
      }}
    >
      <Field label="Название">
        <input className="input" value={b.title ?? ""} onChange={set("title")} placeholder="пусто = первая фраза текста" />
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Компания">
          <input className="input" value={b.company ?? ""} onChange={set("company")} />
        </Field>
        <Field label="Период">
          <input className="input" value={b.period ?? ""} onChange={set("period")} />
        </Field>
      </div>
      <Field label="Контекст">
        <textarea className="input" rows={2} value={b.context ?? ""} onChange={set("context")} />
      </Field>
      <Field label="Что сделал *">
        <textarea className="input" rows={4} value={b.did ?? ""} onChange={set("did")} required />
      </Field>
      <Field label="Результат (цифры только реальные)">
        <textarea className="input" rows={2} value={b.result ?? ""} onChange={set("result")} />
      </Field>
      <Field label="Навыки" hint="Enter или запятая; новый навык сразу помечается «есть»">
        <ChipInput value={b.tags ?? []} onChange={(tags) => setB({ ...b, tags })} />
      </Field>
      <div className="flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !b.did?.trim()}>
          Сохранить
        </button>
        {onCancel && (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
    </form>
  );
}

function StoryCard({ s, slug }: { s: KbStory; slug: string }) {
  const m = useKbMutations(slug);
  const [edit, setEdit] = useState(false);
  if (edit)
    return (
      <div className="card p-3">
        <StoryForm
          initial={{ title: s.title, company: s.company, period: s.period, context: s.context, did: s.did, result: s.result, tags: s.tags.map((t) => t.name) }}
          busy={m.update.isPending}
          onCancel={() => setEdit(false)}
          onSave={(body) => m.update.mutate({ id: s.id, body }, { onSuccess: () => (setEdit(false), toast.ok("Сохранено")) })}
        />
      </div>
    );
  return (
    <article className="card p-3 grid gap-1.5 text-[13px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="font-medium leading-snug">{s.title}</h4>
        <span className="flex gap-1 shrink-0">
          <span className="chip">{SOURCE[s.source]}</span>
          {s.confirmed ? <span className="chip text-[var(--ok)]">подтверждено</span> : <span className="chip faint">не проверено</span>}
        </span>
      </div>
      {(s.company || s.period) && <div className="muted text-[12px]">{[s.company, s.period].filter(Boolean).join(" · ")}</div>}
      {s.context && <p className="muted">{s.context}</p>}
      <p>{s.did}</p>
      {s.result && <p><span className="faint">Результат: </span>{s.result}</p>}
      <div className="flex flex-wrap items-center gap-1">
        {s.tags.map((t) => (
          <span key={t.id} className="chip">{t.name}</span>
        ))}
        <span className="faint text-[11px] ml-auto">{fmtDateTime(s.updatedAt)}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {!s.confirmed && (
          <button type="button" className="btn btn-sm btn-primary" disabled={m.confirm.isPending} onClick={() => m.confirm.mutate(s.id)}>
            Подтвердить
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => setEdit(true)}>
          Изменить
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => window.confirm(`Удалить «${s.title}»?`) && m.remove.mutate(s.id, { onSuccess: () => toast.ok("Удалено") })}>
          Удалить
        </button>
      </div>
    </article>
  );
}

export function KbPage() {
  const { slug = "" } = useParams();
  const tags = useKbTags(slug);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [tagId, setTagId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const stories = useKbStories(slug, tagId);
  const m = useKbMutations(slug);

  const all = tags.data ?? [];
  const tag = all.find((t) => t.id === tagId) ?? null;
  const shown = useMemo(() => {
    const k = tagKey(q);
    return all.filter((t) => (filter === "all" || t.status === filter) && (!k || [t.name, ...t.aliases].some((n) => tagKey(n).includes(k))));
  }, [all, q, filter]);

  if (tags.isLoading) return <Spinner />;
  const count = (f: Filter) => (f === "all" ? all.length : all.filter((t) => t.status === f).length);
  const setStatus = (t: KbTag, status: KbTagStatus) => m.setStatus.mutate({ id: t.id, status });

  return (
    <div className="grid gap-4 md:grid-cols-[300px_minmax(0,1fr)] items-start">
      <Section title={<>Навыки <span className="faint font-normal">{all.length}</span></>}>
        <input className="input mb-2" placeholder="Поиск: go, реакт…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex flex-wrap gap-1 mb-2">
          {FILTERS.map(([f, label]) => (
            <button key={f} type="button" className={`btn btn-sm ${filter === f ? "btn-primary" : ""}`} onClick={() => setFilter(f)}>
              {label} <span className="opacity-70">{count(f)}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-0.5 max-h-[40vh] md:max-h-[70vh] overflow-y-auto -mx-1">
          <button type="button" className={`text-left px-2 py-1.5 rounded text-[13px] ${tagId === null ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-2)]"}`} onClick={() => setTagId(null)}>
            Все истории
          </button>
          {shown.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`flex items-center gap-2 text-left px-2 py-1.5 rounded text-[13px] ${t.id === tagId ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-2)]"}`}
              onClick={() => setTagId(t.id)}
            >
              <span className="flex-1 min-w-0 truncate">{t.name}</span>
              <span className={`text-[11px] ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span>
              <span className="faint text-[11px] w-5 text-right">{t.storyCount}</span>
            </button>
          ))}
          {!shown.length && <Empty>Не найдено</Empty>}
        </div>
      </Section>

      <div className="grid gap-3 min-w-0">
        <Section
          title={tag ? tag.name : "Все истории"}
          right={
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding((v) => !v)}>
              {adding ? "Скрыть" : "+ История"}
            </button>
          }
        >
          {tag && (
            <div className="flex flex-wrap items-center gap-2 mb-2 text-[13px]">
              <span className="muted">Опыт:</span>
              {(["yes", "no", "unknown"] as const).map((st) => (
                <button key={st} type="button" className={`btn btn-sm ${tag.status === st ? "btn-primary" : ""}`} disabled={m.setStatus.isPending} onClick={() => setStatus(tag, st)}>
                  {st === "yes" ? "Есть" : st === "no" ? "Нет навыка" : "Не ясно"}
                </button>
              ))}
              {tag.aliases.length > 0 && <span className="faint text-[12px]">также: {tag.aliases.join(", ")}</span>}
            </div>
          )}
          {adding ? (
            <StoryForm
              key={tagId ?? "all"}
              initial={{ tags: tag ? [tag.name] : [] }}
              busy={m.create.isPending}
              onSave={(body) => m.create.mutate(body, { onSuccess: () => (setAdding(false), toast.ok("История добавлена")) })}
            />
          ) : (
            <div className="faint text-[12px]">
              Истории - единственный материал для писем, ответов работодателям и резюме. Истории из резюме стоит проверить и подтвердить.
            </div>
          )}
        </Section>
        {stories.isLoading ? <Spinner /> : stories.data?.length ? stories.data.map((s) => <StoryCard key={s.id} s={s} slug={slug} />) : <Empty>Историй нет</Empty>}
      </div>
    </div>
  );
}
