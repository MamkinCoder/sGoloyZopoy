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
| GET | /users/:slug/analytics?range=today\|7d\|30d\|all | | `AnalyticsDTO` (see below) |
| GET | /users/:slug/lessons | | `{lessons: string[], at}` letter lessons learned from outcomes (`at` = last refresh attempt, `""` = never) |
| DELETE | /users/:slug/lessons | | `{lessons: [], at: now}` clears them; the next rebuild waits a week from `at` |
| GET | /users/:slug/retro | | `RetroDTO` or `null` (weekly retro, see below) |

## Applications
| GET | /users/:slug/applications?status=&source=&since=&until=&page=&page_size= | | `{items:[{application, vacancy, resume_title}], total}` |
| GET | /applications/:id | | `{application, vacancy, resume_title, questionnaire:[{question, answer}]}` |
| GET | /applications/:id/snapshot | | HTML snapshot if any (404 otherwise) |

`application` fields: `id, user_id, vacancy_id, hh_resume_id, generated_resume_id, run_id, status,
reason_detail, cover_letter, llm_decision, created_at`. `vacancy`: `id, source, external_id, url, title,
company, salary_from, salary_to, currency, has_test, requires_letter, area, work_format, published_at`.

## Review queue (career sites)
Career sites never auto-submit. A career run stops after decide → tailored CV → PDF → cover letter and
stores the application as `QUEUED`; a human sends or skips it here. hh.ru stays fully automatic.

| GET | /users/:slug/queue | | `[QueueItem]`, newest first |
| PUT | /applications/:id/cover-letter | `{text}` (1-5000 chars) | `{ok}` — 400 unless `QUEUED` |
| POST | /applications/:id/send | | `{run_id}` 202 — career run, stage `send:<id>`; 409 if a run is active; 400 unless `QUEUED` |
| POST | /applications/:id/inspect | | `{run_id}` 202 — stage `inspect:<id>`: fills the form without submitting, stores the extra questions + bot answers, stays `QUEUED` (`reason_detail` "form checked: …") |
| POST | /applications/:id/retailor | | `{run_id}` 202 — stage `retailor:<id>`: a fresh tailored CV + cover letter for a `QUEUED` item; the new row is `QUEUED`, the old one becomes `SKIP_DEDUP` ("пересобрано") only after the rebuild succeeded |
| POST | /applications/:id/mark-sent | | `{ok}` — the human applied on the site by hand: `QUEUED` → `SENT` ("отправлено вручную"); 400 if not queued, 409 while that item is being sent (same for `skip` and the Telegram «Пропустить») |
| POST | /applications/:id/skip | | `{ok}` — status `SKIP_MANUAL`; 400 unless `QUEUED` |

`QueueItem`: `id, created_at, vacancy:{id, title, company, url, area, work_format, salary_from, salary_to, currency},
site:{name, slug}|null, pdf_url|null, cover_letter, reason` (Claude's decide reason), `detail` (last send/inspect
note), `form:{full_name, email, phone, cv_file_name, cover_letter}` (what the bot fills; the CV is uploaded as
`Фамилия_Имя_CV.pdf`), `questionnaire:[{question, answer}]` (after inspect), `fit_score` (decide's 0-100
match, `null` on rows decided before it existed), `fit_reason` (short overlap, «Go+K8s, вилка ок»).

`send` updates that same row to `SENT` / `FAILED_*`. `daily_limit_career` counts applications queued per day
(`QUEUED` + `SENT` + `SKIP_MANUAL`); a queued or skipped vacancy is never queued again.

## Filtered-out vacancies
| GET | /users/:slug/filtered?source=hh\|habr\|career\|all&days=7&limit=100 | | `[FilteredItem]`, newest first |
| POST | /applications/:id/force | | `{run_id}` 202 — stage `force:<id>`; 409 if a run is active; 400 unless a filter status |

Lists vacancies whose newest application row is `SKIP_FILTER`, `SKIP_LLM_REJECT`, `SKIP_DEDUP`, `SKIP_LIMIT`,
`SKIP_COMPANY_LIMIT` or `SKIP_COMPANY_PERSONA` (dry-run, already-applied, archived, test-required and queued
rows are excluded). `FilteredItem`: `id, created_at, status, reason` (filter detail or LLM reason),
`vacancy:{id, title, company, url, source}, site:{name, slug}|null, fit_score|null, fit_reason`
(same meaning as in `QueueItem`; the panel can sort by fit).

`force` ignores filters, limits and the LLM reject. hh vacancy: an `hh` run fetches it if needed, asks decide
only for the resume + letter (apply forced true) and **sends** through the normal apply path. Career vacancy:
a `career` run tailors the CV, builds the PDF, writes the letter and puts it in the review queue. The new
application row replaces the filtered one as the vacancy's newest, so it drops out of the list.

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
| GET | /users/:slug/chats | | `[{id, hh_negotiation_id, vacancy:{id,title,company,url}|null, employer, state, last_seen_at, unanswered:int, task: ChatTaskDTO|null}]` |
| GET | /chats/:id/messages | | `[ChatMessage]` |
| PUT | /users/:slug/chats/:id/interview | `{interview_at: ISO string|null}` | `ChatThread` |
| PUT | /users/:slug/chats/:id/outcome | `{outcome: next|rejected|silence|offer|null}` | `ChatThread` |
| POST | /users/:slug/chats/:id/study | | `{generating:true}` 202 — builds the interview study pack in the background (one LLM call, no run) |
| GET | /users/:slug/chats/:id/study | | `StudyDTO` `{pack: StudyPack|null, generating, error}` |

## Runs
| GET | /runs?user=slug&limit=50 | | `[Run]` |
| POST | /runs | `{user: slug\|"all", source: "hh"\|"habr"\|"career"\|"all"\|"pool", dry_run?:bool, limit?:int, stage?:string}` | `{run_id}` — 409 if a run is already active (one at a time; runs never answer employer chats, the agent does) |
| GET | /runs/:id | | `Run` |
| POST | /runs/:id/stop | | `{ok}` |
| GET | /runs/:id/events?after=0 | | `[RunEvent]` |
| GET | /runs/:id/events/stream | SSE | `event: run_event\ndata: RunEvent` ; `event: done` when the run finishes |
| GET | /runs/active | | `Run \| null` |

## Always-on agent
| GET | /agent/jobs?state=queued\|running\|done\|failed | | `[AgentJobDTO]` newest first, at most 100; `[]` when the agent is not running (CLI); 400 on another state |

`AgentJobDTO`: `id, kind, key, state, attempts, max_attempts, run_after, last_error, updated_at`.
`ChatTaskDTO` (the thread's latest reply task): `id, state, kind, pending:[topic], topics:[{name, answer: "yes"|"no"|null,
by: "profile"|"human"|"fallback"|null}], draft, last_error, updated_at`. States: `new → triage → awaiting_review →
drafting → ready → sending → sent`, plus `closed` (handled without a reply), `superseded`, `failed`.

`Run`: `id, user_id, user_slug, source, trigger, started_at, finished_at, status, stats:{found, deduped,
by_status:{}, chat_replies, invitations, rejections, top_vacancies:[], dry_run}, tg_sent, error`.

## Dedup
| GET | /runs/:id/dedup | | `[{vacancy:{title,company,url}, reason:"SKIP_DEDUP"\|"SKIP_ALREADY_APPLIED"\|"SKIP_EXCLUDED", detail}]` |

## Career sites
| GET | /users/:slug/career-sites | | `[CareerSite & {yield:{found, queued}, fails}]` (yield = last 30 days: vacancies with an application row / reached QUEUED or SENT; fails = consecutive failed visits) |
| POST | /users/:slug/career-sites | `{adapter, base_url, config, enabled}` | `CareerSite` |
| PUT | /career-sites/:id | same | `CareerSite` |
| DELETE | /career-sites/:id | | `{ok}` |
| GET | /adapters | | `[string]` registered adapter names |

## Knowledge base (docs/ARCHITECTURE.md section 4)
| GET | /users/:slug/kb/tags | | `[KbTag]` by name |
| PUT | /users/:slug/kb/tags/:id | `{status: "yes"\|"no"\|"unknown"}` | `KbTag`; profile skills re-synced; 404 for another user's tag |
| GET | /users/:slug/kb/stories?tag=<tag id> | | `[KbStory]` newest first; without `tag` all stories |
| POST | /users/:slug/kb/stories | `{did, title?, company?, period?, context?, result?, tags?: string[]}` | `KbStory` 201: `source: "panel"`, `confirmed: true`; empty title = first sentence of `did` |
| PUT | /users/:slug/kb/stories/:id | any of the POST fields + `confirmed?` | `KbStory`; `tags` replaces the links, `source`/`hash` are kept |
| POST | /users/:slug/kb/stories/:id/confirm | | `KbStory` with `confirmed: true` |
| DELETE | /users/:slug/kb/stories/:id | | `{ok}`; 404 for another user's story |

`KbTag`: `id, userId, name, aliases[], category, status, updatedAt, storyCount`. `KbStory`: `id, userId, title, company,
period, context, did, result, source: seed|telegram|panel, confirmed, hash, createdAt, updatedAt, tags:[{id, name}]`
(camelCase: the shared model as is). Tag names in `tags` match existing tags by name or alias (case-insensitive);
a missing tag is created, and a tag that is new or `unknown` becomes `yes` (a human wrote a story about it; an
explicit `no` stays). Every status change is mirrored into `profile.verified_skills` / `never_claim_skills`
(`kb/write.ts` `syncProfileSkills`).

What these endpoints change also changes generated material (phase 4): hh/Habr letters and tailored resume copies,
career letters and LaTeX CVs, questionnaire answers, interview prep and study packs, and the `sgz habr-resume`
proposal read the stories relevant to the vacancy on their next generation; a tag set to `no` disappears from them
and is stripped from their output. Nothing already sent or queued is regenerated.

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
| POST | /users/:slug/career-sites/:id/run | | `{run_id}` (202) — queues a `career` run, stage `site:<id>`: gather → decide → tailored CV → review queue for this one site |

- `PUT /users/:slug` additionally accepts `allow_other_country`, `pool_expand_per_day`, `opus_enabled`
  (bool / int ≥ 0). Unknown keys are ignored; wrong types → 400.
- `PUT /users/:slug/profile`: every field optional; strings default `""`, numbers `0`, arrays `[]`,
  `extra` `{}`. Wrong types → 400 `{error:"field: message; ..."}`.
- `GET /users/:slug/stats`: `range` defaults to `all`; other values → 400. `chat_replies` counts only
  messages the bot sent (`direction='out'` and no `hh_message_id`); history imported from hh is excluded.
- `GET /users/:slug/retro`: the last 7 days vs the 7 before (`RetroDTO` in `packages/shared/src/api.ts`),
  built from `userAnalytics` (week before = 14-day sums minus this week), no LLM. `null` when this week
  has fewer than 10 sends; `prev` is `null` when the week before had fewer than 10. `best` = direction
  with the highest invite (then response) rate over 14 days with at least 5 hh sends; `mismatch` = direction
  with 8+ hh sends and zero responses over 14 days; `stale_queue` = QUEUED items older than 3 days;
  `interviews` = threads with `interview_at` from 7 days ago to 7 days ahead.
- `GET /users/:slug/analytics`: same `range` rules. One payload for the dashboard (`AnalyticsDTO` in
  `packages/shared/src/api.ts`): `since`, `kpi:{sent, skipped, failed, negotiations, responded,
  response_rate (responded/sent or null), invitations, rejections, employer_messages, bot_replies,
  needs_human_open, resumes_total, resumes_generated, llm_calls, llm_failed, llm_prompt_chars,
  llm_result_chars, llm_avg_ms, runs}`, `daily:[{day, sent, skipped, failed, msgs_in, bot_out, llm_calls}]`
  (UTC days, gap-filled up to today), `funnel:[{key:found|decided|approved|sent|viewed|invited|passed|offer, n}]`
  (`passed` = threads whose interview outcome is next or offer, `offer` = offer),
  top-N `{key, n}` lists `skip_reasons, companies, sources, resumes, directions, reject_reasons,
  work_formats, areas, llm_tasks` (breakdowns other than skip/reject/llm are over SENT applications;
  `companies, sources, resumes, directions` rows also carry `hh` (of `n`, sent through hh), `resp`
  (hh thread viewed / invited / rejected, same as the funnel) `inv` (invited) and `pass` (interview outcome next/offer): rates are `resp/hh`,
  `inv/hh`, career-site sends have no threads so `hh = 0` means no data),
  `recent:[{at, kind:sent|employer|bot, title, detail}]` (last 20) and `salary` (`{n, p25, p50, p75}` in RUB
  or null): percentiles of the fork midpoint (or the single bound) over RUR/RUB vacancies this user has an
  application row for, seen in the last 90 days, points under 10k dropped; null below 15 postings. Thread counts use
  `last_seen_at` in range; `needs_human_open` and resume counts are current totals; LLM calls are tied to
  the user through `runs.user_id`.
- `GET /users/:slug/applications`: extra query `q` (title/company substring); `status` is a comma-separated
  list of `Status` values (unknown → 400); `page` ≥ 1 (default 1), `page_size` 1..200 (default 50).
  Response is `Paged<ApplicationDTO>`: `{items, total, page, page_size}`.
- `GET /applications/:id` also returns `decision` (the stored LLM decision or null) and `snapshot_url`
  (`/api/applications/:id/snapshot` when `data/snapshots/run-<run_id>/<external_id>*.html` exists, else null).
- `GET /users/:slug/resumes` returns `ResumesDTO`: `{hh, generated, last_synced, capacity}`; `capacity`
  comes from settings key `resume_capacity:<slug>` (JSON `{created, max}`) or is null.
- `POST .../resumes/sync|expand|touch` answer **202** `{run_id}`; run stages are `pool-sync`,
  `pool-expand` (`max` → `limit`), `touch`. 409 when a run is already active.
- `GET /users/:slug/chats?state=` optional filter; each thread also has `last_message`, `interviewAt`
  (UTC ISO or null: captured by the chat bot from `answer_chat.interview_at`, or set by hand) and `prep`
  (`{questions, stories:[{skill,prompt}], gaps, ask_them}` or null: the interview brief generated on an invitation
  and also sent to Telegram). The list carries `has_study` (a study pack is stored) instead of the pack itself.
- Interview study pack (`runner/study.ts`), only on demand, never automatic: `POST /users/:slug/chats/:id/study`
  (400 when the thread has no vacancy, 404 when it is not this user's, 503 when the server has no LLM client)
  starts one `write` call (`prompts/interview_study.md`: vacancy, profile, the thread's `prep`) and answers 202; a
  second POST while it runs joins the same build. `GET` is polled: `{pack, generating, error}` (`error`: last
  failure, `""` if none). `StudyPack` = `{checklist:[{topic, why, level: must|likely|nice, gap, study}], prompt,
  at, vacancyTitle, company}`, stored in `chat_threads.study_json`. The checklist (10-20 topics, at most 20 kept)
  is guarded: one line per field, fields with links dropped, a topic from `never_claim_skills` is always a gap,
  sorted must → likely → nice. `prompt` is built in code, not by the LLM: a Russian ChatGPT tutor prompt
  (position, vacancy text ≤3000 chars, experience + real stack, the numbered checklist with gaps marked
  «(пробел - нужно подтянуть)», how to tutor), ≤12 000 chars, with e-mails, phones, Telegram handles and links
  removed. The panel's Chats thread view shows it with checkboxes (kept in `localStorage` per thread), gaps
  highlighted, «Скопировать промпт» and «Пересобрать».
- `PUT /users/:slug/chats/:id/interview`: any `Date`-parseable string, stored as UTC ISO; `null` clears it; 400 on
  an unparseable date, 404 when the thread is not this user's. A changed time re-arms the reminder: `sgz serve`
  checks every minute and sends one Telegram ping ~2h before the interview. A changed time also re-arms
  the outcome question below.
- `PUT /users/:slug/chats/:id/outcome`: `null` clears; 400 on another value, 404 when the thread is not this
  user's. `sgz serve` also asks once per interview time, 20h-3d after it, «Как прошло собеседование в
  <employer>?» in Telegram with buttons прошёл дальше / отказ / тишина / оффер (callback `io:<thread>:<outcome>`),
  skipped for threads already rejected or with an outcome. The interview brief sent to Telegram ends with a
  market line (salary band over postings this user's CV direction was matched to, same rules as
  `analytics.salary`) when there is enough data; the band is for the seeker only and never reaches employers.
- `POST /runs` answers **202** `{run_id}` (docs table says `{run_id}`; status is 202, not 200).
  `user` must exist or be `"all"` (404 otherwise); `source` ∉ hh|habr|career|all|pool → 400. `habr` = Habr Career auto-apply (stages search / decide /
  apply / `force:<id>`); `all` = hh, then habr (no stage: career sites are left to the autopilot's
  `rotate` chunks; `source: career` still runs them). Runs never answer employers: stage `chats` is gone
  (the run fails with "nothing to do"); employer chats belong to the always-on agent (below).
  Vacancies from it have `source: "habr"`; `?source=career` means career sites only (not hh, not habr).
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
- `/settings`: an allowlist, values are strings (the `settings` table is text); GET falls back to defaults.
  Other keys → 400.
  - Schedule: `schedule_at` (`"HH:MM"` or `""`), `schedule_jitter_min`, `tz`, `dedup_window_days`.
  - Company limiter: `company_limit_max`, `company_limit_window_days`, `company_limit_persona_lock`.
  - Chats: `feedback_request` (`"0"` = no feedback request after a rejection), `chat_track_since` (`YYYY-MM-DD`),
    `chat_followup_days` (default `"7"`, `"0"` = off): one fixed polite follow-up in a new/viewed chat after that
    many days of employer silence, at most 3 chats checked per `chats.sync`.
  - Habr Career: `habr_daily_limit` (default `"20"`) applications per day. Internal: `habr_alert_day:<user id>`
    (a Habr fatal error inside `all` is alerted once a day).
  - Resume viewers: `viewers_enabled` (default `"1"`, `"0"` = off). Every hh run with the apply stage first reads
    «Кто смотрел резюме» (`/applicant/resumes/views?resume=<hash>`) for each pool resume, at most every 6h. A new
    viewer the seeker never applied to gets one employer-only search (`employer_id`, IT roles, 30 days); its vacancies
    go through the usual filters, decide and apply (company limiter, daily budget), at most 3 sends per run, before
    cold search. One Telegram alert «Кто смотрел резюме» lists the outcome per employer. Internal keys:
    `viewers_checked_at:<user id>`, `viewer_seen:<user id>:<company key>`.
  - Always-on agent (`sgz serve`, `src/agent`, docs/ARCHITECTURE.md §2-3): a persistent job queue (table `jobs`)
    worked by one loop next to the runner; the two never wait for each other. The runner is one run at a time again
    (scheduled run, panel / CLI runs, queued sends, touch, career chunks); `RunBusyError` / 409 when busy.
    - Queue: `enqueue(kind, payload, {key, runAfter, priority})`; at most one open (queued/running) job per key, a
      second enqueue only pulls `run_after` earlier. Resources: one `browser` job at a time (the agent's own Chrome,
      `data/users/<slug>/chrome-profile-chat`, logged in with the saved `hh-cookies.json` / `habr-cookies.json`,
      opened lazily, closed after `AGENT_BROWSER_IDLE_MS`, default 3 min, without browser jobs), `llm` jobs up to
      `SGZ_CLAUDE_PARALLEL`, `none` freely. A throw retries after 30 s, 1, 2, 4 min … (cap 30 min); after
      `max_attempts` (5) the job is `failed` and Telegram gets one «Агент: задача <kind> не выполнена» per kind
      until a job of that kind succeeds (open state `alert_open:job:<kind>`). A job running past its lease
      (default 10 min, sync 20) counts as a failed attempt. Boot requeues every job a dead process left `running`.
      Finished jobs are pruned after 7 days. Logs go to stderr (`[agent] …`), not to run events.
    - Chat jobs: `chats.sync` (browser, every `SGZ_CHAT_POLL_MIN` min, default 5, `0` = off; hh then Habr for every
      active user) reads the chats, stores messages and keeps the old side effects (invitation alert + `chats.prep`
      brief, rejection feedback request, forwarding feedback after a rejection, hh bot surveys, follow-ups), then
      opens a reply task (`chat_tasks`) for every thread with unanswered employer messages. `chats.triage` (llm,
      `prompts/triage_chat.md`, tier fast) → `kind` + `topics` (skills asked about); `ack_only` / `rejection` close
      the task without a reply. `chats.review` (none): the knowledge-base review gate (below); topics it resolves
      without the human are filled in, the rest go into ONE Telegram card per task. `chats.draft` (llm,
      `answer_chat` with the task's answers: yes = verified, no = never claim, plus a KB block = `kbFor` over the
      task topics + vacancy + the employer's messages, statuses as this task answered them, the best stories within
      3000 chars) → `ready`, or back to review when the draft finds a skill triage missed; `needs_human` /
      interview time as before. `chats.send` (browser) re-reads the thread:
      the reply already there → only marked sent (no double reply); a new employer message → the task is
      `superseded` and a fresh task covers all unanswered messages (answers carried over); else send, re-read to
      confirm, mark the messages handled, and `chats.sync` again 30 s later. A task whose job failed stays
      `failed` until the employer writes again.
    - KB review card (`agent/chats/review.ts`, setting `kb_review_mode`: `always` (default) = every topic |
      `new_only` = only topics without stories (a tag already `no` is not asked either) | `off` = no card, a `yes`
      tag counts as yes, anything else as not claimed). Every topic resolves to a KB tag by name or alias; a topic
      the KB does not know becomes a tag (`yes`/`no` when the profile lists it, else `unknown`). One `kb_reviews` row
      per shown topic (`pending` → `confirmed` | `expanded` | `denied` | `expired`, `tg_message_id` of the card).
      The card: «<employer> спрашивает: «…»», then per topic its stories (title, company, short did / result, at
      most 3, fewer when the card would pass ~3900 chars; HTML-escaped) and a button row «Подтвердить X» (only with
      stories or a `yes` tag) «Дополнить X» «Нет навыка X» (callback `kr:<review id>:c|e|d`). A tap edits the same
      card to show each topic's resolution; the task drafts once every topic is resolved.
      - «Подтвердить»: tag `yes`, the shown stories `confirmed`, review `confirmed`.
      - «Нет навыка»: tag `no` (mirrored into `never_claim_skills`), review `denied`.
      - «Дополнить»: the bot writes «Напиши, что ты делал с X: где, что именно, какой результат.» in the tapped chat
        and marks the review as waiting for text there (`kb_reviews.awaiting_chat`, in the DB). The next plain
        message in that chat is the story (before `/mock` answers): job `kb.ingest` (llm, `kb_ingest`) →
        stories `source: telegram, confirmed`, tag `yes`, review `expanded`, the card edited. Several «Дополнить»
        are asked one at a time, oldest first. A text the model cannot turn into a story: the bot says so, tap
        «Дополнить» again.
      Human answers also update `skills_learned:<user>` so older code paths agree with the KB. A tap (or a story)
      for a superseded task goes to the thread's open task waiting for the same tag. `chats.remind` resends the
      card once after 2 h; `chats.fallback` after 12 h expires the open reviews and drafts anyway with the
      unanswered topics treated as «нет» for that reply only (honest «в продакшене не использовал»; tag status
      unchanged), plus an alert «Отвечаю без тебя». Phase-1 cards still work: `ct:<task id>:<topic index>:y|n`
      (y = confirm, n = no skill) and one-skill cards `sk:y|n:<user>:<key>` (settings `skill_pending:*`).
    - Stall alert: if no `chats.sync` job finished `done` for 20 min, one Telegram alert «Чаты не проверялись N мин»,
      and one «✅ Чаты снова проверяются» when they resume (open state in setting `alert_open:chats`).
  - Career autopilot (`sgz serve`): when the main lane is idle it runs `career` stage `rotate` chunks.
    - `career_autopilot`: `"0"` turns the chunks off.
    - `career_sites_per_run`: sites per chunk, default 1 (short batch runs); each chunk takes the
      highest-scoring sites not yet visited today: never-visited first, then any site unvisited for 7+ days,
      else `queued*3 + min(found,10)*0.2 + days since last visit - 5*fails` (30-day yield, see
      `GET /users/:slug/career-sites`). A site with 5+ consecutive failed visits waits a week.
    - `site_fail:<site id>` (internal, written by the runner): consecutive onboarding/discovery failures, reset on a clean visit.
    - `career_per_site`: max vacancies queued per site per run, default 3; `career_per_aggregator`: same for job boards (Habr Career), default 8.
    - Every ~4h it also runs hh stage `touch` (raise resumes in search).
  - Telegram (`sgz serve` with a bot token):
    - `queue_tg_cards`: `"1"` (default) sends a card per new review-queue item with «Отправить» (starts
      career stage `send:<id>`; if a run is active the id is parked in setting `queue_send_pending` and
      started on the next idle minute) and «Пропустить» (`SKIP_MANUAL`, "skipped in telegram"). The card
      links to `/u/<slug>/queue#app-<id>`, which the panel scrolls to. `"0"` = no cards.
    - `digest_at`: `"HH:MM"` (default `"20:00"`, `""` = off) in `tz`: once a day, «Итоги дня» per active
      user: today's sent / queued / skipped / errors, chat replies / invitations / rejections, the review
      queue with items older than 5 days, chats in `needs_human`. Last sent day: setting `digest_last_day`.
    - Bot commands, answered only in `TG_CHAT_ID` or a user's `tgChatId`:
      - `/status`: runner state + the digest. `/queue`: queued items, oldest first. `/week`: the weekly retro now.
      - `/company <name>`: per active user, sends, replies / invites, rejections, median time to the first
        employer message for that company key.
      - `/salary <слово>`: salary band over vacancies whose title contains the word (same rules as `analytics.salary`).
      - `/study [компания]`: study pack for the most recent `invited` / `needs_human` thread with a vacancy
        (optionally matching the employer or vacancy company; a user's own `tgChatId` sees only their threads).
      - `/mock [employer]`, `/stop`: text mock interview (below).
      - The referral radar is gone: its Telegram command and profile field were removed; an old profile
        that still has the field parses fine, the key is ignored.
    - Study pack in Telegram: the invitation alert (when the thread has a vacancy) and the prep brief carry
      a «📚 Чеклист к собеседованию» button, callback `st:<thread id>`. The tap is answered at once («готовлю
      чеклист…») and the pack is built in the background through `app.llm` (the global `claude` mutex
      serializes it with runs). Then two messages: the checklist (Обязательно / Скорее всего / Плюсом, gaps
      marked 📌, one line per topic) with «🔄 Пересобрать» (`st:<thread id>:r`), and the prompt in `<pre>`
      (tap to copy; HTML-escaped, split into ≤4096-char parts). A pack younger than 7 days is resent without an
      LLM call unless the tap is «Пересобрать». Messages go to `TG_CHAT_ID`, like the other alerts.
      - Anything else starting with `/` gets the help line.
  - Outcome learning (`runner/learn.ts`, advisory only, never a reason to reject):
    - decide (hh and career) gets `company_history` for batch employers with 3+ SENT applications,
      `resume_stats` for pool resumes with 10+ SENT hh applications in 30 days (tie-breaker within one
      direction), and the letter lessons below.
    - `letter_lessons:<user id>` (internal, JSON `{lessons, at}`): checked hourly by the serve tick, rebuilt
      at most weekly with one `fast` call (`prompts/learn_letters.md`) once there are 5+ invited and 15+
      not invited hh letters (rejected, or no invite 14 days after SENT). Lessons are style-only: sentences
      with links or unverified / never-claim tech are dropped. They feed `_letter_craft.md`, so both the
      decide letter and `cover_letter_career` see them. Read / reset in Settings → Профиль → «Уроки писем».
    - Queue cards carry a vitals line (salary · format · `fit N (reason)`).
    - `retro_day` (`"sun"` default, `"mon"`…`"sat"`, `""` = off) + `retro_at` (`"19:00"`): once a week,
      «Итоги недели» per active user (the `GET /users/:slug/retro` numbers as text); a user with fewer than 10
      sends that week gets nothing. Last sent day: setting `retro_last_day`. `/week` answers it on demand.
    - `kb_review_mode`: `"always"` (default) | `"new_only"` | `"off"`: which chat topics go on the KB review card
      (see the always-on agent above).
    - `/mock [employer]`: text mock interview from the most recent thread with a prep brief (`prep_json`)
      or a study pack (optionally matching the employer; a user's own `tgChatId` sees only their threads). Up
      to 5 questions, the study pack's gap topics first, then the prep questions; each plain message is an answer, graded by one LLM call (`prompts/mock_feedback.md`, tier
      `write`) that may add one follow-up (max 2 per session); after the last one a summary call
      (`prompts/mock_summary.md`) lists 3 things to tighten. `/stop` ends it. State: setting
      `mock:<chatId>` (JSON, `""` = none), expires after 2 h of silence. Prompts use only the profile's real
      experience; nothing goes to employers.
  - Reliability: `run_max_min` = watchdog limit per run in minutes, `"0"` (default) = built-in caps
    (20 for `touch`, 45 for `rotate`, 30 for `send:|inspect:|retailor:|force:`, 150 otherwise; a `rotate`
    chunk stops tailoring new items after 30 min so an aggregator's batch ends cleanly). On
    timeout the run is aborted, the browser closed and a Telegram alert sent; the run ends with
    `error: "watchdog: exceeded N min"`. If a wedged call ignores the abort, the lane frees itself
    after 60 s more (run `failed`); the watchdog covers the report too, and closing a wedged browser is
    bounded (then its processes are killed), so nothing after it can hold the runner.
  - Daily run (`source=all`): an hh failure no longer skips Habr; Habr runs, then the hh error ends the
    run as before. A slot that finds the runner busy is retried every minute ("owed"): settings saves keep
    it, the autopilot starts no new chunk meanwhile, and it fires at most once per day. Autopilot
    (`rotate`/`touch`) failures alert once per 6 h per error.
- `sgz serve` boot closes runs left `running`/`queued` by a crash (`status: stopped`,
  `error: "orphaned by restart"`). While the runner is enabled it also checks every 30 min that some
  run finished `done` in the last 26 h (dead-man heartbeat): one Telegram alert when that breaks, one
  more when it recovers (open state in setting `alert_open:heartbeat`).
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
