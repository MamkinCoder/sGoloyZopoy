import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useParams } from "react-router-dom";
import { useLogout, useMe, useQueue, useUsers } from "../api/hooks";
import { HealthChip } from "./HealthChip";
import { RunDialog } from "./RunDialog";
import { Spinner } from "./Ui";

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: "", label: "Обзор", end: true },
  { to: "runs", label: "Запуски" },
  { to: "applications", label: "Отклики" },
  { to: "queue", label: "Очередь" },
  { to: "filtered", label: "Отфильтровано" },
  { to: "resumes", label: "Резюме" },
  { to: "chats", label: "Чаты" },
  { to: "settings", label: "Настройки" },
];

type Theme = "auto" | "light" | "dark";
const THEME_LABEL: Record<Theme, string> = { auto: "Авто", light: "Светлая", dark: "Тёмная" };

/** auto → light → dark; pinned value lives in localStorage (index.html applies it before first paint). */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const v = localStorage.getItem("sgz_theme");
      return v === "light" || v === "dark" ? v : "auto";
    } catch {
      return "auto";
    }
  });
  const next = () => {
    const n: Theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    setTheme(n);
    if (n === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = n;
    try {
      if (n === "auto") localStorage.removeItem("sgz_theme");
      else localStorage.setItem("sgz_theme", n);
    } catch {
      /* private mode: the theme just won't persist */
    }
  };
  return (
    <button type="button" className="btn btn-sm" onClick={next} title="Тема: авто / светлая / тёмная" aria-label={`Тема: ${THEME_LABEL[theme]}`}>
      ◐<span className="hidden sm:inline">{THEME_LABEL[theme]}</span>
    </button>
  );
}

export function Layout() {
  const { slug = "" } = useParams();
  const { data: users, isLoading } = useUsers();
  const logout = useLogout();
  const me = useMe();
  const authRequired = me.data?.auth_required !== false;
  const [runOpen, setRunOpen] = useState(false);
  const queued = useQueue(slug).data?.length ?? 0;

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
              <ThemeToggle />
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
                {n.to === "queue" && queued > 0 && <span className="ml-1 chip px-1.5 text-[11px]">{queued}</span>}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-[1280px] w-full mx-auto px-4 py-4 flex-1 min-w-0">
        <Outlet />
      </main>
      <RunDialog key={slug} open={runOpen} onClose={() => setRunOpen(false)} slug={slug} />
    </div>
  );
}
