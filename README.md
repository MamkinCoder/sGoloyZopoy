# sGoloyZopoy

Autonomous job-application system for hh.ru and company career sites. Runs daily on a Raspberry Pi,
picks the best resume from a pool, writes short cover letters, answers screening questionnaires and
employer chat-bots, builds tailored LaTeX resumes for career sites, reports to Telegram, and shows
everything in a web panel.

TypeScript monorepo (pnpm): Node 22 server + React SPA + SQLite (`node:sqlite`). Browser automation
via **Stagehand v4** (natural-language `act/extract/observe` over CDP, selector cache, self-healing).
LLM via Claude Code headless (`claude -p`, subscription) — also plugged into Stagehand as its model.

## Layout

```
packages/shared/src   frozen contracts: domain types, Store, BrowserSession, HHClient, CareerAgent, LLMClient, RunService, API DTOs
packages/server/src   config, db (node:sqlite), browser (Stagehand), hh, career (ATS clients + agent flow),
                      llm (claude -p + prompts), resume (yaml→LaTeX→PDF), runner, scheduler, notify, api (Hono), commands (CLI)
packages/web          React + Vite + Tailwind panel
deploy/ scripts/      systemd units, nginx vhost, install-pi.sh, deploy/sync scripts
data.example/         templates for the gitignored data/ dir
.claude/skills/       resume-writing skills (source material for prompts)
docs/                 api.md (routes), CONTRACTS.md (ownership), RUNBOOK.md
```

Personal data (profiles, cookies, resumes, DB, .env) lives in `data/` which is gitignored and synced to
the Pi with `scripts/sync-data.sh`.

## Dev

```
pnpm install
pnpm -r typecheck && pnpm -r test
pnpm sgz hh-login --user yaroslav
pnpm sgz run --user yaroslav --source hh --dry-run --limit 5
pnpm dev                      # serve on :3002
```

## Deploy to the Pi

```
scripts/deploy.sh && scripts/sync-data.sh
```
