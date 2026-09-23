import type { FilteredItemDTO } from "@sgz/shared";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useApplicationAction, useFiltered } from "../api/hooks";
import { RunProgress, runStartError } from "../components/RunProgress";
import { StatusBadge } from "../components/StatusBadge";
import { Empty, Section, Spinner } from "../components/Ui";
import { fmtDateTime } from "../lib/format";
import { toast } from "../lib/toast";

function FilteredRow({ item, slug }: { item: FilteredItemDTO; slug: string }) {
  const act = useApplicationAction();
  const [runId, setRunId] = useState<number | null>(null);
  const v = item.vacancy;
  const force = () =>
    act.mutate(
      { id: item.id, action: "force" },
      {
        onSuccess: (r) => {
          if (r.run_id) setRunId(r.run_id);
          toast.ok(v.source === "hh" ? "Отклик на hh запущен" : "Готовим резюме и письмо, появится в «Очереди»");
        },
        onError: runStartError,
      },
    );
  return (
    <li className="py-2.5 grid gap-1 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <a href={v.url} target="_blank" rel="noreferrer" className="font-medium break-words">
            {v.title}
          </a>
          <div className="text-[12px] muted">
            {v.company} · {v.source === "hh" ? "hh.ru" : (item.site?.name ?? v.source)} · {fmtDateTime(item.created_at)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {runId && <RunProgress slug={slug} runId={runId} />}
          <button type="button" className="btn btn-sm" disabled={act.isPending || runId !== null} onClick={force}>
            Всё равно откликнуться
          </button>
        </div>
      </div>
      <div className="text-[13px] flex flex-wrap items-baseline gap-1.5">
        <StatusBadge status={item.status} />
        <span className="muted break-words">{item.reason || "—"}</span>
      </div>
    </li>
  );
}

export function FilteredPage() {
  const { slug = "" } = useParams();
  const [source, setSource] = useState("all");
  const q = useFiltered(slug, source);
  const items = q.data ?? [];
  return (
    <Section
      title={
        <>
          Отфильтровано за 7 дней <span className="faint font-normal">{items.length}</span>
        </>
      }
      right={
        <select className="input w-auto" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Источник">
          <option value="all">Все</option>
          <option value="hh">hh.ru</option>
          <option value="career">Сайты</option>
        </select>
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : items.length ? (
        <ul className="divide-y divide-[var(--border)] -my-2.5">
          {items.map((it) => (
            <FilteredRow key={it.id} item={it} slug={slug} />
          ))}
        </ul>
      ) : (
        <Empty>Ничего не отфильтровано</Empty>
      )}
    </Section>
  );
}
