import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useLogin, useMe } from "../api/hooks";

export function LoginPage() {
  const me = useMe();
  const login = useLogin();
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (me.data?.authenticated || me.data?.auth_required === false) return <Navigate to="/" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    login.mutate(password, {
      onSuccess: () => nav("/", { replace: true }),
      onError: (err) => setError(err.message === "401 Unauthorized" ? "Неверный пароль" : err.message),
    });
  };

  return (
    <div className="min-h-full flex items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-xs p-5 grid gap-3">
        <div>
          <div className="font-bold text-lg">sGZ</div>
          <div className="muted text-[13px]">Вход в панель</div>
        </div>
        <input
          className="input"
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="text-[var(--bad)] text-[13px]">{error}</div>}
        <button type="submit" className="btn btn-primary justify-center" disabled={login.isPending || !password}>
          Войти
        </button>
      </form>
    </div>
  );
}
