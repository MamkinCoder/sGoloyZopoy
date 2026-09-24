#!/usr/bin/env node
// sgz CLI entrypoint. Subcommands register themselves in ./commands/index.ts (workstream G wires them).
//   sgz serve | run | hh-login | habr-login | hh-record | pool | resume | site | db | version
import { errMessage } from "@sgz/shared";
import { readFileSync } from "node:fs";
import tls from "node:tls";

// Many Russian banks and state companies chain to the Минцифры root CA, which Node doesn't ship. Trust it
// in addition to the default roots (verification stays on); certs/ holds the official root + sub CA.
try {
  const dir = new URL("../certs/", import.meta.url);
  const extra = ["russian_trusted_root_ca.pem", "russian_trusted_sub_ca.pem"].map((f) => readFileSync(new URL(f, dir), "utf8"));
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...extra]);
} catch (e) {
  console.error(`sgz: extra CA certificates not loaded: ${errMessage(e)}`);
}
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
