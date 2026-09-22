# sGoloyZopoy

Autonomous job-application system for hh.ru and company career sites. Runs daily on a Raspberry Pi,
picks the best resume from a pool, writes short cover letters, answers screening questionnaires and
employer chat-bots, builds tailored LaTeX resumes for career sites, reports to Telegram, and shows
everything in a web panel.

Single Go binary + React SPA + SQLite. LLM via Claude Code headless (`claude -p`). Browser via go-rod.

## Layout

```
cmd/sgz            CLI entrypoint (serve, run, hh-login, hh-record, pool, resume, db)
internal/model     shared domain types + reason codes          (frozen contract)
internal/store     SQLite persistence                          (contract: store.go)
internal/browser   go-rod wrapper                              (contract: browser.go)
internal/forms     generic form extractor/filler               (contract: forms.go)
internal/hh        hh.ru automation                            (contract: client.go)
internal/career    career-site adapters                        (contract: adapter.go)
internal/llm       claude -p wrapper + prompts                 (contract: client.go)
internal/resume    CV yaml → LaTeX → PDF
internal/runner    run orchestration, stages, limits           (contract: contract.go)
internal/notify    Telegram
internal/api       HTTP API + SSE + embedded SPA               (contract: docs/api.md)
internal/scheduler daily trigger with jitter
web/               React + Vite + TS + Tailwind panel
deploy/            systemd units, nginx vhost, install-pi.sh
data.example/      templates for the gitignored data/ dir
.claude/skills/    resume-writing skills (reference material for prompts)
```

Personal data (profiles, cookies, resumes, DB, .env) lives in `data/` which is gitignored and synced to
the Pi with `make sync-data`. See `docs/` for the API contract and the runbook.

## Dev

```
make test            # go vet + go test + web typecheck
make build           # web + go
make hh-login USER=yaroslav
go run ./cmd/sgz run --user yaroslav --source hh --dry-run --limit 5
go run ./cmd/sgz serve
```

## Deploy to the Pi

```
make build-pi deploy sync-data
```
