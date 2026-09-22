import { describe, expect, it } from "vitest";
import { harness } from "./fakes.js";

describe("users & profile", () => {
  it("lists users and patches fields via snake_case or camelCase", async () => {
    const h = await harness();
    const list = await (await h.get("/api/users")).json();
    expect(list).toHaveLength(1);
    expect(list[0].slug).toBe("yaroslav");

    const res = await h.json("PUT", "/api/users/yaroslav", { daily_limit_hh: 5, opusEnabled: true, tg_chat_id: "123" });
    expect(res.status).toBe(200);
    const u = await res.json();
    expect(u.dailyLimitHH).toBe(5);
    expect(u.opusEnabled).toBe(true);
    expect(u.tgChatId).toBe("123");
    expect(u.dailyLimitCareer).toBe(10);

    expect((await h.json("PUT", "/api/users/nobody", { name: "x" })).status).toBe(404);
    const bad = await h.json("PUT", "/api/users/yaroslav", { daily_limit_hh: -1 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/daily_limit_hh/);
  });

  it("profile roundtrip fills defaults and validates types", async () => {
    const h = await harness();
    const empty = await (await h.get("/api/users/yaroslav/profile")).json();
    expect(empty.work_formats).toEqual([]);
    expect(empty.salary_from).toBe(0);

    const put = await h.json("PUT", "/api/users/yaroslav/profile", { full_name: "Y", verified_skills: ["go"], salary_from: 100 });
    expect(put.status).toBe(200);
    const saved = await (await h.get("/api/users/yaroslav/profile")).json();
    expect(saved.full_name).toBe("Y");
    expect(saved.verified_skills).toEqual(["go"]);
    expect(saved.languages).toEqual([]);
    expect(saved.extra).toEqual({});

    const bad = await h.json("PUT", "/api/users/yaroslav/profile", { verified_skills: "go" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/verified_skills/);
  });

  it("stats maps to snake_case and validates range", async () => {
    const h = await harness();
    const s = await (await h.get("/api/users/yaroslav/stats?range=7d")).json();
    expect(s).toEqual({ sent: 1, skipped: 2, failed: 0, by_status: { SENT: 1 }, invitations: 0, rejections: 0, chat_replies: 0, runs_count: 1 });
    expect((await h.get("/api/users/yaroslav/stats?range=yesterday")).status).toBe(400);
  });
});
