# Runbook

What to do when something on the Pi goes wrong. Deployment steps are in `docs/DEPLOY.md`; API in `docs/api.md`.
All `make` targets run on the Mac; `sgz …`, `journalctl`, `systemctl` run on the Pi (`ssh rpi-ts`).

First look, always:

```
make status                                  # free -m, systemctl status sgz, cgroup memory, /api/health, last 30 log lines
ssh rpi-ts journalctl -u sgz --since -2h     # the run in question
```

## Telegram alerts

The notifier sends one report per run (found / deduped / sent / skipped / failed, top vacancies) and separate
alerts for failures. Alert titles below are by kind; exact wording comes from the runner.

### "hh.ru login expired" / login check failed / redirected to login page

The cookie jar for that user is stale (hh.ru sessions last weeks, sometimes days after a password change or a
login from a new IP). `GET /api/health` shows `hh_login_ok:false` and `cookies_age_h` for the user.

1. On the Mac: `pnpm sgz hh-login --user <slug>` (real browser, do the SMS/captcha).
2. `make sync-data` (ships `hh-cookies.json`), then `ssh rpi-ts sudo systemctl restart sgz`.
3. Re-run: panel -> Runs -> New run, or `ssh -t rpi-ts sgz run --user <slug> --source hh --limit 3`.

If it expires every day: check the egress IP (`curl https://api.ipify.org` on the Pi vs on the Mac); hh.ru drops
sessions that hop between countries. See "egress" below.

### "captcha" / "too many requests" / 429 / access denied

hh.ru rate-limited or flagged the account/IP. Do not retry immediately.

1. Wait 24 h. Do not run `hh-login` repeatedly in the meantime.
2. Lower `daily_limit_hh` for the user (panel -> Users, or `PUT /api/users/:slug`) to 5-10 and raise slowly.
3. Raise the throttle: `SGZ_THROTTLE_MIN=15s`, `SGZ_THROTTLE_MAX=40s` in `data/.env.pi`, `make sync-data`, restart.
4. Check egress is Russian (`install-pi.sh` prints it; or `curl -s http://ip-api.com/line/?fields=countryCode`).
5. Look at the snapshot of the failing page (below) to see whether it is a captcha or a ban page.

### "low memory" / memory guard tripped / run aborted before LLM stage

The runner refuses to open the browser or call the LLM when `MemAvailable` is under `SGZ_MEMORY_GUARD_MB`
(default 450). A run that dies with `signal 9` in the journal was OOM-killed inside its cgroup
(`MemoryMax=1300M` in `sgz.service`); the gateway services carry `OOMScoreAdjust=-900` and stay up.

```
ssh rpi-ts 'free -m; systemd-cgtop -b -n1 -m 10'
ssh rpi-ts 'journalctl -k --since -1h | grep -i -E "oom|killed process"'
ssh rpi-ts 'cat /sys/fs/cgroup/system.slice/sgz.service/memory.peak'
```

Then, in order:
1. Make sure nothing else grew: `sb-webui`, Pi-hole, unbound, a stale chromium (`pgrep -a chromium`; the unit uses
   `KillMode=control-group`, so leftovers only survive if the service itself is still up).
2. Lower the limit per run (`daily_limit_hh`), so fewer tabs/snapshots live at once.
3. Lower `MemoryHigh` / `MemoryMax` only if the gateway services suffered (they should not; they are protected).
4. Last resort, run the bot on the Mac and keep the Pi as the panel: `SGZ_RUNNER=false` in `data/.env.pi`,
   `make sync-data`, restart; on the Mac `pnpm sgz run --user <slug> --source hh` (or `pnpm dev` with
   `SGZ_SCHEDULE` set). Each machine has its own `sgz.db`, so applications made from the Mac are only in the Mac's
   DB; dedup across machines is not shared.

### "claude failed" / LLM error / empty JSON from the model

`claude -p` returned nothing, invalid JSON, or an auth error.

```
ssh rpi-ts "claude -p 'reply with ok'"          # auth still valid? (re-login: ssh -t rpi-ts claude)
ssh rpi-ts 'journalctl -u sgz -n 200 | grep -i -E "claude|llm"'
```

Subscription rate limits reset every 5 h; the runner retries next day. If `claude` itself is broken after an
upgrade: `sudo /usr/local/bin/npm i -g @anthropic-ai/claude-code@<previous>`.

### "pdf build failed" / pdflatex error

`ssh rpi-ts 'journalctl -u sgz -n 200 | grep -A20 pdflatex'`. Missing `.sty` -> find the Debian package
(`apt-file search name.sty`; most live in `texlive-latex-extra` / `texlive-fonts-extra`, both installed by
`install-pi.sh`). Verify the class deps: `kpsewhich memoir.cls droidsans.sty fontawesome5.sty marvosym.sty`.
The `.tex` of a failed build is kept under `data/users/<slug>/generated/`; compile it by hand there to see the log.

### "chromium crashed" / browser launch failed / target closed

```
ssh rpi-ts 'chromium --headless=new --no-sandbox --disable-gpu --dump-dom about:blank | head -3'
ssh rpi-ts 'df -h /; ls -la /opt/sgz/data/users/*/chrome-profile'
```

A corrupt profile is safe to delete (`rm -rf /opt/sgz/data/users/<slug>/chrome-profile`); cookies live in
`hh-cookies.json`, not in the profile. `/dev/shm` is small on the Pi; the launcher passes
`--disable-dev-shm-usage`; if it does not, that is the first thing to fix in `packages/server/src/browser/`.

### "run failed" (generic)

`GET /api/runs/:id` has `error`; `GET /api/runs/:id/events` has the stage log; the panel shows both. Stop a stuck
run with `POST /api/runs/:id/stop` (panel button) or `sudo systemctl restart sgz` (kills the whole cgroup).

## Reading snapshots

Every failed or ambiguous page is dumped as HTML (scrubbed of tokens/phones by `hh/scrub.ts`) to
`/opt/sgz/data/snapshots/run-<id>/`. Per application: `GET /api/applications/:id/snapshot` (panel: the application
detail page). By hand:

```
ssh rpi-ts 'ls -la /opt/sgz/data/snapshots/run-42/'
rsync -az rpi-ts:/opt/sgz/data/snapshots/run-42/ /tmp/run-42/ && open /tmp/run-42/*.html
```

Snapshots are never synced back to git (`snapshots/` is gitignored). Delete old ones to free the SD card:
`find /opt/sgz/data/snapshots -maxdepth 1 -mtime +30 -exec rm -rf {} +`.

## Rolling back a release

`scripts/deploy.sh` copies the running release to `/opt/sgz/app.prev` before each rsync.

```
make rollback            # stop sgz, rsync app.prev -> app, start, print is-active
ssh rpi-ts cat /opt/sgz/app.prev/RELEASE
```

Database migrations are forward-only; if the new release added a migration, restore the DB backup taken before
the deploy (below) or keep the new schema (older code usually tolerates extra columns).

## Backing up the database

SQLite in WAL mode: never copy `sgz.db` while the service runs; use the online backup.

```
make backup-db           # ssh: sqlite3 /opt/sgz/data/sgz.db ".backup /opt/sgz/backups/sgz-YYYY-MM-DD.db"; rsync to data/backups/
```

Restore: `sudo systemctl stop sgz; cp /opt/sgz/backups/sgz-YYYY-MM-DD.db /opt/sgz/data/sgz.db; rm -f
/opt/sgz/data/sgz.db-wal /opt/sgz/data/sgz.db-shm; sudo systemctl start sgz`. Consider a weekly cron on the Mac
calling `make backup-db`.

## Adding a career site

1. Panel -> Career sites -> Add: `adapter` (one of `GET /api/adapters`, e.g. an ATS name or `generic`),
   `base_url`, `config` (per adapter), `enabled`. Or `POST /api/users/:slug/career-sites`.
   For a prepared CSV (`slug,name,category,base_url,note`), import it with
   `sgz site import --user <slug> --csv <path>`. The import validates every row before writing, updates
   matching slugs while preserving their enabled/profile/run state, and stores category/note in the new
   site's profile notes.
2. Onboard it once with a dry run: Runs -> New run, source `career`, stage `onboard:<siteId>`, dry run. The
   agent walks the site, records selectors into the action cache and stores what it found.
3. Real run with `--limit 1`, check the generated resume (`GET /api/resumes/:id/pdf`) and the application.
4. A site that needs a new ATS client belongs in `packages/server/src/career/` (workstream F); the adapter list is
   `atsClients` there.

## Rotating the panel password

1. `SGZ_PANEL_PASSWORD=<new>` in `data/.env` on the Mac (this file is gitignored; `make check-leaks` fails if it
   ever gets tracked).
2. `make sync-data && ssh rpi-ts sudo systemctl restart sgz`.
3. Existing `sgz_session` cookies are invalidated by the restart if sessions are in memory; if they are stored in the
   DB (`settings`), log out from the panel once. Then log in again on each device.

Also rotate when: the Pi was reachable from outside, the password was typed on a shared machine, or a snapshot
of the panel was shared.

## Egress / network

- The Pi's own traffic may be routed through sing-box (tproxy). hh.ru must see a Russian IP.
  Check: `ssh rpi-ts 'curl -s https://api.ipify.org; echo; curl -s "http://ip-api.com/line/?fields=countryCode"'`.
  Fix in the sing-box route rules: direct for uid `rpi` (`id -u rpi`) or for `*.hh.ru`; then `sudo systemctl restart sing-box`
  (a few seconds of no internet for the flat).
- Port 3002 is only reachable from `tailscale0` and via nginx on :80 (`sgz.rp.i`); nftables on eth0 drops it.
  Do not open it; use Tailscale.
- Pi-hole DNS record: `/etc/pihole/hosts/custom.list` (`sudo pihole reloaddns` after edits) or the web UI
  Local DNS records (`dns.hosts` in `pihole.toml`).

## Service cheatsheet (on the Pi)

```
systemctl status sgz --no-pager          journalctl -fu sgz          journalctl -u sgz --since today
sudo systemctl restart sgz               sudo systemctl stop sgz     systemd-cgtop -b -n1
sgz run --user <slug> --source hh --dry-run --limit 3      # CLI wrapper with the service env
sgz db …                                                   # DB commands, see `sgz --help`
cat /opt/sgz/app/RELEASE                                   # what is deployed
```

Node versions: `/usr/local/bin/node` = 22 (sgz), `/usr/bin/node` = Debian 20 (`sb-webui`). Upgrading Node 22:
re-run `make install-pi` after removing `/usr/local/bin/node`, or `sudo n 22` if `n` is installed.
