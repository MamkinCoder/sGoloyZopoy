import { describe, expect, it } from "vitest";
import { defaultProfile } from "../../src/config/profile.js";
import { FakeLLM } from "../../src/llm/fake.js";
import { harness } from "./fakes.js";

describe("chats", () => {
  it("threads carry vacancy summary, unanswered count, last message", async () => {
    const h = await harness();
    const u = h.store.getUserBySlug("yaroslav")!;
    const v = h.store.upsertVacancy({ source: "hh", externalId: "1", url: "https://hh.ru/vacancy/1", title: "Go", company: "Co", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "" });
    const t = h.store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: true, vacancyId: v.id, employer: "Co", state: "new", lastSeenAt: "2026-01-01T00:00:00Z" });
    h.store.insertChatMessages(t.id, [
      { hhMessageId: "m1", direction: "in", author: "bot", text: "Salary?", isQuestion: true, answered: false },
      { hhMessageId: "m2", direction: "in", author: "bot", text: "Remote ok?", isQuestion: true, answered: true },
      { hhMessageId: null, direction: "out", author: "me", text: "Yes", isQuestion: false, answered: false },
    ]);
    const threads = await (await h.get("/api/users/yaroslav/chats")).json();
    expect(threads[0]).toMatchObject({ id: t.id, vacancy: { id: v.id, title: "Go", company: "Co" }, unanswered: 1, last_message: "Yes" });
    const msgs = await (await h.get(`/api/chats/${t.id}/messages`)).json();
    expect(msgs).toHaveLength(3);
  });

  it("PUT interview sets, normalizes and clears the time; 404 for another user's thread", async () => {
    const h = await harness();
    const u = h.store.getUserBySlug("yaroslav")!;
    const t = h.store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: null, employer: "Co", state: "invited", lastSeenAt: "" });
    const set = await h.json("PUT", `/api/users/yaroslav/chats/${t.id}/interview`, { interview_at: "2026-09-25T14:00:00+03:00" });
    expect(await set.json()).toMatchObject({ id: t.id, interviewAt: "2026-09-25T11:00:00.000Z" });
    expect((await h.json("PUT", `/api/users/yaroslav/chats/${t.id}/interview`, { interview_at: "завтра" })).status).toBe(400);
    expect(await (await h.json("PUT", `/api/users/yaroslav/chats/${t.id}/interview`, { interview_at: null })).json()).toMatchObject({ interviewAt: null });
    expect((await h.json("PUT", "/api/users/yaroslav/chats/999/interview", { interview_at: null })).status).toBe(404);
  });

  it("study pack: POST 202 builds in the background, GET returns the stored pack, 404 for another user's thread", async () => {
    const h = await harness({ llm: new FakeLLM() });
    const u = h.store.getUserBySlug("yaroslav")!;
    const other = h.store.upsertUser({ ...u, id: undefined, slug: "other", name: "Other" });
    h.store.saveProfile(u.id, { ...defaultProfile(), verified_skills: ["Go"] });
    const v = h.store.upsertVacancy({ source: "hh", externalId: "1", url: "https://hh.ru/vacancy/1", title: "Go dev", company: "Co", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "Go", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "" });
    const t = h.store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: v.id, employer: "Co", state: "invited", lastSeenAt: "" });
    const foreign = h.store.upsertChatThread({ userId: other.id, hhNegotiationId: "n2", isBot: false, vacancyId: v.id, employer: "Co", state: "invited", lastSeenAt: "" });
    const url = `/api/users/yaroslav/chats/${t.id}/study`;
    expect(await (await h.get(url)).json()).toEqual({ pack: null, generating: false, error: "" });
    expect((await h.json("POST", url)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    const got = await (await h.get(url)).json();
    expect(got.generating).toBe(false);
    expect(got.pack).toMatchObject({ vacancyTitle: "Go dev", company: "Co", checklist: [{ level: "must" }] });
    expect(got.pack.prompt).toContain("Позиция: Go dev в Co.");
    const list = await (await h.get("/api/users/yaroslav/chats")).json();
    expect(list[0]).toMatchObject({ id: t.id, has_study: true });
    expect(list[0]).not.toHaveProperty("study");
    expect((await h.get(`/api/users/yaroslav/chats/${foreign.id}/study`)).status).toBe(404);
    expect((await h.json("POST", `/api/users/yaroslav/chats/${foreign.id}/study`)).status).toBe(404);
  });
});

describe("career sites", () => {
  it("CRUD + onboard + adapters", async () => {
    const h = await harness({ adapters: ["greenhouse", "custom"] });
    const created = await h.json("POST", "/api/users/yaroslav/career-sites", { adapter: "greenhouse", base_url: "https://www.acme.io/careers", config: { filters: ["go"] } });
    expect(created.status).toBe(201);
    const site = await created.json();
    expect(site).toMatchObject({ slug: "acme-io", ats: "greenhouse", baseUrl: "https://www.acme.io/careers", profile: { filters: ["go"] }, enabled: true });

    const upd = await (await h.json("PUT", `/api/career-sites/${site.id}`, { name: "Acme", base_url: site.baseUrl, enabled: false })).json();
    expect(upd).toMatchObject({ id: site.id, name: "Acme", ats: "greenhouse", enabled: false });
    const renamed = await (await h.json("PUT", `/api/career-sites/${site.id}`, { name: "Acme renamed" })).json();
    expect(renamed).toMatchObject({ enabled: false, name: "Acme renamed" });
    // A PUT without config/profile keeps the learned profile; {profile} alone replaces it.
    expect(renamed.profile).toEqual({ filters: ["go"] });
    const hinted = await (await h.json("PUT", `/api/career-sites/${site.id}`, { profile: { filters: ["go"], apply_hints: "x" } })).json();
    expect(hinted.profile).toEqual({ filters: ["go"], apply_hints: "x" });
    expect(await (await h.get("/api/users/yaroslav/career-sites")).json()).toHaveLength(1);

    const onb = await h.json("POST", `/api/users/yaroslav/career-sites/${site.id}/onboard`);
    expect(onb.status).toBe(202);
    expect(h.runner.started[0]).toMatchObject({ source: "career", stage: `onboard:${site.id}` });
    expect((await h.json("POST", `/api/users/yaroslav/career-sites/${site.id}/run`)).status).toBe(202);
    expect(h.runner.started[1]).toMatchObject({ source: "career", stage: `site:${site.id}` });

    expect(await (await h.get("/api/adapters")).json()).toEqual(["greenhouse", "custom"]);
    expect((await h.json("POST", "/api/users/yaroslav/career-sites", { adapter: "greenhouse" })).status).toBe(400);
    expect((await h.json("DELETE", `/api/career-sites/${site.id}`)).status).toBe(200);
    expect((await h.json("DELETE", `/api/career-sites/${site.id}`)).status).toBe(404);
  });
});

describe("system", () => {
  it("health has the HealthDTO shape with injected hooks", async () => {
    const h = await harness({
      hhSessionCheck: () => ({ ok: true, cookiesAgeH: 3 }),
      schedulerNext: () => "2026-09-24T09:00:00Z",
      memAvailableMB: () => 900,
      toolVersions: () => ({ chromium: "130", claude: "2.0", xelatex: null }),
    });
    const body = await (await h.get("/api/health")).json();
    expect(body).toEqual({
      ok: true,
      version: "test",
      uptime_s: expect.any(Number),
      mem_rss_mb: expect.any(Number),
      mem_available_mb: 900,
      active_run_id: null,
      scheduler_next: "2026-09-24T09:00:00Z",
      users: [{ slug: "yaroslav", hh_login_ok: true, cookies_age_h: 3, career: { sites_enabled: 0, sites_left_today: 0, queue_left: expect.any(Number), daily_limit: expect.any(Number) } }],
      tools: { chromium: "130", claude: "2.0", xelatex: null },
      touch_last_at: null,
    });
    expect(body.mem_rss_mb).toBeGreaterThan(0);
  });

  it("settings fall back to config, PUT only allows the allowlist", async () => {
    const h = await harness();
    expect(await (await h.get("/api/settings")).json()).toEqual({
      schedule_at: "12:00",
      schedule_jitter_min: "20",
      dedup_window_days: "60",
      tz: "Europe/Moscow",
      company_limit_max: "10",
      company_limit_window_days: "30",
      company_limit_persona_lock: "1",
      feedback_request: "1",
      chat_track_since: "2026-09-23",
      chat_followup_days: "7",
      career_per_site: "3",
      career_per_aggregator: "8",
      career_sites_per_run: "1",
      career_autopilot: "1",
      run_max_min: "0",
      digest_at: "20:00",
      habr_daily_limit: "20",
      queue_tg_cards: "1",
      viewers_enabled: "1",
      retro_day: "sun",
      retro_at: "19:00",
      kb_review_mode: "always",
    });
    const put = await h.json("PUT", "/api/settings", { schedule_at: "09:30", dedup_window_days: 45 });
    expect(await put.json()).toMatchObject({ schedule_at: "09:30", dedup_window_days: "45" });
    expect(h.store.settings.get("dedup_window_days")).toBe("45");
    // 0/1 flags arrive as numbers from older panels; stored as strings.
    expect(await (await h.json("PUT", "/api/settings", { career_autopilot: 0 })).json()).toMatchObject({ career_autopilot: "0" });
    expect((await h.json("PUT", "/api/settings", { career_autopilot: 2 })).status).toBe(400);
    expect((await h.json("PUT", "/api/settings", { schedule_at: "nine" })).status).toBe(400);
    expect((await h.json("PUT", "/api/settings", { schedule_at: "25:90" })).status).toBe(400);
    expect((await h.json("PUT", "/api/settings", { tz: "Invalid/Timezone" })).status).toBe(400);
    expect((await h.json("PUT", "/api/settings", { panel_password: "x" })).status).toBe(400);
  });

  it("unknown api routes are JSON 404; invalid JSON is 400", async () => {
    const h = await harness();
    const r = await h.get("/api/nope");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
    const bad = await h.app.request("/api/runs", { method: "POST", headers: { cookie: h.cookie, "content-type": "application/json" }, body: "{oops" });
    expect(bad.status).toBe(400);
  });
});

describe("static SPA", () => {
  it("serves index.html for deep links, immutable assets, 404 for missing files", async () => {
    const h = await harness();
    const root = await h.app.request("/");
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    const deep = await h.app.request("/runs/12");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("<html");
    expect(deep.headers.get("cache-control")).toBe("no-cache");
    expect((await h.app.request("/assets/missing.js")).status).toBe(404);
    expect((await h.app.request("/../../package.json")).status).not.toBe(200);
  });
});
