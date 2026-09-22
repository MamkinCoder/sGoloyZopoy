import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useParams } from "react-router-dom";
import { useLogout, useMe, useUsers } from "../api/hooks";
import { HealthChip } from "./HealthChip";
import { RunDialog } from "./RunDialog";
import { Spinner } from "./Ui";

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: "", label: "Обзор", end: true },
  { to: "runs", label: "Запуски" },
  { to: "applications", label: "Отклики" },
  { to: "resumes", label: "Резюме" },
  { to: "chats", label: "Чаты" },
  { to: "settings", label: "Настройки" },
];

export function Layout() {
  const { slug = "" } = useParams();
  const { data: users, isLoading } = useUsers();
  const logout = useLogout();
  const me = useMe();
  const authRequired = me.data?.auth_required !== false;
  const [runOpen, setRunOpen] = useState(false);

  useEffect(() => {
    const u = users?.find((x) => x.slug === slug);
    document.title = u ? `${u.name} · sGZ` : "sGZ панель";
  }, [users, slug]);

  if (isLoading) return <Spinner />;
  if (users && users.length && !users.some((u) => u.slug === slug)) return <Navigate to={`/u/${users[0]!.slug}`} replace />;

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-20 bg-[var(--surface)] border-b border-[var(--border)]">
        <div className="max-w-[1280px] mx-auto px-4">
          <div className="flex items-center gap-3 h-12">
            <span className="font-bold tracking-tight text-[15px]">sGZ</span>
            <nav className="flex gap-1 overflow-x-auto" aria-label="Пользователи">
              {users?.map((u) => (
                <NavLink
                  key={u.slug}
                  to={`/u/${u.slug}`}
                  className={({ isActive }) =>
                    `px-2.5 h-7 inline-flex items-center rounded-md text-[13px] whitespace-nowrap ${isActive ? "bg-[var(--accent-soft)] text-[var(--accent)] font-medium" : "muted hover:bg-[var(--surface-2)]"} ${u.active ? "" : "line-through"}`
                  }
                  style={{ textDecoration: "none" }}
                >
                  {u.name}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <HealthChip slug={slug} />
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setRunOpen(true)}>
                ▶ Запустить
              </button>
              {authRequired && (
                <button type="button" className="btn btn-sm hidden sm:inline-flex" onClick={() => logout.mutate()} title="Выйти">
                  Выйти
                </button>
              )}
            </div>
          </div>
          <nav className="tabs -mx-4 px-4 border-b-0" aria-label="Разделы">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `tab ${isActive ? "tab-active" : ""}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-[1280px] w-full mx-auto px-4 py-4 flex-1 min-w-0">
        <Outlet />
      </main>
      <RunDialog open={runOpen} onClose={() => setRunOpen(false)} slug={slug} />
    </div>
  );
}
