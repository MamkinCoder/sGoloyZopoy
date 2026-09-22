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
