---
name: sgz-onboarding
description: First-run onboarding interview for the sGoloyZopoy job bot. Asks the new user about their stack, experience, salary, hh.ru setup and consent, writes data/users/<slug>/profile.yaml against the real schema and prints the next commands. Use when the user says "set up sgz", "onboard a new user", "first-time setup", "fill my profile", "new profile", "настрой sgz", "заполнить профиль". For a newcomer who needs the whole guided path (CV, gaps, KB, login, hand-off), use onboard-seeker instead.
---

# sGoloyZopoy onboarding

You interview a new job seeker and produce `data/users/<slug>/profile.yaml`. This file is the ONLY source of facts
the bot may use in letters, questionnaires and employer chats (see root `CLAUDE.md`). Anything missing is answered
as "not used" or left to a human, so completeness matters more than polish.

## Rules

- **Never invent facts.** Every value comes from the user's answers. Unknown -> leave the default (`""`, `[]`, `0`).
- Ask **2-4 questions per message**, RU first (the user base speaks Russian), wait for answers, then continue.
  Skip a block if the user already answered it. Accept "пропустить" and move on.
- Field names are exactly those in `packages/server/src/config/profile.ts` (list below). No other top-level keys.
- Do not copy anything from `data/users/*/profile.yaml` of other users; use them only to see the shape.
- Contacts are stored but never go into letters. Salary figures come only from `salary_from`/`salary_to`.
- Touch only `data/users/<slug>/` (and `data/.env` if the user asks you to fill the Telegram values).

## Schema (all fields, types, defaults)

| field | type | default | used for |
|---|---|---|---|
| `full_name`, `email`, `phone`, `telegram` | string | `""` | forms; never in letter bodies |
| `city` | string | `""` | "где вы живёте?" in questionnaires |
| `citizenship` | string | `""` | questionnaires |
| `relocation` | string | `""` | "готовы к переезду?" |
| `work_formats` | list: `remote` / `office` / `hybrid` | `[]` | format questions |
| `salary_from`, `salary_to` | integer >= 0 | `0` | 0 = never name a figure |
| `currency` | string | `RUR` | `RUR`, `USD`, `EUR`, ... |
| `experience` | string | `""` | must match the hh.ru resume |
| `languages` | list of strings | `[]` | e.g. `"английский - B2"` |
| `directions` | list of strings | `[]` | CV directions: `go-backend`, `node-backend`, `react`, `vue`, `fullstack`, `android`, ... |
| `summary` | string | `""` | 2-3 sentences, dry |
| `verified_skills` | list of strings | `[]` | FULL real stack |
| `never_claim_skills` | list of strings | `[]` | never claimed, even if required |
| `hh_queries` | list of strings | `[]` | hh.ru search phrases |
| `hh_area` | string | `""` | hh.ru area id, `""` = no region filter |
| `exclude_words` | list of strings | `[]` | vacancy titles with these are skipped |
| `company_blacklist` | list of strings | `[]` | never apply there |
| `extra` | map string -> string | `{}` | free facts for questionnaires/chat |

## Interview flow

Before step 1 say in one line: "Займёт 15-20 минут. Лучше держать открытым своё резюме на hh.ru."

**1. Identity / кто вы**
- slug (latin, lowercase, e.g. `ivan`): folder name and `--user` value in all commands.
- ФИО, email, телефон, Telegram. Explain: stored for forms, never inserted into letters.
- Город проживания (questionnaires ask "где вы живёте?"), гражданство.

**2. Format / формат**
- Форматы работы: удалёнка / офис / гибрид (any subset).
- Релокация: готовы ли и куда (free text -> `relocation`).
- Командировки: да/нет/иногда -> `extra["готовность к командировкам"]`.
- Когда готовы выйти -> `extra["когда готов выйти"]`. Образование, если хотят -> `extra["образование"]`.
- Откликаться на вакансии в другой стране (hh shows "вакансия в другой стране")? -> user setting
  `allow_other_country` (panel -> Users; default on). Not a profile field; note it for the final summary.

**3. Salary / зарплата**
- От / до / валюта. Explain: only these numbers are ever named; 0 = the bot never names a figure.

**4. Experience framing / опыт** (a real bug source)
- Ask them to open their hh.ru resume and read the total experience hh shows at the top.
- Ask how they want it framed, e.g. «5 лет в разработке, из них 3 года коммерческой разработки».
  The phrase must not contradict the hh.ru total. If it does, resolve it now (fix the phrase or the resume).
- Языки с уровнем.
- Summary: ask for 2-3 plain sentences about what they build, or draft one from their answers and get approval.

**5. Full real stack / полный стек** (the most important step)
- Say explicitly: «Перечислите ВСЕ технологии, с которыми реально работали: языки, фреймворки, БД, брокеры,
  облака, CI/CD, мониторинг, тесты, инструменты. Обычно это 40-60 пунктов. Резюме на hh.ru несут только
  часть, чтобы не попасть под фильтры за keyword soup, а бот отвечает работодателям по полному списку.
  Всё, чего нет в списке, бот будет отвечать как "не использовал".»
- Help them remember by category (languages, backend frameworks, frontend, SQL/NoSQL, queues, cache, cloud/S3,
  containers/orchestration, CI/CD, observability, testing, payments/integrations, AI/LLM, OS/tools).
  Only add what they confirm. Normalize spelling (`PostgreSQL`, `Node.js`), dedupe.
- `never_claim_skills`: «Есть ли что-то, что часто просят в вакансиях, но вы этим НЕ пользовались?» Can stay `[]`:
  when an employer asks about a skill on neither list, the bot holds the reply and asks in Telegram
  (✅ Есть -> `verified_skills`, ❌ Нет -> `never_claim_skills`), then answers. Needs the Telegram bot token.
  (Kubernetes, Kafka, ClickHouse, ... as prompts only). Nothing may be in both lists.

**6. Where each major technology was used / где применяли**
- For each major item (main languages, DBs, queues, cloud, anything they expect to be asked about), ask:
  company or project + one line. Store in `extra` keyed by the technology, lowercase:
  `extra: { "kafka": "<Компания>: событийный конвейер между биллингом и уведомлениями" }`.
  This keeps "где использовали X?" answers consistent. Skip items they cannot place; do not guess.

**7. Search / поиск на hh.ru**
- Направления (`directions`) - which CV directions they want to apply as.
- Поисковые фразы (`hh_queries`), e.g. "Go разработчик", "Node.js разработчик". Propose from directions, confirm.
- Регион (`hh_area`, `""` = вся выдача); стоп-слова в названиях (`exclude_words`, e.g. Senior, Lead, 1С, PHP);
  компании, куда не откликаться (`company_blacklist`).

**8. hh.ru account, resumes, consent / аккаунт и согласия**
Explain each point and get an explicit "да" for 8.3:
1. At least one **published resume** on hh.ru is required. The bot syncs the resumes, picks one per vacancy,
   tailors text and may create copies per direction (hh.ru limit ~20). Ask: may it create/rewrite resumes
   automatically? No -> user setting `pool_expand_per_day = 0` (panel -> Users; default 2).
2. **Login**: they log in once in a real browser via `pnpm sgz hh-login --user <slug>` (SMS/captcha by hand);
   cookies go to `data/users/<slug>/hh-cookies.json`. Do it from the same country/IP class the bot runs from
   (Russian IP for hh.ru), otherwise hh drops the session.
3. **Chat policy**: in employer chats the bot always moves forward: says yes to calls, formats and test tasks,
   and notifies the human for test tasks and interview times. «Вы согласны, что бот так отвечает от вашего имени?»
   No -> stop and tell them the bot is not a fit as is.
4. **Rejections**: on a rejection the bot sends one polite feedback request (global setting `feedback_request`,
   on by default). Turn off in the panel -> Settings (`feedback_request` = 0).
5. **Limits**: daily `daily_limit_hh` 25 / `daily_limit_career` 10 (panel -> Users); per company max 10 sent per
   30 days and one CV direction per company (`company_limit_max`, `company_limit_window_days`,
   `company_limit_persona_lock`, panel -> Settings); dedup window `dedup_window_days`. Ask if they want other values.

**9. Extras / дополнительно**
- Source CVs (LaTeX `.tex` or markdown) for career-site tailoring: copy into `data/users/<slug>/cv/`
  (e.g. `source-go.tex`). Ask where their files are; copy only if they say so.
- Telegram reports: bot token + chat id -> `TG_BOT_TOKEN`, `TG_CHAT_ID` in `data/.env`
  (template `data.example/.env.example`). Per-user chat id: panel -> Users -> tg chat id.
- Career sites: `data/career-sites.csv` imports all sites **disabled**; enable a few at a time.
- Anything else questionnaires might ask (military status, notice period, etc.) -> `extra`, only if they give it.

## Write and validate

1. Show a short recap (skills count, salary, directions, consents) and ask to confirm.
2. Write `data/users/<slug>/profile.yaml` in the key order of the schema table; quote strings with `:` or `@`.
3. Validate (read-only, uses the server's `yaml` dependency):

```
cd packages/server && F=../../data/users/<slug>/profile.yaml node --input-type=module -e '
import { readFileSync } from "node:fs"; import { parse } from "yaml";
const p = parse(readFileSync(process.env.F, "utf8")) ?? {};
const S = "full_name email phone telegram city citizenship relocation experience summary hh_area currency".split(" ");
const L = "work_formats languages directions verified_skills never_claim_skills hh_queries exclude_words company_blacklist".split(" ");
const N = ["salary_from", "salary_to"]; const known = [...S, ...L, ...N, "extra"]; const err = [];
for (const k of Object.keys(p)) if (!known.includes(k)) err.push("unknown key: " + k);
for (const k of S) if (p[k] != null && typeof p[k] !== "string") err.push(k + " must be a string");
for (const k of L) if (p[k] != null && !(Array.isArray(p[k]) && p[k].every((x) => typeof x === "string"))) err.push(k + " must be a list of strings");
for (const k of N) if (p[k] != null && !(Number.isInteger(p[k]) && p[k] >= 0)) err.push(k + " must be an integer >= 0");
if (p.extra != null && (typeof p.extra !== "object" || Array.isArray(p.extra) || Object.values(p.extra).some((v) => typeof v !== "string"))) err.push("extra must be a map of string -> string");
const lc = (a) => (a ?? []).map((s) => s.toLowerCase());
const both = lc(p.verified_skills).filter((s) => lc(p.never_claim_skills).includes(s));
if (both.length) err.push("in both verified_skills and never_claim_skills: " + both.join(", "));
for (const k of ["full_name", "city", "experience", "summary"]) if (!p[k]) err.push("empty: " + k);
if (!(p.verified_skills ?? []).length) err.push("empty: verified_skills");
if (!(p.directions ?? []).length || !(p.hh_queries ?? []).length) err.push("empty: directions / hh_queries");
console.log(err.length ? err.join("\n") : "profile OK: " + (p.verified_skills ?? []).length + " skills, " + Object.keys(p.extra ?? {}).length + " extra facts");
process.exit(err.length ? 1 : 0);'
```

Fix every error and re-run until `profile OK`. An "empty" error the user chose to skip is acceptable; say so.

## Next commands (print these, with the real slug; do not run the slow ones yourself)

The DB only knows the seeded users (`yaroslav`, `alina`, created when the DB is empty). For any other slug,
import (a new slug gets its user row created automatically):

```
pnpm sgz db import-profile --user <slug>          # profile.yaml -> DB (re-run after every profile edit)
pnpm sgz hh-login --user <slug>                   # real browser, SMS/captcha by hand
pnpm sgz pool sync --user <slug>                  # pull their hh.ru resumes
pnpm sgz run --user <slug> --source hh --dry-run --limit 1
pnpm sgz site import --user <slug> --csv data/career-sites.csv   # optional; all imported disabled
```

On the Pi (per `docs/RUNBOOK.md`; the Pi has its own DB):

```
make sync-data
ssh rpi-ts sgz db import-profile --user <slug>
ssh rpi-ts sudo systemctl restart sgz
ssh -t rpi-ts sgz run --user <slug> --source hh --dry-run --limit 1
```

Finish with the settings the user asked to change (`allow_other_country`, `pool_expand_per_day`, limits,
`feedback_request`) and where to change them (panel -> Users / Settings).
