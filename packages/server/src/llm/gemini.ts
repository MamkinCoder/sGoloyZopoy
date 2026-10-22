// `gemini -p` wrapper (Gemini CLI), the same contract as runClaude: one headless process per call, the prompt on stdin,
// serialized by the same mutex. Selected with SGZ_LLM=gemini. The CLI reads GEMINI.md (which imports CLAUDE.md) from
// cwd = repoDir, so the content rules are the same. No tools are approved in headless mode, so it only answers.
import type { Tier } from "@sgz/shared";
import { ClaudeError, spawnCollect, type RunClaudeOpts, type RunClaudeResult } from "./claude.js";
import { claudeMutex, llmCaller } from "./mutex.js";

/** Gemini CLI model aliases (latest of each family); GEMINI_MODEL_FAST / _WRITE / _TAILOR override with a full model name. */
export const geminiModel = (tier: Tier, env: NodeJS.ProcessEnv = process.env): string =>
  (tier === "fast" ? env.GEMINI_MODEL_FAST : tier === "write" ? env.GEMINI_MODEL_WRITE : env.GEMINI_MODEL_TAILOR) || (tier === "fast" ? "flash" : "pro");

const DEFAULT_TIMEOUT_MS = 300_000;
const STDERR_TAIL = 2000;
// stdin carries the task; -p text is appended to it (the CLI needs -p for headless mode).
const TAIL = "Выполни задачу выше и верни только результат в запрошенном формате.";

export function buildGeminiArgs(tier: Tier, env: NodeJS.ProcessEnv = process.env): string[] {
  return ["-p", TAIL, "-m", geminiModel(tier, env), "-o", "json", "--skip-trust"];
}

/**
 * Google must be reached through the VPN proxy (the Pi's own IP is Russian and Gemini rejects it): the child gets the proxy
 * in every spelling Node tools read, and without any proxy configured the call is refused instead of going out directly.
 * SGZ_GEMINI_PROXY wins over HTTPS_PROXY / ALL_PROXY; SGZ_GEMINI_DIRECT=1 allows no proxy (a dev machine outside Russia).
 */
export function geminiProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const proxy = env.SGZ_GEMINI_PROXY || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || "";
  if (!proxy) {
    if (env.SGZ_GEMINI_DIRECT === "1") return {};
    throw new ClaudeError("gemini: no proxy configured (set SGZ_GEMINI_PROXY or HTTPS_PROXY): refusing to call Google directly", -1, "", 0);
  }
  return {
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    ALL_PROXY: proxy,
    all_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_USE_ENV_PROXY: "1", // Node's own fetch honours the proxy variables too (Node 22.21+)
  };
}

/** `-o json` prints `{ response, stats }` (maybe after warning lines); anything else is taken as the plain answer. */
export function parseGeminiOutput(stdout: string): { text: string; isError: boolean } {
  const start = stdout.indexOf("{");
  if (start >= 0) {
    try {
      const j = JSON.parse(stdout.slice(start)) as { response?: unknown; error?: { message?: string } };
      if (j.error) return { text: j.error.message ?? "error", isError: true };
      if (typeof j.response === "string") return { text: j.response, isError: false };
    } catch {
      /* not the envelope: plain text below */
    }
  }
  return { text: stdout, isError: false };
}

export async function runGemini(opts: RunClaudeOpts): Promise<RunClaudeResult> {
  const caller = llmCaller.getStore();
  const signal = opts.signal ?? caller?.signal;
  const proxyEnv = geminiProxyEnv({ ...process.env, ...opts.env });
  return claudeMutex.run(async () => {
    if (signal?.aborted) throw new ClaudeError("gemini aborted before start", -1, "", 0);
    const r = await spawnCollect(opts.bin, buildGeminiArgs(opts.tier), {
      cwd: opts.cwd,
      stdin: opts.prompt,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: { ...proxyEnv, ...opts.env },
      signal,
    });
    const stderrTail = r.stderr.slice(-STDERR_TAIL);
    if (r.aborted) throw new ClaudeError(`gemini aborted after ${r.durationMs} ms`, r.exitCode, stderrTail, r.durationMs);
    if (r.timedOut) throw new ClaudeError(`gemini timed out after ${r.durationMs} ms`, r.exitCode, stderrTail, r.durationMs, true);
    if (r.exitCode !== 0) throw new ClaudeError(`gemini exited with code ${r.exitCode}: ${stderrTail.trim() || r.stdout.slice(-300)}`, r.exitCode, stderrTail, r.durationMs);
    const out = parseGeminiOutput(r.stdout);
    if (out.isError) throw new ClaudeError(`gemini reported an error: ${out.text.slice(0, 300)}`, r.exitCode, stderrTail, r.durationMs);
    return { text: out.text, durationMs: r.durationMs, exitCode: r.exitCode, stderrTail };
  }, caller);
}
