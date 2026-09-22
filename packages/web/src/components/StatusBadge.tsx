import type { RunStatus, Status, ThreadState } from "@sgz/shared";
import { familyOf, RUN_STATUS_LABEL, STATUS_LABEL, THREAD_STATE_LABEL, type Family } from "../lib/status";

const FAMILY_CLASS: Record<Family, string> = {
  sent: "bg-[var(--ok-soft)] text-[var(--ok)]",
  skip: "bg-[var(--warn-soft)] text-[var(--warn)]",
  failed: "bg-[var(--bad-soft)] text-[var(--bad)]",
  human: "bg-[var(--human-soft)] text-[var(--human)]",
};
const NEUTRAL = "bg-[var(--surface-2)] muted";

function Badge({ cls, children, title }: { cls: string; children: string; title?: string }) {
  return (
    <span title={title} className={`inline-block rounded px-1.5 py-px text-[11px] font-medium whitespace-nowrap ${cls}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: Status | string }) {
  const label = STATUS_LABEL[status as Status] ?? status;
  return (
    <Badge cls={FAMILY_CLASS[familyOf(status)]} title={status}>
      {label}
    </Badge>
  );
}

export function FamilyBadge({ family, label }: { family: Family; label: string }) {
  return <Badge cls={FAMILY_CLASS[family]}>{label}</Badge>;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const cls =
    status === "done"
      ? FAMILY_CLASS.sent
      : status === "failed"
        ? FAMILY_CLASS.failed
        : status === "running"
          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
          : status === "stopped"
            ? FAMILY_CLASS.skip
            : NEUTRAL;
  return <Badge cls={cls}>{RUN_STATUS_LABEL[status] ?? status}</Badge>;
}

export function ThreadStateBadge({ state }: { state: ThreadState }) {
  const cls =
    state === "invited"
      ? FAMILY_CLASS.sent
      : state === "rejected"
        ? FAMILY_CLASS.failed
        : state === "needs_human"
          ? FAMILY_CLASS.human
          : state === "new"
            ? "bg-[var(--accent-soft)] text-[var(--accent)]"
            : NEUTRAL;
  return <Badge cls={cls}>{THREAD_STATE_LABEL[state] ?? state}</Badge>;
}
