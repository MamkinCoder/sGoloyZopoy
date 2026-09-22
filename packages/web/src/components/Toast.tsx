import { useEffect, useState } from "react";
import { dismissToast, getToasts, subscribeToasts, type ToastItem } from "../lib/toast";

const COLOR: Record<ToastItem["kind"], string> = {
  info: "border-[var(--accent)]",
  ok: "border-[var(--ok)]",
  error: "border-[var(--bad)]",
};

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>(getToasts);
  useEffect(() => subscribeToasts(setItems), []);
  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-50 flex flex-col gap-2 sm:w-[360px]" role="status" aria-live="polite">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismissToast(t.id)}
          className={`card text-left px-3 py-2 text-[13px] shadow-lg border-l-4 ${COLOR[t.kind]} cursor-pointer`}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
