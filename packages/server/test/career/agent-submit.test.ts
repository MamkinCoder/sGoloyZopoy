// applyViaAgent's submit check: a click that "succeeds" but sets nothing off (corp.ivi.ru) gets a form.requestSubmit()
// fallback, and fails as "no effect" instead of the ambiguous no-confirmation when that does nothing either.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Status, type CareerApplyRequest } from "@sgz/shared";
import { applyViaAgent, submitTiming } from "../../src/career/agent-apply.js";
import { FakeSession } from "../hh/fake-session.js";

const SUBMIT_SEL = "xpath=/html[1]/body[1]/form[1]/button[1]";
const dir = mkdtempSync(join(tmpdir(), "sgz-submit-"));
const pdf = join(dir, "5.pdf");
writeFileSync(pdf, "%PDF");

const req = {
  site: { slug: "acme", profile: {} },
  vacancy: { url: "https://acme.test/job/1", externalId: "site:acme:1" },
  profile: { full_name: "Иван Петров", email: "ivan@example.com", phone: "" },
  resumePdfPath: pdf,
  coverLetter: "",
  dryRun: false,
  answerQuestions: async () => [],
} as unknown as CareerApplyRequest;

/** A page whose probe log is `log` (null = navigated away); `onRequestSubmit` runs when the fallback fires. */
function session(opts: { onClick?: (log: string[]) => void; onRequestSubmit?: (log: string[]) => string; confirm?: boolean }) {
  const log: string[] = [];
  const s = new FakeSession(
    { "https://acme.test/": { html: "<form></form>", existing: ['input[type="file"]'] } },
    {
      onAct: (instruction) => {
        if (!instruction.startsWith("Submit")) return { success: true, message: "ok", usedCache: true, selector: `#${instruction.split(" ")[2]}` };
        opts.onClick?.(log);
        return { success: true, message: "clicked", usedCache: true, selector: SUBMIT_SEL };
      },
      onEvaluate: (js) => {
        if (js.includes("__sgzSubmit = {")) {
          log.length = 0;
          return true;
        }
        if (js.startsWith("(window.__sgzSubmit")) return [...log];
        if (js.includes("requestSubmit")) return opts.onRequestSubmit?.(log) ?? "requestSubmit()";
        if (js.includes("data-sgz-submit")) return true;
        return js.includes("data-sgz-field") ? {} : 0; // name tagging, letter limit, consent boxes
      },
      onWaitForText: (t) => !!opts.confirm && t === "Спасибо",
    },
  );
  return s;
}

describe("applyViaAgent submit check", () => {
  const saved = { ...submitTiming };
  beforeAll(() => Object.assign(submitTiming, { effectMs: 30, pollMs: 5, dwellMs: [0, 0], googleMs: [0, 0], homeMs: [0, 0] }));
  afterAll(() => Object.assign(submitTiming, saved));

  it("a click that submits goes straight to the confirmation, no fallback", async () => {
    const s = session({ onClick: (log) => log.push("submit", "fetch POST"), confirm: true });
    const r = await applyViaAgent(s, req);
    expect(r.status).toBe(Status.SENT);
    expect(r.learnedHints).toContain("submit set off: submit, fetch POST");
    expect(s.calls.some((c) => c.method === "evaluate" && String(c.args[0]).includes("requestSubmit"))).toBe(false);
  });

  it("a dead click is retried with form.requestSubmit()", async () => {
    const s = session({ onRequestSubmit: (log) => (log.push("submit"), "requestSubmit()"), confirm: true });
    const r = await applyViaAgent(s, req);
    expect(r.status).toBe(Status.SENT);
    expect(r.learnedHints).toContain("submit click did nothing; requestSubmit(): submit");
  });

  it("nothing set off even after the fallback: FAILED_UI, not a guess about confirmation", async () => {
    const s = session({ confirm: true });
    const r = await applyViaAgent(s, req);
    expect(r.status).toBe(Status.FAILED_UI);
    expect(r.reasonDetail).toMatch(/submit had no effect/);
    expect(s.calls.some((c) => c.method === "waitForText")).toBe(false);
  });

  it("a button outside the main document (iframe) falls back to the confirmation check", async () => {
    const s = session({ onRequestSubmit: () => "button gone", confirm: true });
    const r = await applyViaAgent(s, req);
    expect(r.status).toBe(Status.SENT);
  });

  it("dwells like a human (fields, then the submit button) right before the submit click, never in a dry run", async () => {
    const s = session({ onClick: (log) => log.push("submit"), confirm: true });
    await applyViaAgent(s, req);
    const i = s.methods().lastIndexOf("humanize"); // the pre-submit one (the warm-up visits humanize too)
    expect(i).toBeGreaterThan(-1);
    expect(s.calls[i]!.args[0]).toEqual(expect.arrayContaining(['[data-sgz-submit="1"]']));
    expect((s.calls[i]!.args[0] as string[]).at(-1)).toBe('[data-sgz-submit="1"]');
    const submitAct = s.calls.findIndex((c) => c.method === "act" && String(c.args[0]).startsWith("Submit"));
    expect(i).toBeLessThan(submitAct);

    const dry = session({});
    await applyViaAgent(dry, { ...req, dryRun: true });
    expect(dry.methods()).not.toContain("humanize");
    expect(dry.methods()).not.toContain("retype");
  });

  it("a real send warms up (google, the site home) before the vacancy and retypes every filled field", async () => {
    const s = session({ onClick: (log) => log.push("submit"), confirm: true });
    await applyViaAgent(s, req);
    expect(s.calls.filter((c) => c.method === "goto").map((c) => c.args[0])).toEqual(["https://www.google.com/", "https://acme.test/", "https://acme.test/job/1"]);
    const retyped = s.calls.filter((c) => c.method === "retype").map((c) => c.args[0]);
    expect(retyped.length).toBeGreaterThanOrEqual(2); // name + email at least
    expect(s.methods().lastIndexOf("retype")).toBeLessThan(s.methods().indexOf("upload"));

    const dry = session({});
    await applyViaAgent(dry, { ...req, dryRun: true });
    expect(dry.calls.filter((c) => c.method === "goto").map((c) => c.args[0])).toEqual(["https://acme.test/job/1"]);
  });
});
