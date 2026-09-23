// Browser contract. Workstream B implements on top of Stagehand v4 (CDP direct, no Playwright).
// Everything site-specific (hh, career) is written as natural-language act/extract/observe calls
// through this interface, so no package but `browser` imports Stagehand directly.
import type { ZodType } from "zod";

export interface BrowserOptions {
  executablePath: string; // /usr/bin/chromium on the Pi; Google Chrome on the Mac
  headless: boolean;
  userDataDir: string; // PERSISTENT per-user profile: data/users/<slug>/chrome-profile
  userAgent?: string;
  snapshotDir: string; // html+png bundles on failure
  blockAssets?: boolean; // abort images/fonts/media/analytics (RAM + bandwidth on the Pi)
  cacheDir?: string; // action cache file dir (observe → selector cache)
  actionTimeoutMs?: number; // default 15000
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Result of observe(): a concrete element the LLM chose for an instruction. */
export interface Observed {
  selector: string; // xpath or css as returned by Stagehand
  description: string;
  method?: string; // click | fill | selectOptionFromDropdown ...
  arguments?: string[];
}

export interface ActResult {
  success: boolean;
  message: string;
  usedCache: boolean;
}

/**
 * One Chromium instance, one active page. NOT safe for concurrent use.
 * All instructions are Russian or English natural language.
 */
export interface BrowserSession {
  /** `quick`: DOM ready only (pages we just parse); default also waits for load + a short network idle. */
  goto(url: string, opts?: { quick?: boolean }): Promise<void>;
  url(): Promise<string>;
  html(): Promise<string>;
  /** Visible text of the page (innerText), capped. */
  text(maxChars?: number): Promise<string>;

  /**
   * Perform an action described in natural language. Uses the action cache first
   * (key = cacheKey ?? instruction, scoped by host); on cache miss asks the LLM via observe(),
   * executes, and stores the selector. On replay failure it invalidates the cache and retries once with the LLM.
   */
  act(instruction: string, opts?: { cacheKey?: string; variables?: Record<string, string>; timeoutMs?: number }): Promise<ActResult>;
  /** Extract structured data validated by a zod schema. */
  extract<T>(instruction: string, schema: ZodType<T>, opts?: { timeoutMs?: number }): Promise<T>;
  /** Find elements for an instruction without acting. */
  observe(instruction: string): Promise<Observed[]>;

  // Cheap deterministic helpers (no LLM) — use them wherever a stable selector is known.
  exists(selector: string): Promise<boolean>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>; // React-safe (native setter + input event)
  upload(selector: string, filePath: string): Promise<void>;
  waitForText(text: string, timeoutMs: number): Promise<boolean>;
  waitForSelector(selector: string, timeoutMs: number): Promise<boolean>;
  evaluate<T = unknown>(js: string): Promise<T>;
  pressEscape(): Promise<void>;
  pressKey(key: string): Promise<void>;

  /** Writes <dir>/<name>.html, .png, .url; returns the html path. */
  snapshot(name: string): Promise<string>;
  cookies(): Promise<Cookie[]>;
  setCookies(cookies: Cookie[]): Promise<void>;
  /** Approximate RSS of the browser process tree in MB (0 if unknown). */
  memoryMB(): Promise<number>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(opts: BrowserOptions): Promise<BrowserSession>;
}

/** Text-completion callback Stagehand calls; implemented over `claude -p` by workstream D. */
export interface StagehandLLM {
  generate(params: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    systemPrompt?: string;
    temperature?: number;
    responseFormat?: { type: "json_schema"; schema: unknown } | { type: "text" };
  }): Promise<{ text: string; structured?: unknown }>;
}
