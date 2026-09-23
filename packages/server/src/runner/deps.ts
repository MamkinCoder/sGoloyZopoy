// Everything the runner needs, injected. Runner code depends only on shared interfaces so the
// pipeline can be tested with in-memory fakes and composed with the real modules in app.ts.
import type {
  BrowserLauncher,
  CV,
  CareerAgent,
  Config,
  Cookie,
  HHClient,
  LLMClient,
  Notifier,
  Store,
} from "@sgz/shared";

/** Resume toolchain (workstream E) as the runner uses it. app.ts adapts the real exports. */
export interface ResumeDeps {
  loadCV(path: string): Promise<CV>;
  renderTex(cv: CV): string;
  /** Runs xelatex; returns the produced pdf path and the tex file written next to it. */
  buildPdf(opts: { tex: string; texDir: string; outPdf: string; xelatexBin: string }): Promise<{ pdfPath: string; texPath: string }>;
  /** Returns human-readable violations (empty = ok). */
  validateCV(base: CV, tailored: CV, neverClaim: string[]): string[];
}

export interface RunnerDeps {
  cfg: Config;
  store: Store;
  launcher: BrowserLauncher;
  hh: HHClient;
  career: CareerAgent | null;
  llm: LLMClient;
  notifier: Notifier;
  resume: ResumeDeps | null;
  /** MemAvailable in MB; defaults to /proc/meminfo on linux, 4096 elsewhere. */
  memAvailableMB?: () => number;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Reads a cookies file; null when missing. */
  loadCookies?: (path: string) => Cookie[] | null | Promise<Cookie[] | null>;
  fileExists?: (path: string) => boolean;
  /** Where log lines go besides the store/hub (default console.error). */
  stderr?: (line: string) => void;
}
