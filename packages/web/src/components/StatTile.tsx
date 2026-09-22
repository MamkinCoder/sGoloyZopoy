import type { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "ok" | "warn" | "bad";
}

const TONE = { default: "", ok: "text-[var(--ok)]", warn: "text-[var(--warn)]", bad: "text-[var(--bad)]" };

export function StatTile({ label, value, sub, tone = "default" }: Props) {
  return (
    <div className="card px-3 py-2.5 min-w-0">
      <div className="text-[12px] muted truncate">{label}</div>
      <div className={`text-[26px] leading-tight font-semibold ${TONE[tone]}`}>{value}</div>
      {sub && <div className="text-[12px] faint mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
