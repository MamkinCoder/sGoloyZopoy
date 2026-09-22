// sgz run --user u|all --source hh|career|all|pool [--stage s] [--dry-run] [--limit N]
import { parseArgs } from "node:util";
import type { RunSource } from "@sgz/shared";
import { createAppContext } from "../app.js";

const SOURCES: RunSource[] = ["hh", "career", "all", "pool"];

export function parseRunArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      user: { type: "string", short: "u", default: "all" },
      source: { type: "string", short: "s", default: "all" },
      stage: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string", default: "0" },
    },
    strict: true,
  });
  const source = values.source as RunSource;
  if (!SOURCES.includes(source)) throw new Error(`--source must be one of ${SOURCES.join("|")}`);
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer");
  return { userSlug: values.user ?? "all", source, stage: values.stage, dryRun: values["dry-run"] ?? false, limit };
}

export async function runOnce(req: ReturnType<typeof parseRunArgs>): Promise<number> {
  const app = await createAppContext({ withScheduler: false });
  try {
    const id = await app.runner.start({ ...req, trigger: "cli" });
    const onSignal = () => void app.runner.stop(id);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    for await (const ev of app.runner.subscribe(id)) console.log(`[${ev.stage}] ${ev.level === "info" ? "" : ev.level.toUpperCase() + ": "}${ev.message}`);
    const run = await app.runner.wait(id);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    console.log(JSON.stringify({ run_id: run.id, status: run.status, error: run.error, stats: run.stats }, null, 2));
    return run.status === "done" ? 0 : 1;
  } finally {
    await app.close();
  }
}

export async function run(args: string[]): Promise<void> {
  process.exitCode = await runOnce(parseRunArgs(args));
}
