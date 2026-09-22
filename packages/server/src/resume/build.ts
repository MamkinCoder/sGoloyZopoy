// main.tex → PDF in a throw-away directory that mirrors texDir (ReadableCV.cls, fonts, images).
// ReadableCV is a pdflatex class (T2A fontenc + inputenc), so the default engine is pdflatex; the
// binary is configurable for hosts that alias it.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_LATEX_BIN = "pdflatex";

export interface BuildPdfOptions {
  latexBin?: string;
  /** @deprecated alias of latexBin kept for the original xelatex-era contract */
  xelatexBin?: string;
  texDir: string;
  texSource: string;
  outPdf: string;
  timeoutMs?: number;
}

export class LatexBuildError extends Error {
  constructor(
    message: string,
    public readonly log: string,
    public readonly tail: string,
  ) {
    super(message);
    this.name = "LatexBuildError";
  }
}

const LATEX_ARGS = ["-interaction=nonstopmode", "-halt-on-error", "main.tex"];

interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`cannot start ${bin}: ${err.message}`));
    });
    // "exit" rather than "close": a killed child may leave grandchildren holding the pipes open
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** ≤40 log lines starting a little before the last "!" error marker (or simply the last 40 lines). */
export function errorTail(log: string, lines = 40): string {
  const all = log.split("\n");
  let last = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.startsWith("!")) {
      last = i;
      break;
    }
  }
  const start = last < 0 ? Math.max(0, all.length - lines) : Math.max(0, last - 5);
  return all.slice(start, start + lines).join("\n").trim();
}

export async function buildPdf(opts: BuildPdfOptions): Promise<{ log: string }> {
  const { texDir, texSource, outPdf, timeoutMs = 120_000 } = opts;
  const bin = opts.latexBin ?? opts.xelatexBin ?? DEFAULT_LATEX_BIN;
  if (!(await stat(texDir).catch(() => null))?.isDirectory()) throw new Error(`texDir is not a directory: ${texDir}`);
  const work = await mkdtemp(join(tmpdir(), "sgz-tex-"));
  try {
    await cp(texDir, work, { recursive: true });
    await writeFile(join(work, "main.tex"), texSource, "utf8");
    let log = "";
    // two passes: memoir/hyperref need the .aux from the first one
    for (let pass = 1; pass <= 2; pass++) {
      const res = await run(bin, LATEX_ARGS, work, timeoutMs);
      const fileLog = await readFile(join(work, "main.log"), "utf8").catch(() => "");
      log = fileLog || res.output;
      if (res.timedOut) throw new LatexBuildError(`${bin} timed out after ${timeoutMs}ms (pass ${pass})`, log, errorTail(log));
      if (res.code !== 0) {
        const tail = errorTail(log);
        throw new LatexBuildError(`${bin} failed (exit ${res.code}, pass ${pass}):\n${tail}`, log, tail);
      }
    }
    const pdf = join(work, "main.pdf");
    if (!(await stat(pdf).catch(() => null))?.isFile()) {
      throw new LatexBuildError(`${bin} exited 0 but produced no main.pdf`, log, errorTail(log));
    }
    await mkdir(dirname(outPdf), { recursive: true });
    await cp(pdf, outPdf);
    return { log };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function latexAvailable(bin = DEFAULT_LATEX_BIN): Promise<boolean> {
  try {
    const res = await run(bin, ["--version"], tmpdir(), 10_000);
    return res.code === 0;
  } catch {
    return false;
  }
}

/** @deprecated use latexAvailable */
export const xelatexAvailable = latexAvailable;

/**
 * Map the frozen Config.xelatexBin to the engine ReadableCV needs: its default value "xelatex" is
 * treated as "unset" and becomes pdflatex when that exists; any other value is taken literally.
 */
export async function resolveLatexBin(configured: string): Promise<string> {
  const value = configured.trim();
  if (!value || value === "xelatex") {
    if (await latexAvailable(DEFAULT_LATEX_BIN)) return DEFAULT_LATEX_BIN;
    return value || DEFAULT_LATEX_BIN;
  }
  return value;
}
