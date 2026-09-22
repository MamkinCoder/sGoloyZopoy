import type { ApplicationDTO, Status } from "@sgz/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useApplication, useApplications, useCareerSites } from "../api/hooks";
import { DataTable, type Column } from "../components/DataTable";
import { JsonView } from "../components/JsonView";
import { FamilyBadge, StatusBadge } from "../components/StatusBadge";
import { Spinner } from "../components/Ui";
import { fmtDateTime, fmtInt, fmtSalary } from "../lib/format";
import { STATUS_GROUPS, STATUS_LABEL } from "../lib/status";

const PAGE_SIZE = 50;

function StatusFilter({ value, onChange }: { value: Status[]; onChange: (v: Status[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  const toggle = (s: Status) => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  const toggleGroup = (items: Status[]) => {
    const all = items.every((s) => value.includes(s));
    onChange(all ? value.filter((s) => !items.includes(s)) : [...new Set([...value, ...items])]);
  };
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn font-normal w-full sm:w-auto justify-between" onClick={() => setOpen((o) => !o)}>
        {value.length === 0 ? "Все статусы" : value.length === 1 ? STATUS_LABEL[value[0]!] : `Статусы: ${value.length}`}
        <span className="faint">▾</span>
      </button>
      {open && (
        <div className="card absolute left-0 top-9 z-30 w-72 p-2 shadow-lg max-h-[70vh] overflow-y-auto">
          {STATUS_GROUPS.map((g) => (
            <div key={g.family} className="mb-2">
              <button type="button" className="w-full text-left py-1 flex items-center gap-2" onClick={() => toggleGroup(g.items)}>
                <input type="checkbox" readOnly className="accent-[var(--accent)]" checked={g.items.every((s) => value.includes(s))} />
                <FamilyBadge family={g.family} label={g.label} />
              </button>
              {g.items.length > 1 &&
                g.items.map((s) => (
                  <label key={s} className="flex items-center gap-2 pl-6 py-0.5 text-[12px] cursor-pointer hover:bg-[var(--surface-2)] rounded">
                    <input type="checkbox" className="accent-[var(--accent)]" checked={value.includes(s)} onChange={() => toggle(s)} />
                    {STATUS_LABEL[s]}
                    <span className="faint kbd ml-auto">{s}</span>
                  </label>
                ))}
            </div>
          ))}
          <div className="flex justify-between pt-1 border-t border-[var(--border)]">
            <button type="button" className="btn btn-sm" onClick={() => onChange([])}>
              Сбросить
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(false)}>
              Готово
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ApplicationsPage() {
  const { slug = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const statuses = (sp.get("status")?.split(",").filter(Boolean) ?? []) as Status[];
  const source = sp.get("source") ?? "";
  const since = sp.get("since") ?? "";
  const until = sp.get("until") ?? "";
  const q = sp.get("q") ?? "";
  const page = Math.max(1, Number(sp.get("page") ?? 1));
  const [draftQ, setDraftQ] = useState(q);
  const [expanded, setExpanded] = useState<number | null>(null);

  const set = (patch: Record<string, string | undefined>, resetPage = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (resetPage) next.delete("page");
    setSp(next, { replace: true });
  };

  useEffect(() => {
    const t = window.setTimeout(() => draftQ !== q && set({ q: draftQ }), 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftQ]);

  const params = { status: statuses.join(",") || undefined, source: source || undefined, since: since || undefined, until: until || undefined, q: q || undefined, page, page_size: PAGE_SIZE };
  const list = useApplications(slug, params);
  const sites = useCareerSites(slug);

  // Client-side text filter on the loaded page as a fallback for servers that ignore `q`.
  const rows = useMemo(() => {
    const items = list.data?.items ?? [];
    if (!q) return items;
    const needle = q.toLowerCase();
    return items.filter((r) => `${r.vacancy.title} ${r.vacancy.company} ${r.resume_title}`.toLowerCase().includes(needle));
  }, [list.data, q]);

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const cols: Column<ApplicationDTO>[] = [
    { key: "date", header: "Дата", render: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.application.createdAt)}</span>, sortValue: (r) => r.application.createdAt },
    {
      key: "vac",
      header: "Вакансия",
      render: (r) => (
        <div className="min-w-[220px]">
          <div className="font-medium line-clamp-1">{r.vacancy.title}</div>
          <div className="muted text-[12px] line-clamp-1">
            {r.vacancy.company}
            {r.vacancy.area && ` · ${r.vacancy.area}`}
            {r.vacancy.workFormat && ` · ${r.vacancy.workFormat}`}
          </div>
        </div>
      ),
      sortValue: (r) => r.vacancy.title,
    },
    { key: "salary", header: "Зарплата", render: (r) => <span className="whitespace-nowrap muted">{fmtSalary(r.vacancy.salaryFrom, r.vacancy.salaryTo, r.vacancy.currency)}</span>, sortValue: (r) => r.vacancy.salaryFrom || r.vacancy.salaryTo },
    { key: "source", header: "Источник", render: (r) => <span className="chip">{r.vacancy.source}</span>, sortValue: (r) => r.vacancy.source },
    { key: "resume", header: "Резюме", render: (r) => <span className="muted line-clamp-1 max-w-[200px]">{r.resume_title || "—"}</span> },
    {
      key: "status",
      header: "Статус",
      render: (r) => (
        <div>
          <StatusBadge status={r.application.status} />
          {r.application.reasonDetail && <div className="faint text-[11px] line-clamp-1 max-w-[220px]">{r.application.reasonDetail}</div>}
        </div>
      ),
      sortValue: (r) => r.application.status,
    },
  ];

  return (
    <div className="grid gap-3">
      <div className="card p-2 flex flex-wrap gap-2 items-center">
        <StatusFilter value={statuses} onChange={(v) => set({ status: v.join(",") })} />
        <select className="input w-auto" value={source} onChange={(e) => set({ source: e.target.value })}>
          <option value="">Все источники</option>
          <option value="hh">hh.ru</option>
          {sites.data?.map((s) => (
            <option key={s.id} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
        <input type="date" className="input w-auto" value={since} onChange={(e) => set({ since: e.target.value })} title="С даты" />
        <input type="date" className="input w-auto" value={until} onChange={(e) => set({ until: e.target.value })} title="По дату" />
        <input className="input flex-1 min-w-[160px]" placeholder="Поиск по вакансии / компании" value={draftQ} onChange={(e) => setDraftQ(e.target.value)} />
        {(statuses.length || source || since || until || q) && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDraftQ("");
              setSp(new URLSearchParams(), { replace: true });
            }}
          >
            Сбросить
          </button>
        )}
      </div>

      <div className="card">
        {list.isLoading ? (
          <Spinner />
        ) : (
          <DataTable
            columns={cols}
            rows={rows}
            rowKey={(r) => r.application.id}
            onRowClick={(r) => setExpanded((e) => (e === r.application.id ? null : r.application.id))}
            expandedKey={expanded}
            renderExpanded={(r) => <ApplicationDetail id={r.application.id} row={r} />}
            empty="Откликов по фильтру нет"
          />
        )}
        <div className="flex items-center justify-between px-3 py-2 text-[12px] muted">
          <span>
            Всего: {fmtInt(total)}
            {list.isFetching && !list.isLoading && " · обновление…"}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) }, false)}>
              ←
            </button>
            <span className="tabular-nums">
              {page} / {pages}
            </span>
            <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) }, false)}>
              →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ApplicationDetail({ id, row }: { id: number; row: ApplicationDTO }) {
  const d = useApplication(id);
  const status = row.application.status;
  const decision = d.data?.decision ?? row.application.llmDecision;
  const failed = status.startsWith("FAILED_");
  return (
    <div className="grid gap-3 lg:grid-cols-2 text-[13px] py-1">
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-3 items-center">
          <a href={row.vacancy.url} target="_blank" rel="noreferrer">
            Открыть вакансию ↗
          </a>
          {failed && (
            <a href={d.data?.snapshot_url ?? `/api/applications/${id}/snapshot`} target="_blank" rel="noreferrer" className="text-[var(--bad)]">
              Снимок страницы ↗
            </a>
          )}
          <span className="faint">
            run{" "}
            <a href={`runs/${row.application.runId}`} className="kbd">
              #{row.application.runId}
            </a>
            {row.application.attempt > 1 && ` · попытка ${row.application.attempt}`}
          </span>
        </div>
        {row.application.reasonDetail && (
          <div>
            <div className="section-title">Детали статуса</div>
            <div>{row.application.reasonDetail}</div>
          </div>
        )}
        <div>
          <div className="section-title">Сопроводительное письмо</div>
          {row.application.coverLetter ? (
            <pre className="whitespace-pre-wrap font-sans bg-[var(--surface)] border border-[var(--border)] rounded p-2 max-h-72 overflow-y-auto">{row.application.coverLetter}</pre>
          ) : (
            <span className="faint">нет</span>
          )}
        </div>
      </div>
      <div className="grid gap-3 content-start">
        <div>
          <div className="section-title">Решение LLM</div>
          {decision ? (
            <div className="grid gap-1">
              <div>
                {decision.apply ? <span className="text-[var(--ok)]">откликаться</span> : <span className="text-[var(--warn)]">пропустить</span>}
                <span className="muted">
                  {" "}
                  · {decision.direction} · {decision.seniority}
                </span>
              </div>
              <div>{decision.reason}</div>
              {decision.red_flags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {decision.red_flags.map((f) => (
                    <span key={f} className="chip bg-[var(--bad-soft)] text-[var(--bad)] border-transparent">
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span className="faint">нет</span>
          )}
        </div>
        <div>
          <div className="section-title">Анкета</div>
          {d.isLoading && <Spinner />}
          {d.data && d.data.questionnaire.length === 0 && <span className="faint">вопросов не было</span>}
          {d.data && d.data.questionnaire.length > 0 && (
            <ol className="grid gap-1.5">
              {d.data.questionnaire.map((qa) => (
                <li key={qa.question.idx} className="border-l-2 border-[var(--border)] pl-2">
                  <div className="muted">
                    {qa.question.text}
                    {qa.question.required && <span className="text-[var(--bad)]"> *</span>}
                  </div>
                  <div>{formatAnswer(qa.answer, qa.question.options)}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
        {row.vacancy.descriptionText && (
          <details>
            <summary className="cursor-pointer muted">Описание вакансии</summary>
            <div className="whitespace-pre-wrap mt-1 max-h-64 overflow-y-auto">{row.vacancy.descriptionText}</div>
          </details>
        )}
        <details>
          <summary className="cursor-pointer muted">JSON</summary>
          <div className="mt-1">
            <JsonView value={d.data ?? row} open={1} />
          </div>
        </details>
      </div>
    </div>
  );
}

function formatAnswer(a: unknown, options?: string[]): string {
  if (a == null) return "—";
  if (typeof a === "string") return a;
  if (typeof a === "object") {
    const o = a as { text?: string; option_idx?: number; option_idxs?: number[] };
    if (o.text) return o.text;
    if (o.option_idx != null) return options?.[o.option_idx] ?? `вариант ${o.option_idx}`;
    if (o.option_idxs) return o.option_idxs.map((i) => options?.[i] ?? `вариант ${i}`).join(", ");
  }
  return JSON.stringify(a);
}
