// In-memory BrowserSession/BrowserLauncher for other workstreams' tests. No browser, no LLM.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod";
import type { ActResult, BrowserLauncher, BrowserOptions, BrowserSession, Cookie, Observed } from "@sgz/shared";

export interface FakeCall {
  method: string;
  args: unknown[];
}

type ActHandler = ActResult | (() => void | ActResult | Promise<void | ActResult>);

export class FakeSession implements BrowserSession {
  pageHtml = "<html><body></body></html>";
  currentUrl = "about:blank";
  pageText = "";
  cookieJar: Cookie[] = [];
  memory = 0;
  closed = false;
  snapshotDir: string;
  readonly calls: FakeCall[] = [];

  private readonly existsRules = new Map<string, boolean>();
  private readonly waitTextRules = new Map<string, boolean>();
  private readonly extractRules: { needle: string; value: unknown }[] = [];
  private readonly actRules: { needle: string; handler: ActHandler }[] = [];
  private readonly evaluateRules: { needle: string; value: unknown }[] = [];
  private readonly observeRules: { needle: string; value: Observed[] }[] = [];

  constructor(preset: { html?: string; url?: string; text?: string; cookies?: Cookie[]; snapshotDir?: string } = {}) {
    if (preset.html !== undefined) this.pageHtml = preset.html;
    if (preset.url !== undefined) this.currentUrl = preset.url;
    if (preset.text !== undefined) this.pageText = preset.text;
    if (preset.cookies) this.cookieJar = [...preset.cookies];
    this.snapshotDir = preset.snapshotDir ?? mkdtempSync(join(tmpdir(), "sgz-fake-snap-"));
  }

  // ---- presets -------------------------------------------------------------
  onExists(selector: string, value: boolean): this {
    this.existsRules.set(selector, value);
    return this;
  }
  onWaitForText(text: string, value: boolean): this {
    this.waitTextRules.set(text, value);
    return this;
  }
  onExtract(instructionSubstring: string, value: unknown): this {
    this.extractRules.push({ needle: instructionSubstring, value });
    return this;
  }
  onAct(instructionSubstring: string, result: ActHandler): this {
    this.actRules.push({ needle: instructionSubstring, handler: result });
    return this;
  }
  onEvaluate(jsSubstring: string, value: unknown): this {
    this.evaluateRules.push({ needle: jsSubstring, value });
    return this;
  }
  onObserve(instructionSubstring: string, value: Observed[]): this {
    this.observeRules.push({ needle: instructionSubstring, value });
    return this;
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  // ---- BrowserSession -----------------------------------------------------
  async goto(url: string): Promise<void> {
    this.record("goto", url);
    this.currentUrl = url;
  }
  async url(): Promise<string> {
    this.record("url");
    return this.currentUrl;
  }
  async html(): Promise<string> {
    this.record("html");
    return this.pageHtml;
  }
  async text(maxChars = 20000): Promise<string> {
    this.record("text", maxChars);
    return this.pageText.slice(0, maxChars);
  }

  async act(instruction: string, opts?: { cacheKey?: string; variables?: Record<string, string>; timeoutMs?: number }): Promise<ActResult> {
    this.record("act", instruction, opts);
    const rule = this.actRules.find((r) => instruction.includes(r.needle));
    if (!rule) return { success: false, message: `FakeSession: no onAct rule for "${instruction}"`, usedCache: false };
    if (typeof rule.handler === "function") {
      const r = await rule.handler();
      return r ?? { success: true, message: "ok", usedCache: false };
    }
    return rule.handler;
  }

  async extract<T>(instruction: string, schema: ZodType<T>, opts?: { timeoutMs?: number }): Promise<T> {
    this.record("extract", instruction, opts);
    const rule = this.extractRules.find((r) => instruction.includes(r.needle));
    if (!rule) throw new Error(`FakeSession: no onExtract rule for "${instruction}"`);
    return schema.parse(rule.value);
  }

  async observe(instruction: string): Promise<Observed[]> {
    this.record("observe", instruction);
    return this.observeRules.find((r) => instruction.includes(r.needle))?.value ?? [];
  }

  async exists(selector: string): Promise<boolean> {
    this.record("exists", selector);
    return this.existsRules.get(selector) ?? false;
  }
  async click(selector: string): Promise<void> {
    this.record("click", selector);
  }
  async fill(selector: string, value: string): Promise<void> {
    this.record("fill", selector, value);
  }
  async upload(selector: string, filePath: string): Promise<void> {
    this.record("upload", selector, filePath);
  }
  async waitForText(text: string, timeoutMs: number): Promise<boolean> {
    this.record("waitForText", text, timeoutMs);
    return this.waitTextRules.get(text) ?? this.pageText.includes(text);
  }
  async waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
    this.record("waitForSelector", selector, timeoutMs);
    return this.existsRules.get(selector) ?? false;
  }
  async evaluate<T = unknown>(js: string): Promise<T> {
    this.record("evaluate", js);
    return (this.evaluateRules.find((r) => js.includes(r.needle))?.value ?? undefined) as T;
  }
  async pressEscape(): Promise<void> {
    this.record("pressEscape");
  }

  async snapshot(name: string): Promise<string> {
    this.record("snapshot", name);
    mkdirSync(this.snapshotDir, { recursive: true });
    const base = join(this.snapshotDir, name.replace(/[^a-z0-9._-]/gi, "_"));
    writeFileSync(`${base}.html`, this.pageHtml);
    writeFileSync(`${base}.url`, this.currentUrl);
    writeFileSync(`${base}.png`, "");
    return `${base}.html`;
  }
  async cookies(): Promise<Cookie[]> {
    this.record("cookies");
    return [...this.cookieJar];
  }
  async setCookies(cookies: Cookie[]): Promise<void> {
    this.record("setCookies", cookies);
    const byKey = new Map(this.cookieJar.map((c) => [`${c.domain}|${c.path}|${c.name}`, c]));
    for (const c of cookies) byKey.set(`${c.domain}|${c.path}|${c.name}`, c);
    this.cookieJar = [...byKey.values()];
  }
  async memoryMB(): Promise<number> {
    this.record("memoryMB");
    return this.memory;
  }
  async close(): Promise<void> {
    this.record("close");
    this.closed = true;
  }
}

export class FakeLauncher implements BrowserLauncher {
  readonly launches: BrowserOptions[] = [];
  constructor(private readonly factory: (opts: BrowserOptions) => FakeSession = () => new FakeSession()) {}
  async launch(opts: BrowserOptions): Promise<FakeSession> {
    this.launches.push(opts);
    return this.factory(opts);
  }
}
