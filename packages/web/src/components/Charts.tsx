// Hand-rolled SVG charts: daily column charts (stacked or grouped) and a funnel.
// No chart dependency: three chart shapes, all bars, ~200 lines.
import { useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from "react";
import { fmtInt } from "../lib/format";

export interface Series {
  key: string;
  name: string;
  color: string; // CSS color, e.g. var(--s1)
}

export interface ColumnRow {
  label: string; // YYYY-MM-DD
  values: Record<string, number>;
}

const PAD = { l: 34, r: 6, t: 8, b: 20 };
const GAP = 2; // surface gap between touching marks

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** 0 .. clean max with ~3 steps of 1/2/5 × 10^k. */
function ticks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw);
  const out = [];
  for (let v = 0; v < max + step; v += step) out.push(v);
  return out;
}

/** Bar with 4px rounded data-end, square at the baseline. */
function bar(x: number, y: number, w: number, h: number, round: boolean): string {
  const r = round ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

export function Legend({ series }: { series: Series[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] muted mb-2">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

export function ColumnChart({ rows, series, stacked = true, height = 180 }: { rows: ColumnRow[]; series: Series[]; stacked?: boolean; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = rows.length;
  const plotW = Math.max(0, width - PAD.l - PAD.r);
  const plotH = height - PAD.t - PAD.b;
  const band = n ? plotW / n : 0;
  const total = (r: ColumnRow) => series.reduce((a, s) => a + (r.values[s.key] ?? 0), 0);
  const max = Math.max(0, ...rows.map((r) => (stacked ? total(r) : Math.max(...series.map((s) => r.values[s.key] ?? 0)))));
  const tk = ticks(max);
  const top = tk[tk.length - 1];
  const y = (v: number) => PAD.t + plotH - (v / top) * plotH;
  const k = series.length;
  const groupW = Math.min(stacked ? 24 : 24 * k + GAP * (k - 1), band * (band > 6 ? 0.72 : 1));
  const barW = stacked ? groupW : Math.max(1, (groupW - GAP * (k - 1)) / k);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 48))));

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left - PAD.l;
    const i = Math.floor(x / band);
    setHover(i >= 0 && i < n ? i : null);
  };

  const h = hover !== null ? rows[hover] : null;
  const tipLeft = hover !== null ? Math.min(Math.max(PAD.l + band * (hover + 0.5) - 70, 0), Math.max(0, width - 140)) : 0;

  return (
    <div>
      {k > 1 && <Legend series={series} />}
      <div ref={ref} className="relative" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={series.map((s) => s.name).join(", ")}>
            {tk.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--border)" : "var(--grid)"} strokeWidth={1} />
                <text x={PAD.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-3)" className="tabular-nums">
                  {fmtInt(t)}
                </text>
              </g>
            ))}
            {hover !== null && <rect x={PAD.l + band * hover} y={PAD.t} width={band} height={plotH} fill="var(--surface-2)" />}
            {rows.map((r, i) => {
              const x0 = PAD.l + band * i + (band - groupW) / 2;
              if (stacked) {
                const segs = series.map((s) => ({ s, v: r.values[s.key] ?? 0 })).filter((x) => x.v > 0);
                let acc = 0;
                return (
                  <g key={r.label}>
                    {segs.map(({ s, v }, j) => {
                      const yTop = y(acc + v);
                      const hh = y(acc) - yTop - (j > 0 ? GAP : 0);
                      acc += v;
                      return hh > 0 ? <path key={s.key} d={bar(x0, yTop, barW, hh, j === segs.length - 1)} fill={s.color} /> : null;
                    })}
                  </g>
                );
              }
              return (
                <g key={r.label}>
                  {series.map((s, j) => {
                    const v = r.values[s.key] ?? 0;
                    return v > 0 ? <path key={s.key} d={bar(x0 + j * (barW + GAP), y(v), barW, y(0) - y(v), true)} fill={s.color} /> : null;
                  })}
                </g>
              );
            })}
            {rows.map((r, i) =>
              i % labelEvery === 0 ? (
                <text key={r.label} x={PAD.l + band * (i + 0.5)} y={height - 5} textAnchor="middle" fontSize={11} fill="var(--text-3)">
                  {dm(r.label)}
                </text>
              ) : null,
            )}
          </svg>
        )}
        {h && (
          <div className="card absolute top-0 pointer-events-none px-2 py-1.5 text-[12px] shadow-sm w-[140px]" style={{ left: tipLeft }}>
            <div className="font-semibold mb-0.5">{dm(h.label)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm" style={{ background: s.color }} />
                <span className="muted flex-1 truncate">{s.name}</span>
                <span className="tabular-nums">{fmtInt(h.values[s.key] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="mt-1 text-[12px]">
        <summary className="faint cursor-pointer select-none">Таблица</summary>
        <div className="max-h-56 overflow-auto mt-1">
          <table className="w-full tabular-nums">
            <thead>
              <tr>
                <th className="th">День</th>
                {series.map((s) => (
                  <th key={s.key} className="th text-right">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.label}>
                  <td className="td">{dm(r.label)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="td text-right">
                      {fmtInt(r.values[s.key] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Funnel as horizontal bars: width = share of the first step, right column = conversion from the previous step. */
export function Funnel({ steps }: { steps: { key: string; label: ReactNode; n: number }[] }) {
  const first = Math.max(1, ...steps.map((s) => s.n));
  return (
    <div className="grid gap-2">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].n : 0;
        return (
          <div key={s.key} className="grid grid-cols-[84px_minmax(0,1fr)_auto_40px] sm:grid-cols-[120px_minmax(0,1fr)_auto_44px] items-center gap-2 text-[12px]">
            <div className="truncate muted">{s.label}</div>
            <div className="h-4">
              <div className="h-full rounded-r bg-[var(--s1)]" style={{ width: `${s.n ? Math.max(1, (s.n / first) * 100) : 0}%` }} />
            </div>
            <span className="tabular-nums font-semibold text-right">{fmtInt(s.n)}</span>
            <span className="tabular-nums faint text-right">{i > 0 && prev > 0 ? `${Math.round((s.n / prev) * 100)}%` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
