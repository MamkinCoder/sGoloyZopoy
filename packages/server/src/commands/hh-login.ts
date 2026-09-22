// sgz hh-login --user slug [--bin path]
// Opens a headed Chrome with a dedicated persistent profile, waits for the human to log in and
// stores *.hh.ru cookies to data/users/<slug>/hh-cookies.json.
import { join } from "node:path";
import { loginInteractive } from "../hh/login.js";
import { chromiumBin, dataDir, loadLauncher, parseArgs, str, userAgent } from "./hh-common.js";

export const hhLogin = async (args: string[]): Promise<void> => {
  const a = parseArgs(args);
  const slug = str(a.user);
  if (!slug) throw new Error("usage: sgz hh-login --user <slug> [--bin <chrome path>]");
  const base = dataDir();
  const userDir = join(base, "users", slug);
  const launcher = await loadLauncher();
  await loginInteractive(
    launcher,
    {
      executablePath: chromiumBin(str(a.bin)),
      headless: false,
      userDataDir: join(userDir, "chrome-profile-login"),
      userAgent: userAgent(),
      snapshotDir: join(base, "snapshots", "login"),
      blockAssets: false,
      cacheDir: join(base, "action-cache"),
    },
    join(userDir, "hh-cookies.json"),
  );
};
