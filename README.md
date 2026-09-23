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

## First-time setup

In Claude Code, say **"set up sgz"**: the `sgz-onboarding` skill interviews you, writes
`data/users/<slug>/profile.yaml` and prints the next commands. To prepare answers (or fill
`data.example/profile.example.yaml` by hand), have these ready. The profile is the only source of facts the bot
uses; anything missing is answered as "not used".

- [ ] **slug** (latin, lowercase), full name, email, phone, Telegram (stored for forms, never put in letters)
- [ ] **City** you live in, citizenship, relocation readiness, work formats (remote/office/hybrid), business trips
- [ ] **Salary** from/to + currency (only these numbers are ever named; 0 = never name one)
- [ ] **Experience phrase** that matches the total on your hh.ru resume, e.g. «5 лет в разработке, из них 3 года коммерческой»; languages; a 2-3 sentence summary
- [ ] **Full real stack** (usually 40-60 items), not just the curated subset in your hh.ru CVs
- [ ] **Where** each major technology was used: company/project + one line (goes to `extra`)
- [ ] **Never used** but often asked for (Kubernetes, Kafka, ...) -> `never_claim_skills` (optional: skills on neither list are asked in Telegram with ✅/❌ the first time an employer mentions them)
- [ ] **Directions** (go-backend, node-backend, react, vue, fullstack, ...), hh.ru search phrases, region, stop-words, company blacklist
- [ ] At least one **published resume on hh.ru**; may the bot create/rewrite resume copies (`pool_expand_per_day`, 0 = no)?
- [ ] Consent to the **chat policy**: the bot always moves forward (yes to calls, formats, test tasks) and notifies you about test tasks and interview times
- [ ] Defaults OK? Feedback request on rejection (`feedback_request`), max 10 applications per company per 30 days and one CV direction per company, daily limits 25 hh / 10 career
- [ ] Source CVs (`.tex`/markdown) for career sites -> `data/users/<slug>/cv/`; Telegram `TG_BOT_TOKEN`/`TG_CHAT_ID` -> `data/.env`
- [ ] hh.ru login by hand (SMS/captcha) from the same country/IP class the bot runs from

Then (`import-profile` creates the user on first import):

```
pnpm sgz db import-profile --user <slug>
pnpm sgz hh-login --user <slug>
pnpm sgz run --user <slug> --source hh --dry-run --limit 1
pnpm sgz site import --user <slug> --csv data/career-sites.csv    # all imported disabled; enable a few at a time
```

For the Pi: `make sync-data`, then the same user row + `sgz db import-profile` on the Pi, and
`ssh rpi-ts sudo systemctl restart sgz` (see `docs/RUNBOOK.md`).

## Dev

```
pnpm install
pnpm -r typecheck && pnpm -r test
pnpm sgz hh-login --user yaroslav
pnpm sgz run --user yaroslav --source hh --dry-run --limit 5
pnpm dev                      # serve on :3002
pnpm --filter @sgz/web dev     # separate terminal: Vite panel with /api proxy
```

The API serves the compiled panel after deployment. During development, open the Vite URL.
With an empty `SGZ_PANEL_PASSWORD`, the panel opens without a login screen.
Use `SGZ_RUNNER=false pnpm dev` to run the panel/API without daily scheduled applications.

Career-site setup and resume tools are available through `pnpm sgz site` and `pnpm sgz resume`.
Start with a supervised dry run before enabling daily applications; browser sessions and Claude login
must be configured on the machine that runs the service.

## Deploy to the Pi

```
scripts/deploy.sh && scripts/sync-data.sh
```
