import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useNavigate } from "react-router-dom";
import { ApiError, UNAUTHORIZED_EVENT } from "./api/client";
import { useMe, useUsers } from "./api/hooks";
import { Layout } from "./components/Layout";
import { Toaster } from "./components/Toast";
import { Spinner } from "./components/Ui";
import { ApplicationsPage } from "./pages/Applications";
import { ChatsPage } from "./pages/Chats";
import { KbPage } from "./pages/Kb";
import { DashboardPage } from "./pages/Dashboard";
import { FilteredPage } from "./pages/Filtered";
import { LoginPage } from "./pages/Login";
import { QueuePage } from "./pages/Queue";
import { ResumesPage } from "./pages/Resumes";
import { RunDetailPage } from "./pages/RunDetail";
import { RunsPage } from "./pages/Runs";
import { SettingsPage } from "./pages/Settings";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

function RequireAuth() {
  const me = useMe();
  const nav = useNavigate();
  useEffect(() => {
    const h = () => nav("/login", { replace: true });
    window.addEventListener(UNAUTHORIZED_EVENT, h);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, h);
  }, [nav]);
  if (me.isLoading) return <Spinner />;
  if (!me.data?.authenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function RootRedirect() {
  const { data: users, isLoading } = useUsers();
  if (isLoading) return <Spinner />;
  const first = users?.[0]?.slug;
  return first ? <Navigate to={`/u/${first}`} replace /> : <div className="p-6 muted">Нет пользователей</div>;
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <RootRedirect /> },
      {
        path: "/u/:slug",
        element: <Layout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "runs", element: <RunsPage /> },
          { path: "runs/:id", element: <RunDetailPage /> },
          { path: "applications", element: <ApplicationsPage /> },
          { path: "queue", element: <QueuePage /> },
          { path: "filtered", element: <FilteredPage /> },
          { path: "resumes", element: <ResumesPage /> },
          { path: "chats", element: <ChatsPage /> },
          { path: "chats/:id", element: <ChatsPage /> },
          { path: "kb", element: <KbPage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}
