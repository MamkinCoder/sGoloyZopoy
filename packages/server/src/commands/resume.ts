// sgz resume import|render|build|validate — the CV toolchain from the command line.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildPdf, resolveLatexBin } from "../resume/build.js";
import { importTex } from "../resume/import.js";
import { renderTex } from "../resume/render.js";
import { validateCV } from "../resume/validate.js";
import { loadCV, saveCV } from "../resume/yaml.js";

const USAGE = `usage:
  sgz resume import <file.tex> --out <cv.yaml>
  sgz resume render --cv <cv.yaml> [--out <file.tex>]
  sgz resume build --cv <cv.yaml> --texdir <dir with ReadableCV.cls> --out <file.pdf> [--latex <bin>] [--timeout <ms>]
  sgz resume validate --base <base.yaml> --tailored <tailored.yaml> [--never a,b,c]`;

function need(values: Record<string, string | boolean | undefined>, key: string): string {
  const v = values[key];
  if (typeof v !== "string" || !v) throw new Error(`--${key} is required\n${USAGE}`);
  return v;
}

export async function resume(args: string[]): Promise<void> {
  const [sub = "", ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      cv: { type: "string" },
      texdir: { type: "string" },
      latex: { type: "string" },
      xelatex: { type: "string" }, // legacy alias of --latex
      timeout: { type: "string" },
      base: { type: "string" },
      tailored: { type: "string" },
      never: { type: "string" },
    },
  });

  switch (sub) {
    case "import": {
      const src = positionals[0];
      if (!src) throw new Error(`import needs a .tex path\n${USAGE}`);
      const { cv, warnings } = importTex(readFileSync(src, "utf8"));
      saveCV(need(values, "out"), cv);
      for (const w of warnings) console.error(`warning: ${w}`);
      console.log(`imported ${cv.jobs.length} jobs, ${cv.skills.length} skill groups → ${values.out}`);
      return;
    }
    case "render": {
      const tex = renderTex(loadCV(need(values, "cv")));
      if (values.out) {
        writeFileSync(values.out, tex, "utf8");
        console.log(`wrote ${values.out}`);
      } else process.stdout.write(tex);
      return;
    }
    case "build": {
      const cv = loadCV(need(values, "cv"));
      const outPdf = need(values, "out");
      const { log } = await buildPdf({
        latexBin: await resolveLatexBin(values.latex ?? values.xelatex ?? process.env.SGZ_LATEX_BIN ?? ""),
        texDir: need(values, "texdir"),
        texSource: renderTex(cv),
        outPdf,
        timeoutMs: values.timeout ? Number(values.timeout) : undefined,
      });
      const pages = /Output written on main\.pdf \((\d+) pages?/.exec(log)?.[1];
      console.log(`wrote ${outPdf}${pages ? ` (${pages} page${pages === "1" ? "" : "s"})` : ""}`);
      return;
    }
    case "validate": {
      const never = (values.never ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const violations = validateCV(loadCV(need(values, "base")), loadCV(need(values, "tailored")), never);
      if (violations.length === 0) {
        console.log("ok");
        return;
      }
      for (const v of violations) console.log(`- ${v}`);
      process.exitCode = 1;
      return;
    }
    default:
      throw new Error(USAGE);
  }
}
