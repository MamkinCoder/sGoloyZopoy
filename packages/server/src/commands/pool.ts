// sgz pool sync|expand|touch --user u
import { parseArgs } from "node:util";
import { runOnce } from "./run.js";

const STAGES: Record<string, string> = { sync: "pool-sync", expand: "pool-expand", touch: "touch" };

export async function pool(args: string[]): Promise<void> {
  const [sub = "", ...rest] = args;
  const stage = STAGES[sub];
  if (!stage) throw new Error(`usage: sgz pool <${Object.keys(STAGES).join("|")}> --user <slug> [--dry-run]`);
  const { values } = parseArgs({ args: rest, options: { user: { type: "string", short: "u" }, "dry-run": { type: "boolean", default: false } }, strict: true });
  if (!values.user) throw new Error("--user is required");
  process.exitCode = await runOnce({ userSlug: values.user, source: "pool", stage, dryRun: values["dry-run"] ?? false, limit: 0 });
}
