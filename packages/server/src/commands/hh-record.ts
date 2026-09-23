// sgz hh-record --user slug [--vacancy <id|url>] [--negotiation id] [--resumes] [--out dir]
// Headless run with the persistent profile + injected cookies; records every step of the chosen
// flows into <out> (default data/recordings/<slug>-<timestamp>). Nothing is submitted.
import { join } from "node:path";
import { loadCookies } from "../browser/cookies.js";
import { createHHClient } from "../hh/client.js";
import { createHHRecorder } from "../hh/recorder.js";
import { chromiumBin, dataDir, loadLauncher, parseArgs, str, userAgent } from "./hh-common.js";

export const hhRecord = async (args: string[]): Promise<void> => {
  const a = parseArgs(args);
  const slug = str(a.user);
  if (!slug) throw new Error("usage: sgz hh-record --user <slug> [--vacancy <id|url>] [--negotiation <id>] [--resumes] [--out <dir>]");
  const base = dataDir();
  const userDir = join(base, "users", slug);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = str(a.out) || join(base, "recordings", `${slug}-${stamp}`);
  const snapshotDir = join(outDir, "snapshots");
  const launcher = loadLauncher();
  const client = createHHClient({ snapshotDir, log: (m, d) => console.log(m, d ? JSON.stringify(d) : "") });
  const recorder = createHHRecorder(client);
  const s = await launcher.launch({
    executablePath: chromiumBin(str(a.bin)),
    headless: true,
    userDataDir: join(userDir, "chrome-profile"),
    userAgent: userAgent(),
    snapshotDir,
    blockAssets: true,
    cacheDir: join(base, "action-cache"),
  });
  try {
    const cookies = await loadCookies(join(userDir, "hh-cookies.json")).catch(() => []);
    if (cookies.length) await s.setCookies(cookies);
    if (!(await client.checkLogin(s))) throw new Error("not logged in: run `sgz hh-login` first");
    const vacancy = str(a.vacancy);
    const negotiation = str(a.negotiation);
    const nothing = !vacancy && !negotiation && !a.resumes && !a.chats;
    if (vacancy) await recorder.recordVacancyFlow(s, vacancy, join(outDir, "vacancy"));
    if (negotiation || a.chats || nothing) await recorder.recordNegotiations(s, negotiation || null, join(outDir, "negotiations"));
    if (a.resumes || nothing) await recorder.recordResumes(s, join(outDir, "resumes"));
    console.log(`recorded to ${outDir}. Scrub before committing as fixtures: hh/scrub.ts scrubHtml()`);
  } finally {
    await s.close().catch(() => {});
  }
};
