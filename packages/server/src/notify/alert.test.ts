import { describe, expect, it } from "vitest";
import { alertOnce, closeAlert, openAlert } from "./alert.js";

const settings = () => {
  const m = new Map<string, string>();
  return { getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string) => void m.set(k, v), m };
};
const t = (iso: string) => new Date(iso);

describe("alertOnce", () => {
  it("without a window: once until closed; the recovery message only when one was open", async () => {
    const s = settings();
    const sent: string[] = [];
    const n = { alert: async (title: string) => void sent.push(title) };
    expect(await alertOnce(s, n, "k", { title: "down", body: "" })).toBe(true);
    expect(await alertOnce(s, n, "k", { title: "down", body: "" })).toBe(false);
    expect(await closeAlert(s, "k", n, () => ({ title: "up", body: "" }))).toBe(true);
    expect(await closeAlert(s, "k", n, () => ({ title: "up", body: "" }))).toBe(false);
    await alertOnce(s, n, "k", { title: "down", body: "" });
    await closeAlert(s, "k"); // silent close (agent job kinds)
    expect(sent).toEqual(["down", "up", "down"]);
  });

  it("a failed send leaves it closed, so the next call retries", async () => {
    const s = settings();
    let fail = true;
    const n = { alert: async () => { if (fail) throw new Error("tg down"); } };
    await expect(alertOnce(s, n, "k", { title: "x", body: "" })).rejects.toThrow("tg down");
    fail = false;
    expect(await alertOnce(s, n, "k", { title: "x", body: "" })).toBe(true);
  });

  it("ttl window (autopilot failures) and day window (Habr blocks, old day-only values too)", () => {
    const s = settings();
    const ttl = (iso: string) => openAlert(s, "r", { ttlMs: 6 * 3600_000, now: t(iso) });
    expect(ttl("2026-09-25T10:00:00Z")).toBe(true);
    expect(ttl("2026-09-25T15:59:00Z")).toBe(false);
    expect(ttl("2026-09-25T16:00:00Z")).toBe(true);
    s.setSetting("h", "2026-09-25"); // written by the old habr_alert_day code
    expect(openAlert(s, "h", { day: true, now: t("2026-09-25T23:00:00Z") })).toBe(false);
    expect(openAlert(s, "h", { day: true, now: t("2026-09-26T00:10:00Z") })).toBe(true);
    expect(openAlert(s, "h", { day: true, now: t("2026-09-26T20:00:00Z") })).toBe(false);
  });
});
