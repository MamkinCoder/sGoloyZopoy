import type { DedupRowDTO, RunEventDTO, Status } from "@sgz/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { keys, useDedup, useRun, useRunEvents, useStopRun } from "../api/hooks";
import { streamRunEvents } from "../api/sse";
import { DataTable, type Column } from "../components/DataTable";
import { JsonView } from "../components/JsonView";
import { StatTile } from "../components/StatTile";
import { RunStatusBadge, StatusBadge } from "../components/StatusBadge";
import { BarList, Section, Spinner } from "../components/Ui";
import { fmtDateTime, fmtDuration, fmtSalary, fmtTime } from "../lib/format";
import { isRunActive, SOURCE_LABEL, STAGE_LABEL, TRIGGER_LABEL } from "../lib/status";
import { toast } from "../lib/toast";

type Level = "all" | "warn" | "error";
const LEVEL_RANK = { info: 0, warn: 1, error: 2 } as const;

interface StageGroup {
  stage: string;
  events: RunEventDTO[];
}

function groupByStage(events: RunEventDTO[]): StageGroup[] {
  const groups: StageGroup[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last.stage === e.stage) last.events.push(e);
    else groups.push({ stage: e.stage, events: [e] });
  }
  return groups;
}

export function RunDetailPage() {
  const { slug = "", id: idStr = "0" } = useParams();
  const id = Number(idStr);
  const qc = useQueryClient();
  const run = useRun(id);
  const active = isRunActive(run.data?.status);
  const history = useRunEvents(id, run.data != null);
  const stop = useStopRun(id);
  const [live, setLive] = useState<RunEventDTO[]>([]);
  const [conn, setConn] = useState<"connecting" | "open" | "reconnecting" | "closed">("closed");
  const [level, setLevel] = useState<Level>("all");
  const [tab, setTab] = useState<"log" | "dedup">("log");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  const historyLoaded = history.data != null;
  const lastHistoryId = history.data?.length ? history.data[history.data.length - 1]!.id : 0;

  // Live stream only while the run is active; history comes from GET /events once.
  useEffect(() => {
    if (!active || !historyLoaded) return;
    const s = streamRunEvents(id, lastHistoryId, {
      onEvent: (e) => setLive((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e])),
      onDone: () => {
        setConn("closed");
        qc.invalidateQueries({ queryKey: keys.run(id) });
        qc.invalidateQueries({ queryKey: keys.runEvents(id) });
        qc.invalidateQueries({ queryKey: keys.activeRun });
        qc.invalidateQueries({ queryKey: ["runs"] });
      },
      onStatus: setConn,
    });
    return () => {
      s.close();
      setConn("closed");
    };
  }, [id, active, historyLoaded, lastHistoryId, qc]);

  const events = useMemo(() => {
    const seen = new Set<number>();
    const out: RunEventDTO[] = [];
    for (const e of [...(history.data ?? []), ...live]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  }, [history.data, live]);

  const filtered = useMemo(() => {
    const min = level === "all" ? 0 : LEVEL_RANK[level];
    return events.filter((e) => LEVEL_RANK[e.level] >= min);
  }, [events, level]);
  const groups = useMemo(() => groupByStage(filtered), [filtered]);

  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [filtered.length, autoScroll]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 12);
  };

  const dedup = useDedup(id, tab === "dedup");

  if (run.isLoading) return <Spinner />;
  if (!run.data) return <div className="muted">Запуск не найден</div>;
  const r = run.data;
  const sent = r.stats.by_status.SENT ?? 0;
  const byStatus = Object.entries(r.stats.by_status)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([s, n]) => ({ key: s, label: <StatusBadge status={s as Status} />, value: n ?? 0 }));

  const dedupCols: Column<DedupRowDTO>[] = [
    {
      key: "v",
      header: "Вакансия",
      render: (d) => (
        <>
          <a href={d.vacancy.url} target="_blank" rel="noreferrer">
            {d.vacancy.title}
          </a>
          <span className="muted"> — {d.vacancy.company}</span>
        </>
      ),
      sortValue: (d) => d.vacancy.title,
    },
    { key: "r", header: "Причина", render: (d) => <StatusBadge status={d.reason} />, sortValue: (d) => d.reason },
    { key: "d", header: "Детали", render: (d) => <span className="muted">{d.detail}</span> },
  ];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link to={`/u/${slug}/runs`} className="muted text-[13px]">
          ← Запуски
        </Link>
        <h1 className="text-lg font-semibold">Запуск #{r.id}</h1>
        <RunStatusBadge status={r.status} />
        {r.stats.dry_run && <span className="chip">dry-run</span>}
        <span className="muted text-[13px]">
          {SOURCE_LABEL[r.source] ?? r.source} · {TRIGGER_LABEL[r.trigger] ?? r.trigger} · {fmtDateTime(r.startedAt)} · {fmtDuration(r.startedAt, r.finishedAt)}
        </span>
        {r.tgSent && <span className="text-[var(--ok)] text-[13px]">TG ✓</span>}
        {active && (
          <button
            type="button"
            className="btn btn-sm btn-danger ml-auto"
            disabled={stop.isPending}
            onClick={() => stop.mutate(undefined, { onSuccess: () => toast.info("Останавливаем…") })}
          >
            ■ Остановить
          </button>
        )}
      </div>
      {r.error && <div className="card border-[var(--bad)] px-3 py-2 text-[13px] text-[var(--bad)]">{r.error}</div>}

      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        <StatTile label="Найдено" value={r.stats.found} />
        <StatTile label="Дубли" value={r.stats.deduped} />
        <StatTile label="Отправлено" value={sent} tone={sent ? "ok" : undefined} />
        <StatTile label="Приглашения" value={r.stats.invitations} tone={r.stats.invitations ? "ok" : undefined} />
        <StatTile label="Отказы" value={r.stats.rejections} tone={r.stats.rejections ? "warn" : undefined} />
        <StatTile label="Ответы в чатах" value={r.stats.chat_replies} />
        <StatTile label="Вызовов LLM" value={r.stats.llm_calls} />
      </div>

      {(byStatus.length > 0 || r.stats.top_vacancies.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="По статусам">
            <BarList rows={byStatus} />
          </Section>
          <Section title="Топ вакансий">
            <ul className="grid gap-1 text-[13px]">
              {r.stats.top_vacancies.length === 0 && <li className="faint">—</li>}
              {r.stats.top_vacancies.map((v) => (
                <li key={v.url} className="flex justify-between gap-2">
                  <span className="truncate">
                    <a href={v.url} target="_blank" rel="noreferrer">
                      {v.title}
                    </a>
                    <span className="muted"> — {v.company}</span>
                  </span>
                  <span className="muted whitespace-nowrap">{fmtSalary(v.salary_from, v.salary_to, "RUR")}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      )}

      <div className="card">
        <div className="flex items-center gap-2 px-3 border-b border-[var(--border)]">
          <div className="tabs border-b-0 flex-1">
            <button type="button" className={`tab ${tab === "log" ? "tab-active" : ""}`} onClick={() => setTab("log")}>
              Лог <span className="faint">{events.length}</span>
            </button>
            <button type="button" className={`tab ${tab === "dedup" ? "tab-active" : ""}`} onClick={() => setTab("dedup")}>
              Дедуп
            </button>
          </div>
          {tab === "log" && (
            <div className="flex items-center gap-2 text-[12px]">
              {active && (
                <span className={`chip ${conn === "open" ? "text-[var(--ok)]" : "text-[var(--warn)]"}`}>
                  {conn === "open" ? "● live" : conn === "closed" ? "○ нет связи" : "○ подключение…"}
                </span>
              )}
              <select className="input h-7 w-auto text-[12px]" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                <option value="all">все уровни</option>
                <option value="warn">warn+</option>
                <option value="error">error</option>
              </select>
              {!autoScroll && (
                <button type="button" className="btn btn-sm" onClick={() => setAutoScroll(true)}>
                  ↓ вниз
                </button>
              )}
            </div>
          )}
        </div>

        {tab === "log" ? (
          <div ref={logRef} onScroll={onScroll} className="max-h-[60vh] overflow-y-auto kbd text-[12px] leading-[1.5]">
            {history.isLoading && <Spinner />}
            {!history.isLoading && filtered.length === 0 && <div className="faint p-4 text-center">Событий нет</div>}
            {groups.map((g, gi) => {
              const isCollapsed = collapsed.has(gi);
              const worst = g.events.reduce((m, e) => Math.max(m, LEVEL_RANK[e.level]), 0);
              return (
                <div key={`${g.stage}-${gi}`}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1 bg-[var(--surface-2)] border-y border-[var(--border)] flex items-center gap-2 font-sans text-[12px] font-semibold"
                    onClick={() =>
                      setCollapsed((s) => {
                        const n = new Set(s);
                        if (n.has(gi)) n.delete(gi);
                        else n.add(gi);
                        return n;
                      })
                    }
                  >
                    <span className="faint">{isCollapsed ? "▸" : "▾"}</span>
                    {STAGE_LABEL[g.stage] ?? g.stage}
                    <span className="faint font-normal">{g.events.length}</span>
                    {worst === 2 && <span className="text-[var(--bad)] font-normal">error</span>}
                    {worst === 1 && <span className="text-[var(--warn)] font-normal">warn</span>}
                  </button>
                  {!isCollapsed && g.events.map((e) => <EventRow key={e.id} e={e} />)}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-3">
            {dedup.isLoading ? (
              <Spinner />
            ) : (
              <DataTable columns={dedupCols} rows={dedup.data ?? []} rowKey={(d) => d.vacancy.url + d.reason} empty="Дублей нет" dense />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ e }: { e: RunEventDTO }) {
  const [open, setOpen] = useState(false);
  const color = e.level === "error" ? "text-[var(--bad)]" : e.level === "warn" ? "text-[var(--warn)]" : "";
  const hasData = e.data && Object.keys(e.data).length > 0;
  return (
    <div className={`px-3 py-px flex gap-2 items-start hover:bg-[var(--surface-2)]/60 ${color}`}>
      <span className="faint shrink-0 tabular-nums">{fmtTime(e.ts)}</span>
      <span className={`shrink-0 w-10 ${e.level === "info" ? "faint" : ""}`}>{e.level}</span>
      <span className="min-w-0 break-words flex-1">
        {e.message}
        {hasData && (
          <button type="button" className="ml-2 faint hover:underline" onClick={() => setOpen((o) => !o)}>
            {open ? "скрыть" : "данные"}
          </button>
        )}
        {open && hasData && (
          <div className="mt-1 mb-1 pl-2 border-l border-[var(--border)]">
            <JsonView value={e.data} open={2} />
          </div>
        )}
      </span>
    </div>
  );
}
