# Deploying to the Raspberry Pi

Target: Raspberry Pi 4B (aarch64, 1.8 GB RAM, zram swap, Debian 13). The Pi is also the home gateway
(Pi-hole :53, unbound :5335, sing-box tproxy, nginx :80, `sb-webui` on Debian's Node 20). Nothing here
installs docker, touches nftables, or restarts the gateway services.

Layout on the Pi:

| Path | What |
|---|---|
| `/opt/sgz/app` | the built app (rsynced by `scripts/deploy.sh`, previous release in `/opt/sgz/app.prev`) |
| `/opt/sgz/data` | `.env`, `users/<slug>/{profile.yaml,hh-cookies.json,cv/}`, `tex/`, `sgz.db`, `snapshots/` |
| `/opt/sgz/bin/sgz` | CLI wrapper with the service's env (`sgz run --user … --limit 3`), symlinked to `/usr/local/bin/sgz` |
| `/opt/sgz/backups` | sqlite `.backup` files (`make backup-db`) |
| `/usr/local/bin/node` | Node 22 (side-by-side; Debian's `/usr/bin/node` 20 stays for `sb-webui`) |
| `/usr/local/bin/{pnpm,claude}` | installed with Node 22's npm |
| `/etc/systemd/system/sgz.service` | from `deploy/sgz.service` |
| `/etc/systemd/system/{sing-box,pihole-FTL,unbound}.service.d/oom-protect.conf` | `OOMScoreAdjust=-900` |
| `/etc/nginx/sites-enabled/sgz.conf` | `sgz.rp.i` -> `127.0.0.1:3002` |
| `/etc/pihole/hosts/custom.list` | `192.168.0.4 sgz.rp.i` |

## 0. Prerequisites on the Mac

- `ssh rpi-ts` works without a password (alias in `~/.ssh/config`), user `rpi`, passwordless sudo on the Pi.
- Node 22+, pnpm 10 (`corepack enable` or `npm i -g pnpm`), `pnpm install` done in the repo.
- `data/` populated: `data/.env` (from `data.example/.env.example`), `data/users/<slug>/profile.yaml`,
  `data/users/<slug>/cv/…`, `data/tex/` (the CV class). Never commit `data/`.
- Optional `data/.env.pi`: lines appended to the Pi's `.env` only (e.g. `SGZ_RUNNER=false`).
- Optional `data/scrub.json`: `{"patterns": ["surname", "+7 9xx", "employer name"]}` for `make check-leaks`.

## 1. Prepare the Pi: `make install-pi`

Copies `deploy/` + `scripts/` to `/tmp/sgz-install` on the Pi and runs `scripts/install-pi.sh` there
(interactive ssh, takes a while: TeX is ~1.5 GB of packages). Idempotent, re-run any time.

It installs apt packages (chromium, fonts, TeX for pdflatex incl. `texlive-fonts-extra`, rsync, sqlite3),
Node 22 into `/usr/local` (tarball from nodejs.org, checksum verified; alternative: `npm i -g n && sudo n 22`),
pnpm + `@anthropic-ai/claude-code`, the dirs, the systemd unit (enabled, not started), the journald cap,
OOM drop-ins (applied live via `/proc/<pid>/oom_score_adj` too, no gateway restart), the nginx vhost and the
Pi-hole record. Then smoke checks: `sb-webui` still active, chromium headless, `kpsewhich` for the CV class
deps (`memoir.cls droidsans.sty fontawesome5.sty marvosym.sty datetime.sty xifthen.sty`), `https://hh.ru/`
returns 200, and the egress IP + country. **If the country is not RU**, sing-box is proxying the Pi's own
traffic; hh.ru will captcha or ban a foreign IP. Add a direct rule for the `rpi` uid / `sgz.service` cgroup
or for `*.hh.ru` in the sing-box route before running the bot.

About the LaTeX engine: the config key is `XELATEX_BIN` (frozen contract name), but the CV class
(`ReadableCV.cls`, memoir + T2A + babel russian + droidsans + fontawesome5) compiles with **pdflatex**.
The unit and `sync-data.sh` set `XELATEX_BIN=/usr/bin/pdflatex`.

## 2. Log the Claude CLI in on the Pi (once)

```
ssh -t rpi-ts claude
```

Follow the prompt (`/login` if it does not start by itself): it prints a URL, open it on the Mac, log in with the
subscription account, paste the code back into the terminal. Credentials land in `/home/rpi/.claude/`; the service runs
as `rpi` with `HOME=/home/rpi`, so it picks them up. Verify headless mode, which is what the runner uses:

```
ssh rpi-ts "claude -p 'reply with the single word ok'"
```

## 3. Log into hh.ru on the Mac (per user)

```
pnpm sgz hh-login --user yaroslav
```

Opens a real browser, you log in (SMS/captcha), cookies are saved to `data/users/yaroslav/hh-cookies.json`.
Browser profiles are per machine and are not synced; only the cookie jar is.

## 4. Ship data: `make sync-data`

`rsync data/ -> rpi-ts:/opt/sgz/data` without `--delete`. Excludes `sgz.db*`, `snapshots/`, `chrome-profile*/`,
`action-cache/`, `recordings/`, `generated/`, `backups/`. `.env` is rewritten for the Pi: `SGZ_DATA_DIR` and
`SGZ_REPO_DIR` are dropped (systemd's `EnvironmentFile=` would otherwise override the unit's `/opt/sgz` paths),
`CHROMIUM_BIN`, `CLAUDE_BIN`, `XELATEX_BIN` are pinned to the Pi binaries, then `data/.env.pi` is appended.
Re-run after every `hh-login` (cookies) or profile/CV change.

## 5. Ship the app: `make deploy`

`scripts/deploy.sh`: `pnpm -r typecheck`, build web + server, copy `packages/web/dist` into `packages/server/spa`,
stage the runtime set (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/*/package.json`,
`packages/server/{dist,prompts,spa,src/db/migrations}`, `packages/shared/src`, `CLAUDE.md`, `.claude/`, `deploy/`,
`scripts/`, `docs/`, a `RELEASE` stamp), rsync it with `--delete` (node_modules and data excluded), keep the previous
release in `/opt/sgz/app.prev`, then on the Pi `pnpm install --prod --frozen-lockfile --filter '@sgz/server...'`
with Node 22, `sudo systemctl restart sgz`, and print `journalctl -u sgz -n 20`. Exit 1 if the service is not active.

Flags: `--no-build` (ship what is already built), `--no-restart`.

## 6. First supervised run

Keep two terminals on the Pi:

```
ssh rpi-ts 'watch -n2 free -m'
ssh rpi-ts 'journalctl -fu sgz'
```

and in a third one, a small dry run through the service's CLI wrapper (same env as the unit):

```
ssh -t rpi-ts sgz run --user yaroslav --source hh --dry-run --limit 3
```

Or start it from the panel (Runs -> New run, dry run, limit 3). Watch: `available` in `free -m` should stay above
~400 MB with chromium open; `journalctl` should show the memory guard before the LLM stage; `systemd-cgtop` shows
`sgz.service` under `MemoryHigh=1050M`. If `available` dips under 250 MB, stop the run and see RUNBOOK "low memory".
Then a real run with `--limit 3`, check the applications in the panel and on hh.ru, then raise the limit.

## 7. Enable the schedule

`SGZ_SCHEDULE=12:00` (+/- `SGZ_SCHEDULE_JITTER_MIN`, default 20) and `SGZ_TZ=Europe/Moscow` in `data/.env` (or
`data/.env.pi`), then `make sync-data` and `ssh rpi-ts sudo systemctl restart sgz`. `SGZ_SCHEDULE=` (empty)
turns the daily run off; `SGZ_RUNNER=false` keeps the panel but never runs the bot on this box. The next
scheduled time shows up in `GET /api/health` (`scheduler_next`) and in `make status`.

## 8. Access

| From | URL | Notes |
|---|---|---|
| LAN, DNS = Pi-hole | http://sgz.rp.i | nginx vhost -> :3002; record in `/etc/pihole/hosts/custom.list` |
| Tailscale | http://100.95.139.14:3002 | direct; tailscale0 allows everything in nftables. Not via :80 (no catch-all vhost, Host = IP) |
| LAN by IP | http://192.168.0.4:3002 | blocked: nftables `inet filter` on eth0 only allows 22/80/443/53 |
| Pi-hole admin | http://pi.hole/admin or http://rp.i/admin | existing |

`SGZ_PANEL_URL=http://sgz.rp.i` is what Telegram links point to; set it to the Tailscale URL if you mostly read
alerts away from home.

Pi-hole v6 keeps local records in two places, both honoured by FTL: files in `/etc/pihole/hosts/` (what
`install-pi.sh` writes, `sudo pihole reloaddns` after edits) and `dns.hosts` in `/etc/pihole/pihole.toml`
(what the web UI "Local DNS records" writes; CLI: `sudo pihole-FTL --config dns.hosts`). On Pi-hole v5 the file
was `/etc/pihole/custom.list` and `pihole -a hostrecord` was the CLI.

## Day-to-day

```
make status        # memory, service, health, last logs
make logs          # follow the journal
make backup-db     # sqlite .backup -> /opt/sgz/backups and data/backups/
make rollback      # previous release back, restart
make check-leaks   # before every git push
```

Logs: journald only (`journalctl -u sgz`), capped at 200 MB by `/etc/systemd/journald.conf.d/sgz.conf`; no
logrotate needed. Everything else is in `docs/RUNBOOK.md`.
