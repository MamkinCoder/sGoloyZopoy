import type { GeneratedResumeDTO } from "@sgz/shared";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useResumeAction, useResumes } from "../api/hooks";
import { DataTable, type Column } from "../components/DataTable";
import { Section, Spinner } from "../components/Ui";
import { fmtDateTime, fmtRel } from "../lib/format";
import { toast } from "../lib/toast";

export function ResumesPage() {
  const { slug = "" } = useParams();
  const res = useResumes(slug);
  const act = useResumeAction(slug);
  const [selected, setSelected] = useState<GeneratedResumeDTO | null>(null);

  const run = (action: "sync" | "touch" | "expand") =>
    act.mutate({ action }, { onSuccess: ({ run_id }) => toast.ok(`Поставлено в очередь: run #${run_id}`) });

  const cap = res.data?.capacity;
  const capPct = cap && cap.max > 0 ? Math.min(100, Math.round((cap.created / cap.max) * 100)) : 0;
  const capTone = capPct >= 100 ? "bg-[var(--bad)]" : capPct >= 75 ? "bg-[var(--warn)]" : "bg-[var(--accent)]";

  const genCols: Column<GeneratedResumeDTO>[] = [
    { key: "date", header: "Дата", render: (g) => <span className="whitespace-nowrap">{fmtDateTime(g.created_at)}</span>, sortValue: (g) => g.created_at },
    { key: "v", header: "Вакансия", render: (g) => <span className="line-clamp-1">{g.vacancy_title}</span>, sortValue: (g) => g.vacancy_title },
    { key: "c", header: "Компания", render: (g) => <span className="muted">{g.company}</span>, sortValue: (g) => g.company },
    { key: "m", header: "Модель", render: (g) => <span className="faint kbd text-[11px]">{g.model}</span> },
    {
      key: "links",
      header: "",
      render: (g) => (
        <span className="flex gap-2 whitespace-nowrap">
          <a href={g.pdf_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            PDF
          </a>
          <a href={g.tex_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            .tex
          </a>
        </span>
      ),
    },
  ];

  if (res.isLoading) return <Spinner />;
  const hh = res.data?.hh ?? [];
  const gen = res.data?.generated ?? [];

  return (
    <div className="grid gap-4">
      <Section
        title={
          <>
            Пул резюме hh <span className="faint font-normal">{hh.length}</span>
            {res.data?.last_synced && <span className="faint font-normal"> · синк {fmtRel(res.data.last_synced)}</span>}
          </>
        }
        right={
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="btn btn-sm" disabled={act.isPending} onClick={() => run("sync")}>
              Синхронизировать
            </button>
            <button type="button" className="btn btn-sm" disabled={act.isPending} onClick={() => run("touch")}>
              Поднять все
            </button>
            <button type="button" className="btn btn-sm" disabled={act.isPending || (cap != null && cap.max > 0 && cap.created >= cap.max)} onClick={() => run("expand")}>
              Расширить пул
            </button>
          </div>
        }
      >
        {cap && (
          <div className="mb-3 text-[12px] muted flex items-center gap-2">
            <span className="whitespace-nowrap">
              Создано сегодня: {cap.created} / {cap.max}
            </span>
            <div className="flex-1 max-w-[240px] h-1.5 rounded bg-[var(--surface-2)] overflow-hidden">
              <div className={`h-full ${capTone}`} style={{ width: `${capPct}%` }} />
            </div>
          </div>
        )}
        {hh.length === 0 && <div className="faint text-center py-4">Пул пуст — нажмите «Синхронизировать»</div>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {hh.map((r) => (
            <div key={r.id} className="card p-3 grid gap-2 content-start">
              <div className="flex items-start justify-between gap-2">
                <a href={r.url} target="_blank" rel="noreferrer" className="font-medium leading-snug">
                  {r.title}
                </a>
                {r.isGenerated && (
                  <span className="chip shrink-0" title="Создано агентом">
                    авто
                  </span>
                )}
              </div>
              <div className="text-[12px] muted flex flex-wrap gap-x-2">
                <span>{r.summary?.direction || r.direction || "—"}</span>
                {r.summary?.seniority && <span>· {r.summary.seniority}</span>}
              </div>
              {r.summary?.one_line && <div className="text-[12px]">{r.summary.one_line}</div>}
              {r.summary && r.summary.key_skills.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {r.summary.key_skills.slice(0, 12).map((s) => (
                    <span key={s} className="chip">
                      {s}
                    </span>
                  ))}
                </div>
              )}
              <div className="faint text-[11px] mt-auto">
                синк {fmtDateTime(r.syncedAt)} · <span className="kbd">{r.hhResumeId.slice(0, 8)}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title={<>Сгенерированные резюме <span className="faint font-normal">{gen.length}</span></>}>
          <DataTable columns={genCols} rows={gen} rowKey={(g) => g.id} onRowClick={setSelected} expandedKey={selected?.id} empty="Ещё ничего не сгенерировано" dense defaultSort={{ key: "date", dir: "desc" }} />
        </Section>
        <Section
          title={selected ? `${selected.vacancy_title} — ${selected.company}` : "Просмотр PDF"}
          right={
            selected && (
              <span className="flex gap-2 text-[12px]">
                <a href={selected.pdf_url} target="_blank" rel="noreferrer">
                  открыть
                </a>
                <a href={selected.tex_url} target="_blank" rel="noreferrer">
                  .tex
                </a>
              </span>
            )
          }
        >
          {selected ? (
            <iframe title="PDF" src={selected.pdf_url} className="w-full h-[70vh] rounded border border-[var(--border)] bg-white" />
          ) : (
            <div className="faint text-center py-10">Выберите резюме в списке</div>
          )}
        </Section>
      </div>
    </div>
  );
}
