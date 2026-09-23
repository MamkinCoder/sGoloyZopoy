# Handoff for Claude

Date: 2026-09-23. The project is deployed and running. Do not start an application run until the user explicitly asks.

## Current state

- Repository: `/opt/sgz/app` on `rpi-ts`; branch `main`, release contains commit `158425f`.
- Service: `sgz.service` is enabled and active. The panel is bound to `127.0.0.1:3002` on the Pi.
- From the Mac, open it through this bridge:

  ```sh
  ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -L 127.0.0.1:3002:127.0.0.1:3002 rpi-ts
  ```

  Then open `http://127.0.0.1:3002`.
- Persistent data is `/opt/sgz/data`. Never store cookies, `.env`, generated files, or database backups in git.
- The panel database is `/opt/sgz/data/sgz.db`.
- `yaroslav` has a populated profile: all work formats, open to relocation, salary from 220,000 RUR. It has been imported into the database.
- HH cookies for `yaroslav` are present on the Pi. Validate before any real run.
- 142 career sites were imported for `yaroslav`; every one is disabled. Do not enable them in bulk.
- The LaTeX class/assets and source CVs are in `/opt/sgz/data/tex` and `/opt/sgz/data/users/yaroslav/cv`.
- Claude Code is logged in on the Pi. Its API traffic must use the local HTTP proxy at `http://127.0.0.1:1081`; `sgz.service` already has this in a systemd drop-in.

## Important deployment detail

`/opt/sgz/data/.env` must **not** contain `SGZ_DATA_DIR` or `SGZ_REPO_DIR`. Those keys override the systemd service paths and make the panel read the wrong database (`/opt/sgz/app/data/sgz.db`), which looks like an empty profile. The active setup has those keys removed.

For direct Pi CLI work, preserve the production paths:

```sh
SGZ_DATA_DIR=/opt/sgz/data SGZ_REPO_DIR=/opt/sgz/app sgz <command>
```

## What to do next

1. Inspect the panel and confirm the Yaroslav profile, HH login health, and disabled career-site list.
2. Use a small **dry run** to verify the HH workflow and generated CV pipeline. Start with HH only, limit 1-3, and examine events/snapshots. Do not submit an application.
3. If HH works, create or inspect the HH resume pool. Ensure every resume and cover letter only claims profile skills; never claim Kubernetes, Kafka, RabbitMQ, or ClickHouse.
4. Enable and onboard career sites one at a time, beginning with a small set of high-priority employers. Each site needs a dry onboarding run before it can be used for a real application.
5. Before any real run, show the user the exact source, limit, and expected behavior. Use a limit of one for the first real application and inspect the created application afterward.

## Useful commands

```sh
# status and logs
systemctl status sgz --no-pager
journalctl -fu sgz
curl -fsS http://127.0.0.1:3002/api/health | jq

# Validate the logged-in HH session without applying
SGZ_DATA_DIR=/opt/sgz/data SGZ_REPO_DIR=/opt/sgz/app sgz run --user yaroslav --source hh --dry-run --limit 1

# Restart only after config/deployment changes
sudo systemctl restart sgz

# Verify Claude connectivity via the VPN HTTP proxy
ALL_PROXY=http://127.0.0.1:1081 HTTPS_PROXY=http://127.0.0.1:1081 HTTP_PROXY=http://127.0.0.1:1081 \
  claude -p 'reply only: ok'
```

Read `docs/RUNBOOK.md` before troubleshooting, and use `CLAUDE.md` as the content and truthfulness policy for all generated application materials.
