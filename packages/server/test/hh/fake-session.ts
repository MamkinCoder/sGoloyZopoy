// Scripted BrowserSession for offline hh tests. Pages are keyed by URL prefix; hooks let a test
// mutate the page when an action happens (popup opens, submit confirms…). Records every call.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import type { ActResult, BrowserSession, Cookie, Observed } from "@sgz/shared";

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");

export interface FakePage {
  html?: string;
  text?: string; // default: html with template/script stripped, tags removed
  existing?: string[]; // selectors that exist on this page
  redirect?: string; // final url after goto
}

export interface FakeHooks {
  onGoto?: (url: string, f: FakeSession) => void;
  onClick?: (selector: string, f: FakeSession) => void;
  onAct?: (instruction: string, opts: ActOpts | undefined, f: FakeSession) => ActResult | boolean | void | Promise<ActResult | boolean | void>;
  onExtract?: (instruction: string, f: FakeSession) => unknown;
  onEvaluate?: (js: string, f: FakeSession) => unknown;
  onWaitForText?: (text: string, f: FakeSession) => boolean;
}

export type ActOpts = { cacheKey?: string; variables?: Record<string, string>; timeoutMs?: number };
export interface Call {
  method: string;
  args: unknown[];
}

const stripToText = (html: string): string =>
  html
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

export class FakeSession implements BrowserSession {
  calls: Call[] = [];
  snapshots: string[] = [];
  currentUrl = "about:blank";
  currentHtml = "";
  currentText: string | null = null;
  existing = new Set<string>();
  cookieJar: Cookie[] = [];
  closed = false;

  constructor(
    public pages: Record<string, FakePage> = {},
    public hooks: FakeHooks = {},
  ) {}

  /** Replace the current page content (used by hooks to simulate UI transitions). */
  setPage(p: FakePage): void {
    if (p.html !== undefined) this.currentHtml = p.html;
    if (p.text !== undefined) this.currentText = p.text;
    else if (p.html !== undefined) this.currentText = null;
    if (p.existing) this.existing = new Set(p.existing);
    if (p.redirect) this.currentUrl = p.redirect;
  }
  addExisting(...sels: string[]): void {
    for (const s of sels) this.existing.add(s);
  }
  removeExisting(...sels: string[]): void {
    for (const s of sels) this.existing.delete(s);
  }
  appendText(t: string): void {
    this.currentText = `${this.currentText ?? stripToText(this.currentHtml)} ${t}`;
  }

  acts(): { instruction: string; opts: ActOpts | undefined }[] {
    return this.calls.filter((c) => c.method === "act").map((c) => ({ instruction: c.args[0] as string, opts: c.args[1] as ActOpts | undefined }));
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }
  private findPage(url: string): FakePage | undefined {
    const keys = Object.keys(this.pages)
      .filter((k) => url === k || url.startsWith(k))
      .sort((a, b) => b.length - a.length);
    return keys[0] !== undefined ? this.pages[keys[0]] : undefined;
  }

  async goto(url: string): Promise<void> {
    this.rec("goto", url);
    this.currentUrl = url;
    this.currentHtml = "";
    this.currentText = null;
    this.existing = new Set();
    const p = this.findPage(url);
    if (p) this.setPage(p);
    this.hooks.onGoto?.(url, this);
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async html(): Promise<string> {
    return this.currentHtml;
  }
  async text(maxChars = 50_000): Promise<string> {
    return (this.currentText ?? stripToText(this.currentHtml)).slice(0, maxChars);
  }
  async act(instruction: string, opts?: ActOpts): Promise<ActResult> {
    this.rec("act", instruction, opts);
    const r = await this.hooks.onAct?.(instruction, opts, this);
    if (typeof r === "object" && r !== null) return r;
    if (r === false) return { success: false, message: "fake: refused", usedCache: false };
    return { success: true, message: "ok", usedCache: false };
  }
  async extract<T>(instruction: string, schema: ZodType<T>): Promise<T> {
    this.rec("extract", instruction);
    const raw = this.hooks.onExtract?.(instruction, this);
    return schema.parse(raw ?? {});
  }
  async observe(instruction: string): Promise<Observed[]> {
    this.rec("observe", instruction);
    return [];
  }
  async exists(selector: string): Promise<boolean> {
    this.rec("exists", selector);
    return selector.split(",").some((part) => this.existing.has(part.trim()));
  }
  async click(selector: string): Promise<void> {
    this.rec("click", selector);
    this.hooks.onClick?.(selector, this);
  }
  async fill(selector: string, value: string): Promise<void> {
    this.rec("fill", selector, value);
  }
  async upload(selector: string, filePath: string): Promise<void> {
    this.rec("upload", selector, filePath);
  }
  async waitForText(text: string, timeoutMs: number): Promise<boolean> {
    this.rec("waitForText", text, timeoutMs);
    if (this.hooks.onWaitForText) return this.hooks.onWaitForText(text, this);
    return (await this.text()).includes(text);
  }
  async waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
    this.rec("waitForSelector", selector, timeoutMs);
    return this.exists(selector);
  }
  async evaluate<T = unknown>(js: string): Promise<T> {
    this.rec("evaluate", js);
    return (this.hooks.onEvaluate?.(js, this) ?? null) as T;
  }
  async pressEscape(): Promise<void> {
    this.rec("pressEscape");
  }
  async snapshot(name: string): Promise<string> {
    this.rec("snapshot", name);
    this.snapshots.push(name);
    return `/tmp/fake-snapshots/${name}.html`;
  }
  async cookies(): Promise<Cookie[]> {
    this.rec("cookies");
    return this.cookieJar;
  }
  async setCookies(cookies: Cookie[]): Promise<void> {
    this.rec("setCookies", cookies);
    this.cookieJar = cookies;
  }
  async memoryMB(): Promise<number> {
    return 0;
  }
  async close(): Promise<void> {
    this.rec("close");
    this.closed = true;
  }
}
