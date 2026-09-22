import { describe, expect, it } from "vitest";
import { fakeConfig, harness, PASSWORD } from "./fakes.js";

const post = (app: Awaited<ReturnType<typeof harness>>["app"], body: unknown, ip = "1.1.1.1") =>
  app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

describe("auth", () => {
  it("login sets an HttpOnly Lax cookie and /me flips", async () => {
    const h = await harness();
    const anon = await h.app.request("/api/me");
    expect(await anon.json()).toEqual({ authenticated: false, auth_required: true });

    const res = await post(h.app, { password: PASSWORD });
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toMatch(/^sgz_session=[0-9a-f]{64}\.\d+;/);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Max-Age=2592000");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const me = await h.get("/api/me");
    expect(await me.json()).toEqual({ authenticated: true, auth_required: true });
  });

  it("rejects wrong password, missing and tampered cookies with 401", async () => {
    const h = await harness();
    expect((await post(h.app, { password: "nope" })).status).toBe(401);
    expect((await h.app.request("/api/users")).status).toBe(401);
    const forged = h.cookie.replace(/=[0-9a-f]{4}/, "=dead");
    const r = await h.app.request("/api/users", { headers: { cookie: forged } });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "unauthorized" });
    const badBody = await post(h.app, { nope: 1 });
    expect(badBody.status).toBe(400);
  });

  it("rate-limits after 5 failures per IP", async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) expect((await post(h.app, { password: "x" }, "9.9.9.9")).status).toBe(401);
    expect((await post(h.app, { password: PASSWORD }, "9.9.9.9")).status).toBe(429);
    // other IPs unaffected
    expect((await post(h.app, { password: PASSWORD }, "8.8.8.8")).status).toBe(200);
  });

  it("logout clears the cookie", async () => {
    const h = await harness();
    const res = await h.json("POST", "/api/logout");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/sgz_session=;.*Max-Age=0/);
  });

  it("empty panel password disables auth: /me reports auth_required=false and routes are open", async () => {
    const h = await harness({ cfg: { ...fakeConfig("/tmp/unused"), panelPassword: "" } });
    expect(await (await h.app.request("/api/me")).json()).toEqual({ authenticated: true, auth_required: false });
    expect((await h.app.request("/api/users")).status).toBe(200);
    expect((await post(h.app, { password: "anything" })).status).toBe(200);
  });

  it("health-lite is public, health is not", async () => {
    const h = await harness();
    expect((await h.app.request("/api/health-lite")).status).toBe(200);
    expect((await h.app.request("/api/health")).status).toBe(401);
  });
});
