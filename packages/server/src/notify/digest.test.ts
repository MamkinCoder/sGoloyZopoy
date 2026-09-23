import { describe, expect, it } from "vitest";
import { Status, type ApplicationRow, type ChatThread, type Stats, type User } from "@sgz/shared";
import { buildDigest, digestDue, queueList } from "./digest.js";

const user = { id: 1, slug: "yaroslav", name: "Ярослав" } as User;
const now = new Date("2026-09-23T17:00:00Z"); // 20:00 in Moscow
const row = (title: string, createdAt: string) => ({ application: { status: Status.QUEUED, createdAt }, vacancy: { title, company: "Acme" } }) as ApplicationRow;
const stats: Stats = { sent: 7, skipped: 3, failed: 0, byStatus: { SENT: 7, QUEUED: 2 }, invitations: 1, rejections: 0, chatReplies: 4, runsCount: 5 };

describe("digest", () => {
  it("summarises the day, stale queue items and chats waiting for the human", () => {
    let since = "";
    const rows = [row("Свежая", "2026-09-22T10:00:00Z"), row("Старая", "2026-09-10T10:00:00Z")];
    const text = buildDigest(
      {
        userStats: (_id, s) => ((since = s ?? ""), stats),
        listApplications: () => ({ items: rows, total: rows.length }),
        listChatThreads: () => [{ employer: "Рога и Копыта" } as ChatThread],
      },
      user,
      "Europe/Moscow",
      now,
      "http://pi:8080",
    );
    expect(since).toBe("2026-09-22T21:00:00.000Z"); // Moscow midnight
    expect(text).toContain("отправлено 7 · в очередь 2");
    expect(text).toContain("4 ответа бота · 1 приглашение");
    expect(text).toContain("В очереди на проверку: 2 · http://pi:8080/u/yaroslav/queue");
    expect(text).toContain("Протухают (старше 5 дн.): 1\n• Старая · Acme (13 дн.)");
    expect(text).not.toContain("• Свежая");
    expect(text).toContain("Чаты ждут тебя: 1");
  });

  it("lists the queue oldest first", () => {
    const rows = [row("B", "2026-09-22T10:00:00Z"), row("A", "2026-09-10T10:00:00Z")];
    expect(queueList({ listApplications: () => ({ items: rows, total: 2 }) }, user, "")).toBe("Ярослав: в очереди 2\n• A · Acme\n• B · Acme");
    expect(queueList({ listApplications: () => ({ items: [], total: 0 }) }, user, "")).toBe("Ярослав: очередь пуста");
  });

  it("is due once a day after the configured time", () => {
    expect(digestDue("20:00", "", now, "Europe/Moscow")).toBe("2026-09-23");
    expect(digestDue("20:00", "2026-09-23", now, "Europe/Moscow")).toBeNull();
    expect(digestDue("20:01", "", now, "Europe/Moscow")).toBeNull();
    expect(digestDue("", "", now, "Europe/Moscow")).toBeNull();
  });
});
