import type { RunDTO } from "@sgz/shared";
import { useNavigate, useParams } from "react-router-dom";
import { useRuns } from "../api/hooks";
import { DataTable, type Column } from "../components/DataTable";
import { RunStatusBadge } from "../components/StatusBadge";
import { Section, Spinner } from "../components/Ui";
import { fmtDateTime, fmtDuration } from "../lib/format";
import { SOURCE_LABEL, TRIGGER_LABEL } from "../lib/status";

export function RunsPage() {
  const { slug = "" } = useParams();
  const nav = useNavigate();
  const runs = useRuns(slug, 100);

  const cols: Column<RunDTO>[] = [
    { key: "id", header: "#", render: (r) => <span className="kbd">{r.id}</span>, sortValue: (r) => r.id },
    { key: "source", header: "Источник", render: (r) => SOURCE_LABEL[r.source] ?? r.source, sortValue: (r) => r.source },
    { key: "trigger", header: "Триггер", render: (r) => <span className="muted">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span> },
    { key: "started", header: "Старт", render: (r) => fmtDateTime(r.startedAt), sortValue: (r) => r.startedAt },
    { key: "dur", header: "Длит.", render: (r) => <span className="muted">{fmtDuration(r.startedAt, r.finishedAt)}</span> },
    {
      key: "status",
      header: "Статус",
      render: (r) => (
        <span className="inline-flex items-center gap-1">
          <RunStatusBadge status={r.status} />
          {r.stats.dry_run && <span className="chip">dry</span>}
        </span>
      ),
      sortValue: (r) => r.status,
    },
    { key: "found", header: "Найдено", align: "right", render: (r) => r.stats.found, sortValue: (r) => r.stats.found },
    { key: "dedup", header: "Дубли", align: "right", render: (r) => r.stats.deduped, sortValue: (r) => r.stats.deduped },
    { key: "sent", header: "Отпр.", align: "right", render: (r) => r.stats.by_status.SENT ?? 0, sortValue: (r) => r.stats.by_status.SENT ?? 0 },
    { key: "inv", header: "Пригл.", align: "right", render: (r) => r.stats.invitations, sortValue: (r) => r.stats.invitations },
    { key: "llm", header: "LLM", align: "right", render: (r) => <span className="muted">{r.stats.llm_calls}</span> },
    { key: "tg", header: "TG", render: (r) => (r.tgSent ? <span className="text-[var(--ok)]">✓</span> : <span className="faint">—</span>) },
    { key: "err", header: "Ошибка", render: (r) => <span className="text-[var(--bad)] text-[12px] line-clamp-1 max-w-[260px]">{r.error}</span> },
  ];

  return (
    <Section title={`Запуски — ${slug}`}>
      {runs.isLoading ? (
        <Spinner />
      ) : (
        <DataTable columns={cols} rows={runs.data ?? []} rowKey={(r) => r.id} onRowClick={(r) => nav(`/u/${slug}/runs/${r.id}`)} empty="Запусков ещё не было" />
      )}
    </Section>
  );
}
