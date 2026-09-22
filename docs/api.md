# HTTP API contract

Base: `/api`. All JSON. Auth: `POST /api/login {password}` sets an HttpOnly cookie `sgz_session`;
every other route requires it (401 otherwise). Times are RFC3339 UTC. `slug` is `users.slug`.

## Auth
| Method | Path | Body / Query | Response |
|---|---|---|---|
| POST | /login | `{password}` | `{ok:true}` |
| POST | /logout | | `{ok:true}` |
| GET | /me | | `{authenticated:bool}` |

## Users & profile
| GET | /users | | `[{id, slug, name, tg_chat_id, daily_limit_hh, daily_limit_career, active}]` |
| PUT | /users/:slug | `{name?, tg_chat_id?, daily_limit_hh?, daily_limit_career?, active?}` | user |
| GET | /users/:slug/profile | | `Profile` (see model.Profile json tags) |
| PUT | /users/:slug/profile | `Profile` | `Profile` |
| GET | /users/:slug/stats?range=today\|7d\|30d\|all | | `{sent, skipped, failed, by_status:{}, invitations, rejections, chat_replies, runs_count}` |

## Applications
| GET | /users/:slug/applications?status=&source=&since=&until=&page=&page_size= | | `{items:[{application, vacancy, resume_title}], total}` |
| GET | /applications/:id | | `{application, vacancy, resume_title, questionnaire:[{question, answer}]}` |
| GET | /applications/:id/snapshot | | HTML snapshot if any (404 otherwise) |

`application` fields: `id, user_id, vacancy_id, hh_resume_id, generated_resume_id, run_id, status,
reason_detail, cover_letter, llm_decision, created_at`. `vacancy`: `id, source, external_id, url, title,
company, salary_from, salary_to, currency, has_test, requires_letter, area, work_format, published_at`.

## Resumes
| GET | /users/:slug/resumes | | `{hh:[HHResume], generated:[GeneratedResume]}` |
| POST | /users/:slug/resumes/sync | | `{run_id}` (queues a `pool` run, stage sync) |
| POST | /users/:slug/resumes/expand | `{max?}` | `{run_id}` |
| POST | /users/:slug/resumes/touch | | `{run_id}` (Поднять в поиске for all) |
| GET | /resumes/:id/pdf | | `application/pdf` (GeneratedResume) |
| GET | /resumes/:id/tex | | `text/plain` |

`HHResume`: `id, hh_resume_id, title, url, direction, summary:{direction, seniority, key_skills, one_line}, is_generated, synced_at`.
`GeneratedResume`: `id, vacancy_id, vacancy_title, company, pdf_url, tex_url, model, created_at`.

## Chats
| GET | /users/:slug/chats | | `[{id, hh_negotiation_id, vacancy:{id,title,company,url}|null, employer, state, last_seen_at, unanswered:int}]` |
| GET | /chats/:id/messages | | `[ChatMessage]` |

## Runs
| GET | /runs?user=slug&limit=50 | | `[Run]` |
| POST | /runs | `{user: slug\|"all", source: "hh"\|"career"\|"all"\|"pool", dry_run?:bool, limit?:int, stage?:string}` | `{run_id}` — 409 if a run is already active |
| GET | /runs/:id | | `Run` |
| POST | /runs/:id/stop | | `{ok}` |
| GET | /runs/:id/events?after=0 | | `[RunEvent]` |
| GET | /runs/:id/events/stream | SSE | `event: run_event\ndata: RunEvent` ; `event: done` when the run finishes |
| GET | /runs/active | | `Run \| null` |

`Run`: `id, user_id, user_slug, source, trigger, started_at, finished_at, status, stats:{found, deduped,
by_status:{}, chat_replies, invitations, rejections, top_vacancies:[], dry_run}, tg_sent, error`.

## Dedup
| GET | /runs/:id/dedup | | `[{vacancy:{title,company,url}, reason:"SKIP_DEDUP"\|"SKIP_ALREADY_APPLIED"\|"SKIP_EXCLUDED", detail}]` |

## Career sites
| GET | /users/:slug/career-sites | | `[CareerSite]` |
| POST | /users/:slug/career-sites | `{adapter, base_url, config, enabled}` | `CareerSite` |
| PUT | /career-sites/:id | same | `CareerSite` |
| DELETE | /career-sites/:id | | `{ok}` |
| GET | /adapters | | `[string]` registered adapter names |

## System
| GET | /health | | `{ok, version, uptime_s, mem_rss_mb, active_run_id, scheduler_next, users:[{slug, hh_login_ok:bool\|null, cookies_age_h}]}` |
| GET | /settings | | `{[key]:value}` |
| PUT | /settings | `{[key]:value}` | same |

## Errors
`{error: "message"}` with 4xx/5xx.

## Server notes (workstream H, additive)

Everything below adds to the tables above; nothing above changes.

### Field naming
Response objects are the TypeScript DTOs from `packages/shared/src/api.ts` — i.e. the model types with
camelCase fields (`application.userId`, `vacancy.externalId`, `user.dailyLimitHH`, `run.startedAt`).
The snake_case names in the tables above are the conceptual field list; DTO-only fields that the shared
file declares in snake_case (`resume_title`, `user_slug`, `snapshot_url`, `pdf_url`, `last_message`, the
whole `StatsDTO`/`HealthDTO`) are returned exactly as declared there. Request bodies accept **both**
spellings where the docs and the model differ (`tg_chat_id`/`tgChatId`, `base_url`/`baseUrl`, ...).

### Auth details
- `POST /login` also answers `429 {error}` after 5 failed attempts from one IP within 10 min (in-memory;
  IP from `X-Forwarded-For`, else `X-Real-IP`).
- Cookie `sgz_session`: HttpOnly, SameSite=Lax, Path=/, Max-Age 30 days, `Secure` when the request came
  over https (`X-Forwarded-Proto: https`). The signing secret mixes the panel password with a
  per-process random salt, so a server restart logs everyone out.
- Public (no cookie needed): `/login`, `/logout`, `/me`, `/health-lite`. Everything else under `/api` → 401.
- `GET /me` returns `{authenticated: bool, auth_required: bool}`. `auth_required` is false when the server
  runs with an empty panel password (`SGZ_PANEL_PASSWORD` unset): then every route is open, `authenticated`
  is always true, and the panel must skip the login page and hide logout.
- All `/api` responses carry `Cache-Control: no-store`.

### Extra routes / fields
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | /users/:slug | | user |
| GET | /health-lite | | `{ok:true, version}` — unauthenticated liveness probe |
| POST | /users/:slug/career-sites/:id/onboard | | `{run_id}` (202) — queues a `career` run, stage `onboard:<id>` |

- `PUT /users/:slug` additionally accepts `allow_other_country`, `pool_expand_per_day`, `opus_enabled`
  (bool / int ≥ 0). Unknown keys are ignored; wrong types → 400.
- `PUT /users/:slug/profile`: every field optional; strings default `""`, numbers `0`, arrays `[]`,
  `extra` `{}`. Wrong types → 400 `{error:"field: message; ..."}`.
- `GET /users/:slug/stats`: `range` defaults to `all`; other values → 400.
- `GET /users/:slug/applications`: extra query `q` (title/company substring); `status` is a comma-separated
  list of `Status` values (unknown → 400); `page` ≥ 1 (default 1), `page_size` 1..200 (default 50).
  Response is `Paged<ApplicationDTO>`: `{items, total, page, page_size}`.
- `GET /applications/:id` also returns `decision` (the stored LLM decision or null) and `snapshot_url`
  (`/api/applications/:id/snapshot` when `data/snapshots/run-<run_id>/<external_id>*.html` exists, else null).
- `GET /users/:slug/resumes` returns `ResumesDTO`: `{hh, generated, last_synced, capacity}`; `capacity`
  comes from settings key `resume_capacity:<slug>` (JSON `{created, max}`) or is null.
- `POST .../resumes/sync|expand|touch` answer **202** `{run_id}`; run stages are `pool-sync`,
  `pool-expand` (`max` → `limit`), `touch`. 409 when a run is already active.
- `GET /users/:slug/chats?state=` optional filter; each thread also has `last_message`.
- `POST /runs` answers **202** `{run_id}` (docs table says `{run_id}`; status is 202, not 200).
  `user` must exist or be `"all"` (404 otherwise); `source` ∉ hh|career|all|pool → 400.
- `GET /runs?user=all` is the same as omitting `user`. `limit` is capped at 500.
- `GET /runs/:id/events/stream`: replays `store` events after `?after=` **or** the `Last-Event-ID`
  header, then live events. Each frame is `event: run_event`, `id: <event id>`, `data: RunEvent`.
  A comment line `: ping <ts>` is sent every 15 s. When the run finishes (or is already finished) a
  final `event: done` with `data: RunDTO` is sent and the stream closes. `id` on the `done` frame is the
  last event id, so reconnecting with `Last-Event-ID` is idempotent.
- `GET /runs/:id/dedup`: `reason` is one of `SKIP_DEDUP | SKIP_ALREADY_APPLIED | SKIP_FILTER`
  (`SKIP_FILTER` is what the shared `Status` has instead of `SKIP_EXCLUDED`). Max 200 rows.
- Career sites: body keys are `name?, slug?, base_url (or baseUrl), adapter (or ats), config (or profile),
  enabled` — `adapter` is an `ATSKind` (default `custom`), `config` is a `SiteProfile`, `slug` defaults to
  the hostname (`www.acme.io` → `acme-io`). `POST` answers **201**. `GET /adapters` lists the injected
  adapter names, falling back to the `ATSKind` list.
- `GET /health` = `HealthDTO` from shared (`mem_available_mb`, `tools:{chromium,claude,xelatex}` in
  addition to the table above); null when the hook is not wired.
- `/settings`: only `schedule_at` (`"HH:MM"` or `""`), `schedule_jitter_min`, `dedup_window_days`, `tz`
  are readable/writable; values are returned as strings (they live in the `settings` table as text);
  GET falls back to config values (`dedup_window_days` → `"60"`). Other keys → 400.
- Unknown `/api/*` path → 404 `{error:"not found"}`; malformed JSON body → 400.

### Files
`/resumes/:id/pdf|tex` and `/applications/:id/snapshot` stream files from disk only if the resolved
path lies under `cfg.dataDir`; anything else is 404.

### Build (embedded SPA)
The server serves the panel from `packages/server/spa/` (resolved relative to the compiled
`api/static.js`, so it works from `src/` via tsx and from `dist/`). `index.html` there is a placeholder;
the real panel is produced by

```
pnpm --filter @sgz/web build
rm -rf packages/server/spa && cp -R packages/web/dist packages/server/spa
```

Any `GET` outside `/api` that does not match a file falls back to `index.html` (client-side routing);
`/assets/*` (Vite's hashed bundles) get `Cache-Control: public, max-age=31536000, immutable`, everything
else `no-cache`. Paths with an extension that do not exist → JSON 404. If `index.html` is missing the
server answers 503 with a hint. `ApiDeps.spaDir` overrides the directory.
