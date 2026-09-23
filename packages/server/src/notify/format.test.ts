import { describe, expect, it } from "vitest";
import type { Run, RunStats, User } from "@sgz/shared";
import { formatReport } from "./format.js";

const user: User = {
  id: 1,
  slug: "yaroslav",
  name: "Ярослав",
  tgChatId: "",
  dailyLimitHH: 10,
  dailyLimitCareer: 10,
  active: true,
  allowOtherCountry: false,
  poolExpandPerDay: 2,
  opusEnabled: false,
};

const stats = (by_status: RunStats["by_status"]): RunStats => ({
  found: 0,
  deduped: 0,
  by_status,
  chat_replies: 0,
  invitations: 0,
  rejections: 0,
  top_vacancies: [],
  dry_run: false,
  llm_calls: 0,
});

const run = (by_status: RunStats["by_status"]): Run => ({
  id: 1,
  userId: 1,
  source: "hh",
  trigger: "manual",
  startedAt: "2026-09-23T09:00:00.000Z",
  finishedAt: "2026-09-23T09:05:00.000Z",
  status: "done",
  stats: stats(by_status),
  tgSent: false,
  error: "",
});

describe("formatReport", () => {
  it("adds a queue link when panelUrl is set and QUEUED > 0", () => {
    const text = formatReport(user, run({ SENT: 2, QUEUED: 3 }), "http://sgz.rp.i");
    expect(text).toContain("В очереди на проверку: 3");
    expect(text).toContain('<a href="http://sgz.rp.i/u/yaroslav/queue">Открыть очередь</a>');
  });

  it("omits the queue link when QUEUED is 0", () => {
    const text = formatReport(user, run({ SENT: 2 }), "http://sgz.rp.i");
    expect(text).not.toContain("Открыть очередь");
  });

  it("omits the queue link when panelUrl is empty", () => {
    const text = formatReport(user, run({ SENT: 2, QUEUED: 1 }), "");
    expect(text).not.toContain("Открыть очередь");
    expect(text).not.toContain("Панель:");
  });
});
