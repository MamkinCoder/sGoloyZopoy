import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyCV } from "../../src/resume/yaml.js";
import { renderTex } from "../../src/resume/render.js";
import { validateCV } from "../../src/resume/validate.js";
import { buildPdf } from "../../src/resume/build.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("resume toolchain", () => {
  it("rejects altered employment facts and forbidden skills without matching substrings", () => {
    const base = { ...emptyCV(), name: "Example", title: "Developer", jobs: [{ company: "Example", period: "2020-2022", role: "Developer", location: "", summary: "", bullets: [], stack: [] }] };
    const changed = structuredClone(base);
    changed.jobs[0]!.period = "2018-2022";
    changed.skills = [{ name: "Tools", items: ["Go", "Google"] }];
    expect(validateCV(base, changed, ["Go"])).toEqual(expect.arrayContaining([
      expect.stringContaining("job removed or changed"), expect.stringContaining("job added or changed"),
      expect.stringContaining("never_claim"),
    ]));
    changed.jobs = base.jobs;
    changed.skills = [{ name: "Tools", items: ["Google"] }];
    expect(validateCV(base, changed, ["Go"])).toEqual([]);
  });

  it("escapes profile text in LaTeX and resolves the template", () => {
    const tex = renderTex({ ...emptyCV(), name: "A & B", title: "100% Developer", about: "C_1" });
    expect(tex).toContain("A \\& B");
    expect(tex).toContain("100\\% Developer");
    expect(tex).toContain("C\\_1");
    expect(tex).not.toContain("{{");
  });

  it("passes source through two engine passes and copies the resulting PDF", async () => {
    const root = mkdtempSync(join(tmpdir(), "sgz-resume-test-")); dirs.push(root);
    const texDir = join(root, "template"); mkdirSync(texDir);
    const engine = join(root, "latex-stub");
    writeFileSync(engine, '#!/bin/sh\n[ -f main.tex ] || exit 2\nif [ -f first-pass ]; then cp main.tex main.pdf; else touch first-pass; fi\nprintf "compiled" > main.log\n', { mode: 0o755 });
    const output = join(root, "output", "cv.pdf");
    await expect(buildPdf({ latexBin: engine, texDir, texSource: "example source", outPdf: output })).resolves.toEqual({ log: "compiled" });
    expect(readFileSync(output, "utf8")).toBe("example source");
  });
});
