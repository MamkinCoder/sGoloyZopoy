// Telegram cards for new review-queue items. «Отправить» starts stage send:<id> (or parks the id until
// the runner is free), «Пропустить» marks the item SKIP_MANUAL. The tap is the human decision: nothing
// is submitted without it.
import { RunBusyError, Status, type RunService, type Store, type Vacancy } from "@sgz/shared";
import { escapeHtml } from "../notify/format.js";

const PENDING = "queue_send_pending";

/** `canSend` = false for boards the human applies to by hand (Habr Career): no «Отправить». */
export const queueButtons = (id: number, canSend = true) => [
  ...(canSend ? [{ text: "🚀 Отправить", data: `q:s:${id}` }] : []),
  { text: "⏭ Пропустить", data: `q:k:${id}` },
];

export function parseQueueCallback(data: string): { send: boolean; id: number } | null {
  const m = /^q:([sk]):(\d+)$/.exec(data);
  return m ? { send: m[1] === "s", id: Number(m[2]) } : null;
}

const money = (n: number) => n.toLocaleString("ru-RU").replace(/\s/g, " ");

/** HTML card: vacancy, why the LLM picked it, the start of the letter, links to the posting and the panel. */
export function formatQueueCard(v: Pick<Vacancy, "title" | "company" | "url" | "salaryFrom" | "salaryTo" | "currency">, reason: string, letter: string, queueUrl: string): string {
  const salary = v.salaryFrom || v.salaryTo ? [v.salaryFrom ? `от ${money(v.salaryFrom)}` : "", v.salaryTo ? `до ${money(v.salaryTo)}` : "", v.currency].filter(Boolean).join(" ") : "";
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
  return [
    `📥 <b>${escapeHtml(v.title)}</b> · ${escapeHtml(v.company)}`,
    salary,
    reason && `\n${escapeHtml(cut(reason, 300))}`,
    letter && `\nПисьмо: ${escapeHtml(cut(letter, 400))}`,
    `\n${escapeHtml(v.url)}`,
    queueUrl && `Очередь: ${escapeHtml(queueUrl)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const readPending = (store: Pick<Store, "getSetting">): number[] =>
  (store.getSetting(PENDING) ?? "").split(",").filter(Boolean).map(Number);

const startSend = (store: Store, runner: Pick<RunService, "start">, id: number, userId: number) => {
  const slug = store.listUsers().find((u) => u.id === userId)?.slug;
  if (!slug) throw new Error("user not found");
  return runner.start({ userSlug: slug, source: "career", stage: `send:${id}`, dryRun: false, limit: 0, trigger: "manual" });
};

/** Applies a card tap; returns the note appended to the card. */
export async function handleQueueTap(store: Store, runner: Pick<RunService, "start" | "active">, cb: { send: boolean; id: number }): Promise<string> {
  const row = store.getApplication(cb.id);
  if (!row || row.application.status !== Status.QUEUED) return `уже обработано${row ? ` (${row.application.status})` : ""}`;
  if (!cb.send) {
    store.updateApplicationStatus(cb.id, Status.SKIP_MANUAL, "skipped in telegram");
    return "⏭ пропущено";
  }
  const park = () => {
    store.setSetting(PENDING, [...new Set([...readPending(store), cb.id])].join(","));
    return "⏳ бот занят, отправлю, как освободится";
  };
  if (runner.active()) return park();
  try {
    await startSend(store, runner, cb.id, row.application.userId);
    return "🚀 отправляю";
  } catch (e) {
    if (e instanceof RunBusyError) return park();
    throw e;
  }
}

/** Starts the oldest parked send while the runner is idle. Returns true when a run was started. */
export async function startPendingSend(store: Store, runner: Pick<RunService, "start">): Promise<boolean> {
  const ids = readPending(store);
  while (ids.length) {
    const id = ids.shift()!;
    store.setSetting(PENDING, ids.join(","));
    const row = store.getApplication(id);
    if (row?.application.status !== Status.QUEUED) continue; // sent or skipped from the panel meanwhile
    try {
      await startSend(store, runner, id, row.application.userId);
    } catch (e) {
      store.setSetting(PENDING, [id, ...ids].join(",")); // keep it parked for the next idle minute
      throw e;
    }
    return true;
  }
  return false;
}
