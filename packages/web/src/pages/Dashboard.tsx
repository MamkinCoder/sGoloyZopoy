import type { AgentJobDTO, AnalyticsCount, AnalyticsDTO, AnalyticsEvent, RunDTO, Status } from "@sgz/shared";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAgentJobs, useAnalytics, useHealth, useRuns, type StatsRange } from "../api/hooks";
import { useRetro } from "../api/hooks";
import { ColumnChart, Funnel, type Series } from "../components/Charts";
import { DataTable, type Column } from "../components/DataTable";
import { StatTile } from "../components/StatTile";
import { RunStatusBadge, StatusBadge } from "../components/StatusBadge";
import { BarList, Empty, Section, Spinner } from "../components/Ui";
import { fmtDateTime, fmtDuration, fmtInt, fmtMb, fmtRel } from "../lib/format";
import { SOURCE_LABEL, TRIGGER_LABEL } from "../lib/status";

const RANGES: { key: StatsRange; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
  { key: "all", label: "Всё время" },
];

const APP_SERIES: Series[] = [
  { key: "sent", name: "Отправлено", color: "var(--s1)" },
  { key: "skipped", name: "Пропущено", color: "var(--s2)" },
  { key: "failed", name: "Ошибки", color: "var(--s3)" },
];
const CHAT_SERIES: Series[] = [
  { key: "msgs_in", name: "От работодателей", color: "var(--s1)" },
  { key: "bot_out", name: "Ответы бота", color: "var(--s2)" },
];
const LLM_SERIES: Series[] = [{ key: "llm_calls", name: "Вызовы LLM", color: "var(--s1)" }];

const FUNNEL_LABEL: Record<string, string> = {
  found: "Найдено",
  decided: "Оценено LLM",
  approved: "Одобрено",
  sent: "Отправлено",
  viewed: "Ответ / просмотр",
  invited: "Приглашения",
  passed: "Прошёл собеседование",
  offer: "Оффер",
};
const EVENT_LABEL: Record<AnalyticsEvent["kind"], string> = { sent: "Отклик", employer: "Работодатель", bot: "Бот" };
const EVENT_CLASS: Record<AnalyticsEvent["kind"], string> = {
  sent: "bg-[var(--ok-soft)] text-[var(--ok)]",
  employer: "bg-[var(--accent-soft)] text-[var(--accent)]",
  bot: "bg-[var(--surface-2)] muted",
};

const compact = (n: number) => new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

/** Below this many hh sends a conversion rate is noise: the row is dimmed and sorts last by conversion. */
const MIN_N = 5;
const rate = (r: AnalyticsCount) => (r.hh && r.hh >= MIN_N ? (r.resp ?? 0) / r.hh + (r.inv ?? 0) / r.hh : -1);

function Bars({ rows, label = (k) => k, byRate = false }: { rows: AnalyticsCount[] | undefined; label?: (key: string) => ReactNode; byRate?: boolean }) {
  if (!rows) return <Spinner />;
  const sorted = byRate ? [...rows].sort((a, b) => rate(b) - rate(a) || b.n - a.n) : rows;
  return (
    <BarList
      rows={sorted.map((r) => ({
        key: r.key,
        label: label(r.key),
        value: r.n,
        dim: r.hh !== undefined && r.hh < MIN_N,
        note:
          r.hh === undefined ? undefined : r.hh ? (
            <>
              ответы {pct((r.resp ?? 0) / r.hh)} · приглашения {pct((r.inv ?? 0) / r.hh)}
              {!!r.pass && ` · прошёл собеседование ${r.pass}`}
              {r.hh < r.n && ` · из ${r.hh} через hh`}
            </>
          ) : (
            "конверсия: нет данных (сайты компаний)"
          ),
      }))}
    />
  );
}

function Kpis({ k }: { k: AnalyticsDTO["kpi"] }) {
  const b = (n: number) => <b className="text-[var(--text)]">{fmtInt(n)}</b>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <StatTile label="Отправлено" value={fmtInt(k.sent)} tone={k.sent ? "ok" : undefined} sub={<>пропущено {b(k.skipped)}</>} />
      <StatTile label="Переговоры hh" value={fmtInt(k.negotiations)} sub={<>с ответом {b(k.responded)}</>} />
      <StatTile label="Доля ответов" value={pct(k.response_rate)} sub="ответы / отправлено" />
      <StatTile label="Приглашения" value={fmtInt(k.invitations)} tone={k.invitations ? "ok" : undefined} sub={<>отказы {b(k.rejections)}</>} />
      <StatTile label="Сообщений от работодателей" value={fmtInt(k.employer_messages)} sub={<>ответов бота {b(k.bot_replies)}</>} />
      <StatTile label="Ждут человека" value={fmtInt(k.needs_human_open)} tone={k.needs_human_open ? "warn" : undefined} sub="чаты сейчас" />
      <StatTile label="Резюме" value={fmtInt(k.resumes_total)} sub={<>создано ботом {b(k.resumes_generated)}</>} />
      <StatTile label="Вызовы LLM" value={fmtInt(k.llm_calls)} sub={<>ошибок {b(k.llm_failed)}</>} />
      <StatTile label="Символы LLM" value={compact(k.llm_prompt_chars)} sub={<>ответы {compact(k.llm_result_chars)}</>} />
      <StatTile label="Среднее время LLM" value={k.llm_calls ? `${(k.llm_avg_ms / 1000).toFixed(1)} с` : "—"} sub="на вызов" />
      <StatTile label="Ошибки откликов" value={fmtInt(k.failed)} tone={k.failed ? "bad" : undefined} sub="FAILED_*" />
      <StatTile label="Запуски" value={fmtInt(k.runs)} sub="за период" />
    </div>
  );
}

const JOB_LABEL: Record<string, string> = {
  "chats.sync": "проверка чатов",
  "chats.triage": "разбор сообщения",
  "chats.review": "вопрос о навыках",
  "chats.remind": "напоминание",
  "chats.fallback": "ответ без подтверждения",
  "chats.draft": "черновик ответа",
  "chats.send": "отправка ответа",
  "chats.prep": "подготовка к собеседованию",
};

/** The always-on agent: what runs now, what waits, what failed (employer chats live here, not in runs). */
function AgentSection() {
  const jobs = useAgentJobs();
  const all = jobs.data ?? [];
  const by = (s: AgentJobDTO["state"]) => all.filter((j) => j.state === s);
  const [running, queued, failed] = [by("running"), by("queued"), by("failed")];
  const row = (j: AgentJobDTO, when: string) => (
    <li key={j.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-baseline">
      <span className="truncate" title={j.last_error || j.key || undefined}>
        {JOB_LABEL[j.kind] ?? j.kind}
        {j.attempts > 1 && <span className="faint"> · попытка {j.attempts}/{j.max_attempts}</span>}
        {j.last_error && <span className="text-[var(--bad)]"> · {j.last_error}</span>}
      </span>
      <span className="faint tabular-nums">{when}</span>
    </li>
  );
  return (
    <Section title="Агент" right={<span className="faint text-[12px]">сейчас {running.length} · в очереди {queued.length} · ошибок {failed.length}</span>}>
      {jobs.isLoading ? (
        <Spinner />
      ) : !all.length ? (
        <Empty>Агент ещё ничего не делал</Empty>
      ) : (
        <ul className="grid gap-1 text-[12px]">
          {running.map((j) => row(j, "идёт"))}
          {[...queued].sort((a, b) => a.run_after.localeCompare(b.run_after)).slice(0, 5).map((j) => row(j, fmtRel(j.run_after)))}
          {failed.slice(0, 5).map((j) => row(j, fmtRel(j.updated_at)))}
        </ul>
      )}
    </Section>
  );
}

export function DashboardPage() {
  const { slug = "" } = useParams();
  const nav = useNavigate();
  const [range, setRange] = useState<StatsRange>("30d");
  const [byRate, setByRate] = useState(false);
  const an = useAnalytics(slug, range);
  const runs = useRuns(slug, 10);
  const health = useHealth();
  const a = an.data;
  const daily = (a?.daily ?? []).map((d) => ({ label: d.day, values: { ...d } as unknown as Record<string, number> }));

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Аналитика</h2>
        <div className="flex gap-1" role="group" aria-label="Период">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
              className={`btn btn-sm ${range === r.key ? "bg-[var(--surface-2)] font-semibold" : "font-normal"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {a ? <Kpis k={a.kpi} /> : an.isError ? <Empty>Не удалось загрузить аналитику</Empty> : <Spinner />}
      {a?.salary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatTile label="Вилки: медиана" value={`${compact(a.salary.p50)} ₽`} sub={<>вакансии за 90 дней, n={a.salary.n}</>} />
          <StatTile label="Вилки: 25-75%" value={`${compact(a.salary.p25)}-${compact(a.salary.p75)}`} sub="середина вилки, ₽" />
        </div>
      )}

      <WeekCard slug={slug} />
      <AgentSection />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Отклики по дням">{a ? daily.length ? <ColumnChart rows={daily} series={APP_SERIES} /> : <Empty /> : <Spinner />}</Section>
        <Section title="Чаты по дням">
          {a ? daily.length ? <ColumnChart rows={daily} series={CHAT_SERIES} stacked={false} /> : <Empty /> : <Spinner />}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Воронка">
          {a ? <Funnel steps={a.funnel.map((f) => ({ key: f.key, label: FUNNEL_LABEL[f.key] ?? f.key, n: f.n }))} /> : <Spinner />}
          <div className="mt-2 text-[11px] faint">
            «Найдено» - сумма по запускам; хвост воронки - состояния переговоров hh.
          </div>
        </Section>
        <Section title="Вызовы LLM по дням">{a ? daily.length ? <ColumnChart rows={daily} series={LLM_SERIES} height={150} /> : <Empty /> : <Spinner />}</Section>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="muted">Разбивки:</span>
        <div className="flex gap-1" role="group" aria-label="Сортировка разбивок">
          {[false, true].map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={byRate === v}
              onClick={() => setByRate(v)}
              className={`btn btn-sm ${byRate === v ? "bg-[var(--surface-2)] font-semibold" : "font-normal"}`}
            >
              {v ? "по конверсии" : "по откликам"}
            </button>
          ))}
        </div>
        <span className="faint">конверсия считается по откликам через hh, от {MIN_N} штук</span>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Section title="Причины пропуска">
          <Bars rows={a?.skip_reasons} label={(k) => <StatusBadge status={k as Status} />} />
        </Section>
        <Section title="Почему LLM отклонил">
          <Bars rows={a?.reject_reasons} />
        </Section>
        <Section title="Топ компаний (отправлено)">
          <Bars byRate={byRate} rows={a?.companies} />
        </Section>
        <Section title="Источник">
          <Bars byRate={byRate} rows={a?.sources} label={(k) => SOURCE_LABEL[k] ?? k} />
        </Section>
        <Section title="Резюме">
          <Bars byRate={byRate} rows={a?.resumes} />
        </Section>
        <Section title="Направление">
          <Bars byRate={byRate} rows={a?.directions} />
        </Section>
        <Section title="Формат работы">
          <Bars rows={a?.work_formats} />
        </Section>
        <Section title="Регион">
          <Bars rows={a?.areas} />
        </Section>
        <Section title="Задачи LLM">
          <Bars rows={a?.llm_tasks} />
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section title="Последние события">
          {!a ? (
            <Spinner />
          ) : a.recent.length === 0 ? (
            <Empty />
          ) : (
            <ul className="grid gap-1.5 text-[12px]">
              {a.recent.map((e, i) => (
                <li key={i} className="grid grid-cols-[76px_92px_minmax(0,1fr)] gap-2 items-baseline">
                  <span className="faint tabular-nums">{fmtDateTime(e.at)}</span>
                  <span className={`rounded px-1.5 py-px text-[11px] font-medium text-center ${EVENT_CLASS[e.kind]}`}>{EVENT_LABEL[e.kind]}</span>
                  <span className="truncate" title={`${e.title} - ${e.detail}`}>
                    {e.title || "—"}
                    {e.detail && <span className="muted"> - {e.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
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
            <dt className="muted">Сайты компаний</dt>
            <dd>
              {hh?.career ? (
                <>
                  сегодня {hh.career.sites_enabled - hh.career.sites_left_today}/{hh.career.sites_enabled}
                  <span className="faint">
                    {" "}
                    · в очередь {hh.career.daily_limit - hh.career.queue_left}/{hh.career.daily_limit}
                  </span>{" "}
                  <Link to={`/u/${slug}/queue`}>очередь</Link>
                </>
              ) : (
                <span className="faint">—</span>
              )}
            </dd>
            <dt className="muted">Резюме подняты</dt>
            <dd>{health.data?.touch_last_at ? fmtRel(health.data.touch_last_at) : <span className="faint">ещё нет</span>}</dd>
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
              {health.data ? `${fmtMb(health.data.mem_rss_mb)} RSS` : "—"}
              {health.data?.mem_available_mb != null && <span className="faint"> · свободно {fmtMb(health.data.mem_available_mb)}</span>}
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

/** Points change against the week before, "" when there is nothing to compare with. */
const dPts = (cur: number | null, prev: number | null | undefined) =>
  cur == null || prev == null ? "" : ` (${cur >= prev ? "+" : ""}${Math.round((cur - prev) * 100)} п.п.)`;

function WeekCard({ slug }: { slug: string }) {
  const q = useRetro(slug);
  const r = q.data;
  return (
    <Section title="Неделя">
      {q.isLoading ? (
        <Spinner />
      ) : !r ? (
        <Empty>Мало данных: за 7 дней меньше 10 откликов</Empty>
      ) : (
        <ul className="grid gap-1.5 text-[13px]">
          <li>
            Отправлено <b>{fmtInt(r.sent)}</b>
            {r.prev && <span className="muted"> (было {fmtInt(r.prev.sent)})</span>} · ответы <b>{pct(r.response_rate)}</b>
            <span className="muted">{dPts(r.response_rate, r.prev?.response_rate)}</span> · приглашения <b>{pct(r.invite_rate)}</b>
            <span className="muted">{dPts(r.invite_rate, r.prev?.invite_rate)}</span>
            {!r.prev && <span className="faint"> · прошлая неделя слишком мала для сравнения</span>}
          </li>
          {r.best && (
            <li>
              <span className="text-[var(--ok)]">Заходит:</span> {r.best.key}
              <span className="muted"> - приглашения {r.best.inv}, ответы {r.best.resp} из {r.best.hh} за 2 недели</span>
            </li>
          )}
          {r.mismatch && (
            <li>
              <span className="text-[var(--warn)]">Не заходит:</span> {r.mismatch.key}
              <span className="muted"> - {r.mismatch.hh} откликов за 2 недели без ответа</span>
            </li>
          )}
          {r.stale_queue > 0 && (
            <li>
              В очереди дольше 3 дней: <Link to={`/u/${slug}/queue`}>{r.stale_queue}</Link>
            </li>
          )}
          {r.interviews.map((i) => (
            <li key={`${i.employer}${i.at}`}>
              Собеседование: {i.employer} <span className="muted">· {fmtDateTime(i.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
