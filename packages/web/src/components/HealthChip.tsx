import { useState } from "react";
import { Link } from "react-router-dom";
import { useHealth } from "../api/hooks";
import { fmtMb, fmtRel } from "../lib/format";

export function HealthChip({ slug }: { slug: string }) {
  const { data: h, isError } = useHealth();
  const [open, setOpen] = useState(false);
  const dot = isError || !h ? "bg-[var(--bad)]" : h.ok ? "bg-[var(--ok)]" : "bg-[var(--warn)]";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="btn btn-sm gap-2 font-normal"
        title={h ? `v${h.version} · uptime ${Math.round(h.uptime_s / 3600)} ч` : "нет связи с сервером"}
      >
        <span className={`inline-block size-2 rounded-full ${dot}`} />
        {h ? (
          <>
            <span className="tabular-nums">{fmtMb(h.mem_rss_mb)}</span>
            <span className="faint hidden sm:inline">·</span>
            <span className="hidden sm:inline">
              {h.active_run_id ? (
                <Link to={`/u/${slug}/runs/${h.active_run_id}`} className="text-[var(--accent)]">
                  run #{h.active_run_id}
                </Link>
              ) : (
                <span className="muted">нет запуска</span>
              )}
            </span>
            <span className="faint hidden md:inline">·</span>
            <span className="hidden md:inline muted">{h.scheduler_next ? `след. ${fmtRel(h.scheduler_next)}` : "расписание выкл"}</span>
          </>
        ) : (
          <span className="muted">офлайн</span>
        )}
      </button>
      {open && h && (
        <div className="card absolute right-0 top-9 z-30 w-72 p-3 text-[12px] shadow-lg" onMouseLeave={() => setOpen(false)}>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="muted">Версия</span>
            <span>{h.version}</span>
            <span className="muted">Uptime</span>
            <span>{Math.round(h.uptime_s / 3600)} ч</span>
            <span className="muted">RSS</span>
            <span>{fmtMb(h.mem_rss_mb)}</span>
            <span className="muted">Свободно</span>
            <span>{fmtMb(h.mem_available_mb)}</span>
            <span className="muted">Активный run</span>
            <span>{h.active_run_id ? `#${h.active_run_id}` : "—"}</span>
            <span className="muted">Следующий</span>
            <span>{h.scheduler_next ? fmtRel(h.scheduler_next) : "—"}</span>
          </div>
          <div className="mt-2 pt-2 border-t border-[var(--border)]">
            <div className="muted mb-1">Сессии hh</div>
            {h.users.map((u) => (
              <div key={u.slug} className="flex justify-between">
                <span>{u.slug}</span>
                <span className={u.hh_login_ok === false ? "text-[var(--bad)]" : u.hh_login_ok ? "text-[var(--ok)]" : "faint"}>
                  {u.hh_login_ok === null ? "неизвестно" : u.hh_login_ok ? "ок" : "нет"}
                  {u.cookies_age_h != null && <span className="faint"> · {Math.round(u.cookies_age_h)} ч</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 pt-2 border-t border-[var(--border)] faint">
            chromium {h.tools.chromium ?? "—"} · claude {h.tools.claude ?? "—"} · xelatex {h.tools.xelatex ?? "—"}
          </div>
        </div>
      )}
    </div>
  );
}
