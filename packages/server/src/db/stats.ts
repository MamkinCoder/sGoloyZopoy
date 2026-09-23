import type { Stats, Status, Store } from "@sgz/shared";
import { userAnalytics } from "./analytics.js";
import { BOT_OUT } from "./analytics.js";
import { num, str, type Param, type Row, type Sql } from "./sql.js";

type StatsRepo = Pick<Store, "userStats" | "userAnalytics">;

export function statsRepo(s: Sql): StatsRepo {
  const count = (sql: string, ...params: Param[]): number => num((s.get(sql, ...params) as Row).n);
  return {
    userStats(userId, sinceISO) {
      const since = sinceISO ?? "";
      const byStatus: Partial<Record<Status, number>> = {};
      let sent = 0;
      let skipped = 0;
      let failed = 0;
      for (const r of s.all(
        "SELECT status, COUNT(*) AS n FROM applications WHERE user_id = ? AND created_at >= ? GROUP BY status",
        userId,
        since,
      )) {
        const status = str(r.status) as Status;
        const n = num(r.n);
        byStatus[status] = n;
        if (status === "SENT") sent += n;
        else if (status.startsWith("SKIP_")) skipped += n;
        else if (status.startsWith("FAILED_")) failed += n;
      }
      return {
        sent,
        skipped,
        failed,
        byStatus,
        invitations: count(
          "SELECT COUNT(*) AS n FROM chat_threads WHERE user_id = ? AND state = 'invited' AND last_seen_at >= ?",
          userId,
          since,
        ),
        rejections: count(
          "SELECT COUNT(*) AS n FROM chat_threads WHERE user_id = ? AND state = 'rejected' AND last_seen_at >= ?",
          userId,
          since,
        ),
        chatReplies: count(
          `SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
           WHERE t.user_id = ? AND ${BOT_OUT} AND m.created_at >= ?`,
          userId,
          since,
        ),
        runsCount: count("SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND started_at >= ?", userId, since),
      } satisfies Stats;
    },
    userAnalytics: (userId, sinceISO) => userAnalytics(s, userId, sinceISO),
  };
}
