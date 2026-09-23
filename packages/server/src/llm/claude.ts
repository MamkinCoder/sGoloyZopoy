// `claude -p` wrapper: one headless Claude Code process per call, serialized by a global mutex.
import { spawn } from "node:child_process";
import type { Tier } from "@sgz/shared";
import { claudeMutex } from "./mutex.js";

export const TIER_MODEL: Record<Tier, string> = { fast: "haiku", write: "sonnet", tailor: "opus" };
const DEFAULT_TIMEOUT_MS = 300_000; // decide batches with long vacancy texts take >3 min on the Pi
const STDERR_TAIL = 2000;

export interface RunClaudeOpts {
  bin: string;
  cwd: string;
  tier: Tier;
  prompt: string;
  timeoutMs?: number;
  /** JSON schema for `--json-schema` when the binary supports it. */
  schema?: unknown;
  env?: Record<string, string>;
}

export interface RunClaudeResult {
  text: string;
  structured?: unknown;
  durationMs: number;
  exitCode: number;
  stderrTail: string;
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderrTail: string,
    public readonly durationMs: number,
    public readonly timedOut = false,
  ) {
    super(message);
    this.name = "ClaudeError";
  }
}

export interface ClaudeFeatures {
  jsonSchema: boolean;
  maxTurns: boolean;
  noSessionPersistence: boolean;
  tools: boolean;
}

const NO_FEATURES: ClaudeFeatures = { jsonSchema: false, maxTurns: false, noSessionPersistence: false, tools: false };
const featureCache = new Map<string, Promise<ClaudeFeatures>>();

/** Runs `claude --help` once per binary; a failure means "no optional flags". */
export function detectFeatures(bin: string, env?: Record<string, string>): Promise<ClaudeFeatures> {
  let p = featureCache.get(bin);
  if (!p) {
    p = spawnCollect(bin, ["--help"], { cwd: process.cwd(), timeoutMs: 15_000, env })
      .then((r) => {
        const help = r.stdout + r.stderr;
        return {
          jsonSchema: help.includes("--json-schema"),
          maxTurns: help.includes("--max-turns"),
          noSessionPersistence: help.includes("--no-session-persistence"),
          tools: /--tools\b/.test(help),
        };
      })
      .catch(() => NO_FEATURES);
    featureCache.set(bin, p);
  }
  return p;
}

export function resetFeatureCache(): void {
  featureCache.clear();
}

export function buildArgs(tier: Tier, f: ClaudeFeatures, schema?: unknown): string[] {
  const args = ["-p", "--output-format", "json", "--model", TIER_MODEL[tier]];
  if (f.maxTurns) args.push("--max-turns", "1");
  if (f.noSessionPersistence) args.push("--no-session-persistence");
  if (f.tools) args.push("--tools", "");
  if (f.jsonSchema && schema !== undefined) {
    // Some claude builds validate with a draft-07 validator that rejects the draft/2020-12 "$schema" tag
    // (zod and Stagehand both add it); the schema bodies are draft-07 compatible.
    const { $schema: _drop, ...body } = (schema ?? {}) as Record<string, unknown>;
    args.push("--json-schema", JSON.stringify(body));
  }
  return args;
}

export async function runClaude(opts: RunClaudeOpts): Promise<RunClaudeResult> {
  const features = await detectFeatures(opts.bin, opts.env);
  const args = buildArgs(opts.tier, features, opts.schema);
  return claudeMutex.run(async () => {
    const r = await spawnCollect(opts.bin, args, {
      cwd: opts.cwd,
      stdin: opts.prompt,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: opts.env,
    });
    const stderrTail = r.stderr.slice(-STDERR_TAIL);
    if (r.timedOut) throw new ClaudeError(`claude timed out after ${r.durationMs} ms`, r.exitCode, stderrTail, r.durationMs, true);
    if (r.exitCode !== 0) {
      throw new ClaudeError(`claude exited with code ${r.exitCode}: ${stderrTail.trim() || r.stdout.slice(-300)}`, r.exitCode, stderrTail, r.durationMs);
    }
    const env = parseEnvelope(r.stdout);
    if (env.isError) throw new ClaudeError(`claude reported an error: ${env.text.slice(0, 300)}`, r.exitCode, stderrTail, r.durationMs);
    return { text: env.text, structured: env.structured, durationMs: r.durationMs, exitCode: r.exitCode, stderrTail };
  });
}

interface Envelope {
  text: string;
  structured?: unknown;
  isError: boolean;
}

/** `--output-format json` prints one result object (older builds: an array ending with it). */
export function parseEnvelope(stdout: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { text: stdout, isError: false };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const result = [...list].reverse().find((m) => isRecord(m) && m.type === "result") ?? list[list.length - 1];
  if (!isRecord(result)) return { text: stdout, isError: false };
  const text = typeof result.result === "string" ? result.result : "";
  return {
    text,
    structured: result.structured_output,
    isError: result.is_error === true || (typeof result.subtype === "string" && result.subtype.startsWith("error")),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Best-effort JSON extraction from model text: whole text, a fenced block, then the first
 * balanced {...} or [...] that parses. Throws when nothing parses.
 */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const whole = tryParse(t);
  if (whole !== NOPE) return whole;
  for (const m of t.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
    const v = tryParse((m[1] ?? "").trim());
    if (v !== NOPE) return v;
  }
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== "{" && c !== "[") continue;
    const end = balancedEnd(t, i);
    if (end < 0) continue;
    const v = tryParse(t.slice(i, end + 1));
    if (v !== NOPE) return v;
  }
  throw new Error(`no JSON found in model output: ${t.slice(0, 120)}`);
}

const NOPE = Symbol("no-json");
function tryParse(s: string): unknown {
  if (!s || (s[0] !== "{" && s[0] !== "[")) return NOPE;
  try {
    return JSON.parse(s);
  } catch {
    return NOPE;
  }
}

function balancedEnd(s: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

interface SpawnOpts {
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  env?: Record<string, string>;
}
interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

function spawnCollect(bin: string, args: string[], o: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(bin, args, {
      cwd: o.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=512",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ...o.env,
      },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2000).unref();
    }, o.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ClaudeError(`cannot start ${bin}: ${err.message}`, -1, "", Date.now() - started));
    });
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, durationMs: Date.now() - started, timedOut });
    };
    child.on("close", settle);
    // A killed child may leave grandchildren holding the pipes; don't wait for them.
    child.on("exit", (code) => {
      if (timedOut) setImmediate(() => settle(code));
    });
    if (o.stdin !== undefined) {
      child.stdin.on("error", () => undefined); // EPIPE when the child dies early
      child.stdin.end(o.stdin);
    } else child.stdin.end();
  });
}
