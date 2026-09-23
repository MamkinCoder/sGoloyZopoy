import { describe, expect, it } from "vitest";
import { Status, type AnalyticsCount, type AnalyticsDTO, type ApplicationRow, type ChatThread, type User } from "@sgz/shared";
import { buildRetro, delta, retroDue, weeklyRetro } from "./retro.js";

const user = { id: 1, slug: "y", name: "Я" } as User;
const now = new Date("2026-09-27T16:00:00Z"); // Sunday 19:00 in Moscow
const DAY = 86_400_000;

type K = { sent: number; responded: number; invitations: number };
/** week = last 7 days, two = last 14 days (what userAnalytics returns for each `since`). */
function store(week: K, two: K, directions: AnalyticsCount[] = [], extra: { queued?: string[]; threads?: Partial<ChatThread>[] } = {}) {
  const weekSince = new Date(now.getTime() - 7 * DAY).toISOString();
  return {
    userAnalytics: (_id: number, since: string | null) => ({ kpi: since === weekSince ? week : two, directions }) as unknown as AnalyticsDTO,
    listApplications: () => {
      const items = (extra.queued ?? []).map((createdAt) => ({ application: { status: Status.QUEUED, createdAt }, vacancy: {} }) as ApplicationRow);
      return { items, total: items.length };
    },
    listChatThreads: () => (extra.threads ?? []) as ChatThread[],
  };
}

describe("weeklyRetro", () => {
  it("is null for a week under 10 sends", () => {
    expect(weeklyRetro(store({ sent: 9, responded: 5, invitations: 1 }, { sent: 50, responded: 20, invitations: 3 }), user, now)).toBeNull();
    expect(buildRetro(store({ sent: 9, responded: 0, invitations: 0 }, { sent: 9, responded: 0, invitations: 0 }), user, "Europe/Moscow", now)).toBeNull();
  });

  it("compares with the week before as 14 days minus this week, only with enough sends there", () => {
    const r = weeklyRetro(store({ sent: 20, responded: 5, invitations: 2 }, { sent: 30, responded: 6, invitations: 2 }), user, now)!;
    expect(r.sent).toBe(20);
    expect(r.response_rate).toBe(0.25);
    expect(r.prev).toEqual({ sent: 10, response_rate: 0.1, invite_rate: 0 });
    expect(weeklyRetro(store({ sent: 20, responded: 5, invitations: 2 }, { sent: 29, responded: 5, invitations: 2 }), user, now)!.prev).toBeNull();
  });

  it("picks the best direction by invite rate and a zero-answer mismatch, both behind min samples", () => {
    const dirs: AnalyticsCount[] = [
      { key: "tiny", n: 4, hh: 4, resp: 4, inv: 4 }, // under MIN_N
      { key: "go", n: 10, hh: 10, resp: 3, inv: 2 },
      { key: "python", n: 6, hh: 5, resp: 4, inv: 0 },
      { key: "frontend", n: 9, hh: 8, resp: 0, inv: 0 },
      { key: "qa", n: 7, hh: 7, resp: 0, inv: 0 }, // under MISMATCH_N
      { key: "—", n: 20, hh: 20, resp: 0, inv: 0 },
    ];
    const r = weeklyRetro(store({ sent: 12, responded: 3, invitations: 1 }, { sent: 12, responded: 3, invitations: 1 }, dirs), user, now)!;
    expect(r.best).toEqual({ key: "go", hh: 10, resp: 3, inv: 2 });
    expect(r.mismatch).toEqual({ key: "frontend", hh: 8 });
  });

  it("counts stale queue items and this week's interviews, formats it all", () => {
    const k = { sent: 15, responded: 3, invitations: 1 };
    const s = store(k, { sent: 27, responded: 3, invitations: 2 }, [], {
      queued: [new Date(now.getTime() - 4 * DAY).toISOString(), new Date(now.getTime() - DAY).toISOString()],
      threads: [
        { employer: "Acme", state: "invited", interviewAt: "2026-09-29T10:00:00.000Z" },
        { employer: "Old", state: "invited", interviewAt: "2026-09-01T10:00:00.000Z" },
        { employer: "None", state: "invited", interviewAt: null },
      ],
    });
    const r = weeklyRetro(s, user, now)!;
    expect(r.stale_queue).toBe(1);
    expect(r.interviews).toEqual([{ employer: "Acme", at: "2026-09-29T10:00:00.000Z", state: "invited" }]);
    const text = buildRetro(s, user, "Europe/Moscow", now)!;
    expect(text).toContain("отправлено 15 (↑ 3) · ответы 20% (↑ 20 п.п.) · приглашения 7% (↓ 2 п.п.)");
    expect(text).toContain("В очереди дольше 3 дн.: 1");
    expect(text).toContain("• Acme · 29.09 13:00 (приглашение)");
    expect(text).not.toMatch(/—|https?:/);
  });
});

describe("delta / retroDue", () => {
  it("delta arrows", () => {
    expect(delta(5, 5)).toBe(" (→)");
    expect(delta(0.3, 0.25, true)).toBe(" (↑ 5 п.п.)");
    expect(delta(5, undefined)).toBe("");
    expect(delta(null, 0.2, true)).toBe("");
  });

  it("due once on the configured weekday after the time", () => {
    expect(retroDue("sun", "19:00", "", now, "Europe/Moscow")).toBe("2026-09-27");
    expect(retroDue("sun", "19:00", "2026-09-27", now, "Europe/Moscow")).toBeNull();
    expect(retroDue("sun", "19:30", "", now, "Europe/Moscow")).toBeNull();
    expect(retroDue("mon", "19:00", "", now, "Europe/Moscow")).toBeNull();
    expect(retroDue("", "19:00", "", now, "Europe/Moscow")).toBeNull();
  });
});
