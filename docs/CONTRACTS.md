# Contracts & ownership (TypeScript)

Monorepo (pnpm): `packages/shared` (types only, FROZEN), `packages/server` (everything runtime),
`packages/web` (React panel). Node ≥ 22.18 (Stagehand v4). SQLite via `node:sqlite` (no native build).

## Frozen contract files — read, never edit

`packages/shared/src/{model,dedup,store,browser,hh,career,llm,runtime,api}.ts`,
`packages/server/src/db/migrations/001_init.sql`, `docs/api.md`, `CLAUDE.md`.

If a contract lacks something: work around it inside your own folder and list the gap in your report.

## Ownership — disjoint folders under packages/server/src unless stated

| W | Owns | Exports (exact names other packages will import) |
|---|---|---|
| A | `config/`, `db/` (except 001_init.sql), `commands/db.ts` | `loadConfig(): Config`, `ensureDirs(c)`, `openStore(path): Store`, `seedDefaultUsers(store)` |
| B | `browser/` | `createLauncher(llm: StagehandLLM): BrowserLauncher`, `loadCookies(path)`, `defaultUserAgent()` |
| C | `hh/`, `commands/hh-login.ts`, `commands/hh-record.ts` | `createHHClient(opts: {snapshotDir: string}): HHClient`, `createHHRecorder(c: HHClient): HHRecorder`, `loginInteractive(launcher, opts, cookiesOut)` |
| D | `llm/`, `prompts/` (server/prompts/*.md), may tighten `CLAUDE.md` | `createLLM(cfg: Config, store: Store \| null): LLMClient` |
| E | `resume/`, `commands/resume.ts` | `loadCV(path)`, `saveCV(path, cv)`, `importTex(tex)`, `renderTex(cv)`, `buildPdf(opts)`, `validateCV(base, tailored, never)` |
| F | `career/`, `commands/site.ts` | `createCareerAgent(llm: LLMClient): CareerAgent`, `atsClients: ATSClient[]`, `detectATS(baseUrl, html)` |
| G | `runner/`, `scheduler/`, `notify/`, `commands/{run,serve,pool}.ts`, `app.ts` | `createRunner(deps): RunService`, `createScheduler(...)`, `createTelegram(token, chatId, panelUrl): Notifier` |
| H | `api/`, `spa/` placeholder | `createApp(deps: ApiDeps): Hono` (ApiDeps defined in api/deps.ts by H: {cfg, store, runner, version, health hooks}) |
| I | `packages/web/**` | — |
| J | `deploy/`, `scripts/`, `docs/RUNBOOK.md`, root `package.json` scripts (append-only), `Makefile` | `scripts/install-pi.sh`, `scripts/deploy.sh`, `scripts/sync-data.sh`, `scripts/check-leaks.sh` |

`commands/index.ts` is append-only: add `import` + one key each. Merge conflicts there are resolved by the integrator.

## Rules for every agent

- No `pnpm add` — deps are fixed: stagehand, hono, @hono/node-server, zod 4, yaml, tsx, vitest, typescript, @types/node. Need something else? Say so in the report.
- Tests: vitest, offline, no browser, no `claude` binary (stub it). `pnpm --filter @sgz/server test` must stay green; `pnpm -r typecheck` must stay green — never break another folder's compile: import other workstreams' code ONLY through the exported names above, and if a name does not exist yet, code against the shared interface and inject it.
- No git commit/push. Do not touch `data/`.
- Runtime target: Raspberry Pi 4, 1.8 GB RAM, home gateway. One browser at a time; LLM batch stages with the browser closed; memory guard before heavy steps.
- Style: small modules, ESM (`.js` suffix in relative imports), no default exports, comments only where why is non-obvious.
