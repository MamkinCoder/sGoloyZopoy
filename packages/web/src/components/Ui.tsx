import type { ReactNode } from "react";

export function Spinner({ label = "Загрузка…" }: { label?: string }) {
  return <div className="faint text-[13px] py-6 text-center">{label}</div>;
}

export function Empty({ children = "Пусто" }: { children?: ReactNode }) {
  return <div className="faint text-[13px] py-6 text-center">{children}</div>;
}

export function Section({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--border)]">
          <h3 className="text-[13px] font-semibold">{title}</h3>
          {right}
        </div>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block text-[11px] faint mt-1">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-[13px] cursor-pointer select-none">
      <input type="checkbox" className="accent-[var(--accent)] size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Horizontal bar list: one hue, label + count in text tokens, bar carries magnitude only. */
export function BarList({ rows, max }: { rows: { key: string; label: ReactNode; value: number; family?: string }[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <Empty />;
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 items-center text-[12px]">
          <div className="flex items-center gap-2 min-w-0">
            <div className="truncate min-w-[110px] max-w-[45%]">{r.label}</div>
            <div className="flex-1 h-2 rounded-sm bg-[var(--surface-2)] overflow-hidden">
              <div className="h-full rounded-sm bg-[var(--accent)]" style={{ width: `${Math.max(2, (r.value / top) * 100)}%` }} />
            </div>
          </div>
          <div className="tabular-nums text-right w-8">{r.value}</div>
        </div>
      ))}
    </div>
  );
}
