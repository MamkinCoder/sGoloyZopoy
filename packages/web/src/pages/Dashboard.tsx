import type { RunDTO, Status } from "@sgz/shared";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useHealth, useRuns, useStats, type StatsRange } from "../api/hooks";
import { DataTable, type Column } from "../components/DataTable";
import { StatTile } from "../components/StatTile";
import { RunStatusBadge, StatusBadge } from "../components/StatusBadge";
import { BarList, Section, Spinner } from "../components/Ui";
import { fmtDateTime, fmtDuration, fmtInt } from "../lib/format";
import { familyOf, SOURCE_LABEL, TRIGGER_LABEL } from "../lib/status";

const RANGES: { key: StatsRange; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
];

export function DashboardPage() {
  const { slug = "" } = useParams();
  const nav = useNavigate();
  const today = useStats(slug, "today");
  const week = useStats(slug, "7d");
  const month = useStats(slug, "30d");
  const [breakRange, setBreakRange] = useState<StatsRange>("7d");
  const runs = useRuns(slug, 10);
  const health = useHealth();

  const pick = (k: "sent" | "invitations" | "rejections" | "failed") => ({
    t: today.data?.[k],
    w: week.data?.[k],
    m: month.data?.[k],
  });
  const tile = (label: string, k: "sent" | "invitations" | "rejections" | "failed", tone?: "ok" | "bad" | "warn") => {
    const v = pick(k);
    return (
      <StatTile
        label={label}
        value={today.isLoading ? "…" : fmtInt(v.t)}
        tone={v.t ? tone : undefined}
        sub={
          <>
            7д: <b className="text-[var(--text)]">{fmtInt(v.w)}</b> · 30д: <b className="text-[var(--text)]">{fmtInt(v.m)}</b>
          </>
        }
      />
    );
  };

  const breakdownSrc = breakRange === "today" ? today.data : breakRange === "7d" ? week.data : month.data;
  const breakdown = Object.entries(breakdownSrc?.by_status ?? {})
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([s, n]) => ({ key: s, label: <StatusBadge status={s as Status} />, value: n ?? 0, family: familyOf(s) }));

  const hh = health.data?.users.find((u) => u.slug === slug);
  const lastRun = runs.data?.find((r) => r.status !== "queued" && r.status !== "running");

  const runCols: Column<RunDTO>[] = [
    { key: "id", header: "#", render: (r) => <span className="kbd">{r.id}</span>, sortValue: (r) => r.id },
    { key: "source", header: "Источник", render: (r) => SOURCE_LABEL[r.source] ?? r.source },
    { key: "trigger", header: "Триггер", render: (r) => <span className="muted">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span> },
    { key: "started", header: "Старт", render: (r) => fmtDateTime(r.startedAt), sortValue: (r) => r.startedAt },
    { key: "dur", header: "Длит.", render: (r) => <span className="muted">{fmtDuration(r.startedAt, r.finishedAt)}</span> },
    { key: "status", header: "Статус", render: (r) => <RunStatusBadge status={r.status} /> },
    { key: "found", header: "Найдено", align: "right", render: (r) => r.stats.found, sortValue: (r) => r.stats.found },
    { key: "sent", header: "Отпр.", align: "right", render: (r) => r.stats.by_status.SENT ?? 0, sortValue: (r) => r.stats.by_status.SENT ?? 0 },
    { key: "tg", header: "TG", render: (r) => (r.tgSent ? <span className="text-[var(--ok)]">✓</span> : <span className="faint">—</span>) },
  ];

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tile("Отправлено", "sent", "ok")}
        {tile("Приглашения", "invitations", "ok")}
        {tile("Отказы", "rejections", "warn")}
        {tile("Ошибки", "failed", "bad")}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section
          title="Причины"
          right={
            <div className="flex gap-1">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setBreakRange(r.key)}
                  className={`btn btn-sm ${breakRange === r.key ? "bg-[var(--surface-2)] font-semibold" : "font-normal"}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          }
        >
          {breakdownSrc ? <BarList rows={breakdown} /> : <Spinner />}
          {breakdownSrc && (
            <div className="mt-3 pt-2 border-t border-[var(--border)] text-[12px] muted flex flex-wrap gap-x-4 gap-y-1">
              <span>
                Пропущено: <b>{fmtInt(breakdownSrc.skipped)}</b>
              </span>
              <span>
                Ответов в чатах: <b>{fmtInt(breakdownSrc.chat_replies)}</b>
              </span>
              <span>
                Запусков: <b>{fmtInt(breakdownSrc.runs_count)}</b>
              </span>
            </div>
          )}
        </Section>

        <Section title="Состояние">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[13px]">
            <dt className="muted">Сессия hh</dt>
            <dd>
              {!hh ? (
                <span className="faint">нет данных</span>
              ) : hh.hh_login_ok === null ? (
                <span className="faint">не проверялась</span>
              ) : hh.hh_login_ok ? (
                <span className="text-[var(--ok)]">активна</span>
              ) : (
                <span className="text-[var(--bad)]">истекла — нужен hh-login</span>
              )}
              {hh?.cookies_age_h != null && <span className="faint"> · cookies {Math.round(hh.cookies_age_h)} ч</span>}
            </dd>
            <dt className="muted">Последний отчёт в TG</dt>
            <dd>
              {!lastRun ? (
                <span className="faint">—</span>
              ) : lastRun.tgSent ? (
                <span className="text-[var(--ok)]">✓ отправлен</span>
              ) : (
                <span className="text-[var(--warn)]">не отправлен</span>
              )}
              {lastRun && (
                <Link to={`/u/${slug}/runs/${lastRun.id}`} className="ml-1 faint">
                  run #{lastRun.id}
                </Link>
              )}
            </dd>
            <dt className="muted">Активный запуск</dt>
            <dd>
              {health.data?.active_run_id ? (
                <Link to={`/u/${slug}/runs/${health.data.active_run_id}`}>#{health.data.active_run_id}</Link>
              ) : (
                <span className="faint">нет</span>
              )}
            </dd>
            <dt className="muted">Память</dt>
            <dd>
              {health.data ? `${Math.round(health.data.mem_rss_mb)} МБ RSS` : "—"}
              {health.data?.mem_available_mb != null && <span className="faint"> · свободно {Math.round(health.data.mem_available_mb)} МБ</span>}
            </dd>
          </dl>
          {lastRun && lastRun.stats.top_vacancies.length > 0 && (
            <div className="mt-3 pt-2 border-t border-[var(--border)]">
              <div className="section-title">Топ вакансий последнего запуска</div>
              <ul className="text-[12px] grid gap-1">
                {lastRun.stats.top_vacancies.slice(0, 5).map((v) => (
                  <li key={v.url} className="truncate">
                    <a href={v.url} target="_blank" rel="noreferrer">
                      {v.title}
                    </a>
                    <span className="muted"> — {v.company}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      </div>

      <Section
        title="Последние запуски"
        right={
          <Link to={`/u/${slug}/runs`} className="text-[12px]">
            все →
          </Link>
        }
      >
        {runs.isLoading ? (
          <Spinner />
        ) : (
          <DataTable columns={runCols} rows={runs.data ?? []} rowKey={(r) => r.id} onRowClick={(r) => nav(`/u/${slug}/runs/${r.id}`)} dense />
        )}
      </Section>
    </div>
  );
}
