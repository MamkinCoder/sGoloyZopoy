#!/usr/bin/env node
// sgz CLI entrypoint. Subcommands register themselves in ./commands/index.ts (workstream G wires them).
//   sgz serve | run | hh-login | hh-record | pool | resume | site | db | version
import { commands } from "./commands/index.js";

const [name = "", ...args] = process.argv.slice(2);
const cmd = commands[name];
if (!cmd) {
  console.error(`usage: sgz <${Object.keys(commands).join("|")}> [flags]`);
  process.exit(2);
}
cmd(args).catch((err: unknown) => {
  console.error("error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
