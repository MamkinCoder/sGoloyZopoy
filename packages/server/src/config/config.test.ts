import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_AGENT,
  ensureDirs,
  findRepoDir,
  loadConfig,
  loadProfileYaml,
  parseBind,
  parseDurationMs,
  parseEnvText,
  saveProfileYaml,
} from "./index.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "sgz-config-"));
const dirs: string[] = [];
const mk = (): string => {
  const d = tmp();
  dirs.push(d);
  return d;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parsers", () => {
  it("parseBind", () => {
    expect(parseBind("0.0.0.0:3002")).toEqual({ host: "0.0.0.0", port: 3002 });
    expect(parseBind("127.0.0.1:8080")).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(parseBind(":4000")).toEqual({ host: "0.0.0.0", port: 4000 });
    expect(parseBind("4000")).toEqual({ host: "0.0.0.0", port: 4000 });
    expect(parseBind("[::1]:5000")).toEqual({ host: "::1", port: 5000 });
    expect(parseBind("")).toEqual({ host: "0.0.0.0", port: 3002 });
  });
  it("parseDurationMs", () => {
    expect(parseDurationMs("8s", 1)).toBe(8000);
    expect(parseDurationMs("20s", 1)).toBe(20000);
    expect(parseDurationMs("500ms", 1)).toBe(500);
    expect(parseDurationMs("2m", 1)).toBe(120000);
    expect(parseDurationMs("8000", 1)).toBe(8000);
    expect(parseDurationMs("junk", 7)).toBe(7);
    expect(parseDurationMs(undefined, 7)).toBe(7);
  });
  it("parseEnvText", () => {
    expect(parseEnvText('# c\nA=1\nB="two words" # trailing\nC=x # comment\nexport D=4\nbad\n')).toEqual({
      A: "1",
      B: "two words",
      C: "x",
      D: "4",
    });
  });
});

describe("loadConfig", () => {
  it("applies defaults when nothing is set", () => {
    const dataDir = mk();
    const env: NodeJS.ProcessEnv = { SGZ_DATA_DIR: dataDir };
    const c = loadConfig(env, dataDir);
    expect(c.dataDir).toBe(dataDir);
    expect(c.bind).toEqual({ host: "0.0.0.0", port: 3002 });
    expect(c.claudeBin).toBe("claude");
    expect(c.xelatexBin).toBe("xelatex");
    expect(c.scheduleAt).toBe("12:00");
    expect(c.scheduleJitterMin).toBe(20);
    expect(c.tz).toBe("Europe/Moscow");
    expect(c.runnerEnabled).toBe(true);
    expect(c.throttleMinMs).toBe(8000);
    expect(c.throttleMaxMs).toBe(20000);
    expect(c.memoryGuardMB).toBe(450);
    expect(c.userAgent).toBe(DEFAULT_USER_AGENT);
    expect(c.panelUrl).toBe("http://localhost:3002");
    expect(c.panelPassword).toBe("");
    expect(c.chromiumBin).toBe(
      process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : process.platform === "linux"
          ? "/usr/bin/chromium"
          : "chromium",
    );
    // no CLAUDE.md above the temp dir -> repoDir falls back to cwd
    expect(c.repoDir).toBe(dataDir);
  });

  it("reads data/.env and lets process env win", () => {
    const dataDir = mk();
    writeFileSync(
      join(dataDir, ".env"),
      [
        "# comment",
        "SGZ_BIND=127.0.0.1:9000",
        "SGZ_THROTTLE_MIN=1s",
        "SGZ_THROTTLE_MAX=2500",
        "SGZ_RUNNER=false",
        "SGZ_SCHEDULE=off",
        "TG_BOT_TOKEN=file-token",
        "CHROMIUM_BIN=/opt/chromium",
        "SGZ_PANEL_URL=http://sgz.rp.i/",
      ].join("\n"),
    );
    vi.stubEnv("SGZ_DATA_DIR", dataDir);
    vi.stubEnv("TG_BOT_TOKEN", "env-token");
    const c = loadConfig();
    expect(c.bind).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(c.throttleMinMs).toBe(1000);
    expect(c.throttleMaxMs).toBe(2500);
    expect(c.runnerEnabled).toBe(false);
    expect(c.scheduleAt).toBe("");
    expect(c.tgBotToken).toBe("env-token");
    expect(c.chromiumBin).toBe("/opt/chromium");
    expect(c.panelUrl).toBe("http://sgz.rp.i");
    // values from the file land in process.env for the rest of the process
    expect(process.env.CHROMIUM_BIN).toBe("/opt/chromium");
    delete process.env.SGZ_BIND;
    delete process.env.SGZ_THROTTLE_MIN;
    delete process.env.SGZ_THROTTLE_MAX;
    delete process.env.SGZ_RUNNER;
    delete process.env.SGZ_SCHEDULE;
    delete process.env.CHROMIUM_BIN;
    delete process.env.SGZ_PANEL_URL;
  });

  it("honours SGZ_REPO_DIR and finds CLAUDE.md by walking up", () => {
    const root = mk();
    writeFileSync(join(root, "CLAUDE.md"), "# rules");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findRepoDir(nested)).toBe(root);
    const c = loadConfig({ SGZ_DATA_DIR: root, SGZ_REPO_DIR: "/somewhere" }, nested);
    expect(c.repoDir).toBe("/somewhere");
    expect(loadConfig({ SGZ_DATA_DIR: root }, nested).repoDir).toBe(root);
  });

  it("ensureDirs creates the layout", () => {
    const dataDir = mk();
    const c = loadConfig({ SGZ_DATA_DIR: join(dataDir, "data") }, dataDir);
    ensureDirs(c);
    for (const d of ["users", "snapshots", "action-cache", "recordings", "tex"]) {
      expect(statSync(join(c.dataDir, d)).isDirectory()).toBe(true);
    }
  });
});

describe("profile yaml", () => {
  it("loads the example with defaults for missing fields and round-trips", () => {
    const dir = mk();
    const p = loadProfileYaml(join(__dirname, "../../../../data.example/profile.example.yaml"));
    expect(p.full_name).toBe("Имя Фамилия");
    expect(p.work_formats).toEqual(["remote", "office", "hybrid"]);
    expect(p.verified_skills).toContain("Go");
    expect(p.extra["гражданство"]).toBe("РФ");
    expect(p.salary_from).toBe(0);

    const partial = join(dir, "partial.yaml");
    writeFileSync(partial, "full_name: Test\nlanguages: english\nsalary_from: '100'\nextra:\n  k: 1\n");
    const q = loadProfileYaml(partial);
    expect(q.full_name).toBe("Test");
    expect(q.languages).toEqual(["english"]);
    expect(q.salary_from).toBe(100);
    expect(q.currency).toBe("RUR");
    expect(q.hh_queries).toEqual([]);
    expect(q.extra).toEqual({ k: "1" });

    const out = join(dir, "sub", "profile.yaml");
    saveProfileYaml(out, p);
    expect(loadProfileYaml(out)).toEqual(p);
  });
});
