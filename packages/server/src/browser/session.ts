// BrowserSession over Stagehand v4. Natural-language act() goes cache → replay → observe → act;
// everything else is deterministic Page/Locator/evaluate calls (no LLM).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Stagehand, StagehandBrowser, StagehandClientExtractOptions } from "@browserbasehq/stagehand";
import type { ZodType } from "zod";
import type { ActResult, BrowserOptions, BrowserSession, Cookie, Observed } from "@sgz/shared";
import { ActionCache, hostOf, type CacheEntry } from "./cache.js";
import { chromiumTreeRssMB, killChromiumLeftovers } from "./memory.js";

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
/** LLM-backed steps (observe/extract) include one or more `claude -p` calls at 3–8 s each. */
const LLM_STEP_TIMEOUT_MS = 120_000;
const NETWORK_IDLE_MS = 3_000;

export interface SessionDeps {
  stagehand: Stagehand;
  browser: StagehandBrowser;
  page: Page;
  opts: BrowserOptions;
  cache: ActionCache;
  /** Extra teardown (asset blocker socket, temp cache dir …). Runs after the browser is closed. */
  cleanup: (() => Promise<void> | void)[];
}

// Runs in the page. `sel` is css, or xpath when it starts with "/" or "xpath=" (Stagehand's rule).
const RESOLVE_JS = `(function(sel){
  if (sel.startsWith("xpath=")) sel = sel.slice(6);
  if (sel.startsWith("/") || sel.startsWith("(")) return document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  return document.querySelector(sel);
})`;

const fillJs = (selector: string, value: string): string => `(function(){
  var el = ${RESOLVE_JS}(${JSON.stringify(selector)});
  if (!el) return false;
  var v = ${JSON.stringify(value)};
  el.focus && el.focus();
  if (el.isContentEditable) { el.textContent = v; el.dispatchEvent(new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" })); return true; }
  var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(el, v); else el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value === v;
})()`;

const TEXT_JS = (max: number): string => `(document.body ? document.body.innerText : "").slice(0, ${max})`;

export class StagehandSession implements BrowserSession {
  private closing: Promise<void> | undefined;

  constructor(private readonly d: SessionDeps) {}

  private get page(): Page {
    return this.d.page;
  }
  private get actionTimeout(): number {
    return this.d.opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  async goto(url: string, opts?: { quick?: boolean }): Promise<void> {
    // DOM ready is all the parsers need (InitialState templates); a hung tracker must not fail the run.
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(this.actionTimeout, 30_000) });
    if (opts?.quick) return;
    try {
      await this.page.waitForLoadState("load", 15_000);
    } catch {
      // bounded wait only
    }
    try {
      await this.page.waitForLoadState("networkidle", NETWORK_IDLE_MS);
    } catch {
      // bounded wait only; a chatty page must not block the run
    }
  }

  url(): Promise<string> {
    return this.page.url();
  }

  html(): Promise<string> {
    return this.page.evaluate<string>("document.documentElement.outerHTML");
  }

  text(maxChars = 20_000): Promise<string> {
    return this.page.evaluate<string>(TEXT_JS(maxChars));
  }

  async act(
    instruction: string,
    opts: { cacheKey?: string; variables?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<ActResult> {
    const timeout = opts.timeoutMs ?? this.actionTimeout;
    const host = hostOf(await this.url());
    const key = opts.cacheKey ?? instruction;
    const cached = this.d.cache.get(host, key);

    if (cached) {
      const replay = await this.replay(cached, opts.variables, timeout);
      if (replay.ok) {
        this.d.cache.success(host, key, cached);
        return { success: true, message: replay.message, usedCache: true };
      }
      this.d.cache.failure(host, key);
    }

    const observed = await this.observeRaw(instruction, opts.variables, Math.max(timeout, LLM_STEP_TIMEOUT_MS));
    const first = observed[0];
    if (!first) return { success: false, message: `observe found nothing for: ${instruction}`, usedCache: false };
    const action = { selector: first.selector, description: first.description, method: first.method ?? "click", arguments: first.arguments ?? [] };
    const run = await this.replay(action, opts.variables, timeout);
    if (run.ok) {
      this.d.cache.success(host, key, action);
    } else if (cached) {
      this.d.cache.invalidate(host, key);
    }
    return { success: run.ok, message: run.message, usedCache: false };
  }

  /** Deterministic Stagehand act on a known Action: xpath resolution + method dispatch, `%var%` substitution, no LLM. */
  private async replay(
    entry: Pick<CacheEntry, "selector" | "method" | "arguments" | "description">,
    variables: Record<string, string> | undefined,
    timeout: number,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await this.d.stagehand.act({ selector: entry.selector, description: entry.description, method: entry.method, arguments: entry.arguments }, { timeout, ...(variables ? { variables } : {}) });
      return { ok: res.data.success, message: res.data.message };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async observeRaw(instruction: string, variables: Record<string, string> | undefined, timeout: number): Promise<Observed[]> {
    const res = await this.d.stagehand.observe(instruction, { timeout, ...(variables ? { variables } : {}) });
    return res.data.map((a) => ({
      selector: a.selector,
      description: a.description,
      ...(a.method !== undefined ? { method: a.method } : {}),
      ...(a.arguments !== undefined ? { arguments: a.arguments } : {}),
    }));
  }

  async extract<T>(instruction: string, schema: ZodType<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
    // Stagehand's zod copy (4.4.x) serialises our zod-4 schema via z.toJSONSchema and parses the reply
    // with schema.parse; the two zod builds interoperate at runtime but not at the type level.
    const extract = this.d.stagehand.extract.bind(this.d.stagehand) as unknown as (
      instruction: string,
      schema: unknown,
      options?: StagehandClientExtractOptions,
    ) => Promise<{ data: T }>;
    const res = await extract(instruction, schema, { timeout: Math.max(opts.timeoutMs ?? this.actionTimeout, LLM_STEP_TIMEOUT_MS) });
    return res.data;
  }

  observe(instruction: string): Promise<Observed[]> {
    return this.observeRaw(instruction, undefined, LLM_STEP_TIMEOUT_MS);
  }

  async exists(selector: string): Promise<boolean> {
    try {
      return (await this.page.locator(selector).count()) > 0;
    } catch {
      return false;
    }
  }

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).first().click();
  }

  async fill(selector: string, value: string): Promise<void> {
    const ok = await this.page.evaluate<boolean>(fillJs(selector, value));
    if (!ok) await this.page.locator(selector).first().fill(value);
  }

  async upload(selector: string, filePath: string): Promise<void> {
    await this.page.locator(selector).first().setInputFiles(filePath);
  }

  async waitForText(text: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const js = `(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`;
    for (;;) {
      try {
        if (await this.page.evaluate<boolean>(js)) return true;
      } catch {
        // navigating; retry until the deadline
      }
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    }
  }

  async waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
    try {
      return await this.page.waitForSelector(selector, { state: "attached", timeout: timeoutMs });
    } catch {
      return false;
    }
  }

  evaluate<T = unknown>(js: string): Promise<T> {
    return this.page.evaluate<T>(js);
  }

  async pressEscape(): Promise<void> {
    await this.page.keyPress("Escape");
  }

  async pressKey(key: string): Promise<void> {
    await this.page.keyPress(key);
  }

  async snapshot(name: string): Promise<string> {
    const dir = this.d.opts.snapshotDir;
    mkdirSync(dir, { recursive: true });
    const base = join(dir, name.replace(/[^a-z0-9._-]/gi, "_"));
    const [html, url] = await Promise.all([this.html().catch(() => ""), this.url().catch(() => "")]);
    writeFileSync(`${base}.html`, html);
    writeFileSync(`${base}.url`, url);
    try {
      writeFileSync(`${base}.png`, await this.page.screenshot({ type: "png" }));
    } catch {
      // a screenshot failure must not hide the html snapshot
    }
    return `${base}.html`;
  }

  async cookies(): Promise<Cookie[]> {
    const all = await this.d.browser.context.cookies();
    return all.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    if (cookies.length === 0) return;
    await this.d.browser.context.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        httpOnly: c.httpOnly,
        secure: c.secure,
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
        ...(c.expires > 0 ? { expires: c.expires } : {}),
      })),
    );
  }

  memoryMB(): Promise<number> {
    return chromiumTreeRssMB(this.d.opts.userDataDir);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        await this.d.stagehand.close();
      } catch {
        // the browser may already be gone
      }
      try {
        await this.d.browser.close();
      } catch {
        // idem
      }
      await killChromiumLeftovers(this.d.opts.userDataDir);
      for (const fn of this.d.cleanup) {
        try {
          await fn();
        } catch {
          // best effort
        }
      }
    })();
    return this.closing;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
