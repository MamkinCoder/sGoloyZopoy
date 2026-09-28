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
        if (!instruction.startsWith("Submit")) return undefined;
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
        return js.includes("data-sgz-field") ? {} : 0; // name tagging, letter limit, consent boxes
      },
      onWaitForText: (t) => !!opts.confirm && t === "Спасибо",
    },
  );
  return s;
}

describe("applyViaAgent submit check", () => {
  const saved = { ...submitTiming };
  beforeAll(() => Object.assign(submitTiming, { effectMs: 30, pollMs: 5 }));
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
});
