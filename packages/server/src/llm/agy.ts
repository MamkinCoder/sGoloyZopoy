// `agy -p` wrapper (Antigravity CLI, the successor of Gemini CLI), the same contract as runClaude: one headless process per
// call, serialized by the same mutex. Selected with SGZ_LLM=agy. agy ignores stdin in print mode, so the whole prompt is the
// argument of --print; it answers with a JSON envelope. Google must be reached through the VPN proxy (same as gemini.ts).
import type { Tier } from "@sgz/shared";
import { ClaudeError, spawnCollect, type RunClaudeOpts, type RunClaudeResult } from "./claude.js";
import { geminiProxyEnv } from "./gemini.js";
import { claudeMutex, llmCaller } from "./mutex.js";

/** Model ids of `agy models`; AGY_MODEL_FAST / _WRITE / _TAILOR override. */
export const agyModel = (tier: Tier, env: NodeJS.ProcessEnv = process.env): string =>
  (tier === "fast" ? env.AGY_MODEL_FAST : tier === "write" ? env.AGY_MODEL_WRITE : env.AGY_MODEL_TAILOR) || (tier === "fast" ? "gemini-3.8-flash-medium" : "claude-sonnet-4-6");

const DEFAULT_TIMEOUT_MS = 300_000;
const STDERR_TAIL = 2000;
// One argv string is capped at 128 KiB by Linux.
const MAX_PROMPT_BYTES = 120_000;

export const buildAgyArgs = (tier: Tier, prompt: string, env: NodeJS.ProcessEnv = process.env): string[] => ["--model", agyModel(tier, env), "--output-format", "json", `--print=${prompt}`];

/** `{ status, response }`; anything else is taken as the plain answer. */
export function parseAgyOutput(stdout: string): { text: string; isError: boolean } {
  const start = stdout.indexOf("{");
  if (start >= 0) {
    try {
      const j = JSON.parse(stdout.slice(start)) as { status?: string; response?: unknown; error?: unknown };
      if (j.status && j.status !== "SUCCESS") return { text: typeof j.error === "string" ? j.error : `status ${j.status}`, isError: true };
      if (typeof j.response === "string") return { text: j.response, isError: false };
    } catch {
      /* not the envelope: plain text below */
    }
  }
  return { text: stdout, isError: false };
}

export async function runAgy(opts: RunClaudeOpts): Promise<RunClaudeResult> {
  if (Buffer.byteLength(opts.prompt) > MAX_PROMPT_BYTES) throw new ClaudeError(`agy: prompt of ${Buffer.byteLength(opts.prompt)} bytes does not fit one argument`, -1, "", 0);
  const caller = llmCaller.getStore();
  const signal = opts.signal ?? caller?.signal;
  const proxyEnv = geminiProxyEnv({ ...process.env, ...opts.env });
  return claudeMutex.run(async () => {
    if (signal?.aborted) throw new ClaudeError("agy aborted before start", -1, "", 0);
    const r = await spawnCollect(opts.bin, buildAgyArgs(opts.tier, opts.prompt), {
      cwd: opts.cwd,
      stdin: "",
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: { ...proxyEnv, ...opts.env },
      signal,
    });
    const stderrTail = r.stderr.slice(-STDERR_TAIL);
    if (r.aborted) throw new ClaudeError(`agy aborted after ${r.durationMs} ms`, r.exitCode, stderrTail, r.durationMs);
    if (r.timedOut) throw new ClaudeError(`agy timed out after ${r.durationMs} ms`, r.exitCode, stderrTail, r.durationMs, true);
    if (r.exitCode !== 0) throw new ClaudeError(`agy exited with code ${r.exitCode}: ${stderrTail.trim() || r.stdout.slice(-300)}`, r.exitCode, stderrTail, r.durationMs);
    const out = parseAgyOutput(r.stdout);
    if (out.isError) throw new ClaudeError(`agy reported an error: ${out.text.slice(0, 300)}`, r.exitCode, stderrTail, r.durationMs);
    return { text: out.text, durationMs: r.durationMs, exitCode: r.exitCode, stderrTail };
  }, caller);
}
