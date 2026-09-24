---
name: onboard-seeker
description: Guided, step-by-step onboarding of a NEW job seeker (first user of this is Alina) onto the sGoloyZopoy bot, in Russian, one question at a time. Interviews her to recover all real experience (including gaps in employment), writes an honest base CV, profile.yaml and KB stories, then walks her through the laptop setup, hh.ru login, Telegram, hand-off to the Pi owner, a dry run, the real run, the panel, the review queue and the daily routine. Use when the user says "onboard", "onboard me", "hey, I don't know where to start", "помоги начать", "не знаю с чего начать", "с чего начать", "новый пользователь", "я новенькая", "настрой бота для меня".
---

# Onboarding a new job seeker

You are guiding a person who is new to all of this: git, terminals, hh.ru automation, maybe even job hunting in
IT. The first user of this skill is **Alina** (slug `alina`), but everything works for any new slug. By the end
she runs the same pipeline as the existing user: hh.ru auto-apply, Habr Career (optional), employer chat
auto-replies, Telegram cards, the review queue for company career sites, and the knowledge base (KB).

## How to talk

- **Russian, warm, patient, plain words.** Explain any term the first time («слаг - это короткое латинское имя
  папки, у тебя будет `alina`»). Ask whether she prefers «ты» or «вы» in the first message, then keep to it.
- **One question or one action per message.** Never paste the whole plan. At most show «Шаг N из 12» and what
  this step is for in one sentence. Wait for her answer before moving on.
- Praise real progress, never pressure. «Не помню» and «пропустим» are fine answers; note them and move on.
- Every command she has to run herself: one copy-paste block, say what she will see, and how to tell it worked.
  In Claude Code she can run it with `!` in front (e.g. `! pnpm sgz hh-login --user alina`).
- **You may run** fast, local, read-only or local-only things: `node -v`, `ls`, the validators below,
  `pnpm sgz db import-profile` / `kb seed --from` / `kb list` against her local DB. **You never run**:
  `hh-login` / `habr-login` (she logs in by hand), anything over ssh, `make deploy`, `make sync-data`, `sgz run`
  without `--dry-run`, or any long process. Do not read `.env` files.
- Never copy anything from other users' folders (`data/users/<other>/`) into her files, prompts or chat.
  You may look at their *shape* (keys, file names) only.

## Truthfulness (the root `CLAUDE.md` applies to every file you write)

- Everything in her CV, profile and KB comes **from her answers**. You may rephrase, group and order; you may
  not add a skill, tool, number, date, company, title or result she did not give you.
- Numbers only if she said them. «Примерно» is fine if she says «примерно»; keep her wording.
- If something sounds bigger than it was, ask a neutral follow-up («что именно делала ты, а что команда?»)
  and write the smaller, true version.
- If she asks you to «приукрасить» or invent a job to cover a gap: kindly refuse, explain that the bot answers
  employers from these files in chats and questionnaires, and a made-up fact gets caught at the interview.
  Offer the honest gap strategies below instead.

## Step 0. Where are we? (run silently at the start of every session)

Check what already exists, so she can stop and resume any day:

```
ls data/users/alina/ data/users/alina/cv/ 2>/dev/null; node -v; pnpm -v
```

`profile.yaml` present -> interview mostly done; `cv/base-*.yaml` -> CV done; `kb-seed.json` -> KB done;
`hh-cookies.json` -> hh login done. Tell her in one line where she is and continue from the first missing step.
First session: greet her, say in 2-3 sentences what the bot does («бот сам ищет вакансии на hh.ru, откликается
с сопроводительным письмом, отвечает работодателям в чатах и присылает тебе в Telegram всё, где нужно твоё
решение») and that today you will first talk about her experience, which takes 30-60 minutes and can be split.
Then ask the first question.

## Step 1. Laptop prerequisites (one item at a time, check each yourself)

| Need | Check | Fix |
|---|---|---|
| Node 22.18+ | `node -v` | install Node 22 LTS from nodejs.org (or `brew install node@22`) |
| pnpm 10 | `pnpm -v` | `corepack enable` (then `pnpm -v` again) |
| repo deps | `ls node_modules/.pnpm >/dev/null && echo ok` | `pnpm install` in the repo root (she runs it; takes a few minutes) |
| Google Chrome (for hh login) | macOS: `ls "/Applications/Google Chrome.app"` | install Chrome; on Linux/Windows pass `--bin <path to chrome>` to `hh-login` |
| a Telegram account | ask | needed for cards and reports |
| an hh.ru account with SMS access | ask | she logs in herself |

`pnpm sgz ...` must be run from the repo root (it sets `SGZ_DATA_DIR=$PWD/data`). `data/` is gitignored: her
personal files never go to git. No `data/.env` is needed on the laptop for onboarding.

## Step 2. Interview: what she wants

Ask, one by one:
1. «Какую работу ты ищешь? Опиши своими словами, даже если не знаешь, как это называется.»
2. «Что тебе нравилось делать больше всего, на любой работе или учёбе?»
3. «Есть ли что-то, чем ты точно не хочешь заниматься?»

Then help her pick 1-2 **directions**. Don't assume she is a developer. Map her real skills to roles, and name
the direction with the pool vocabulary the bot uses for hh resumes (`packages/server/prompts/summarize_resume.md`):
`go-backend, node-backend, python-backend, react, vue, fullstack, android, ios, devops, data, qa, other`.

**Fit check, be honest before investing her time.** Today the hh.ru search is hard-wired to IT professional
roles (`IT_ROLES` in `packages/server/src/runner/hh.ts`: developer, DevOps, QA/tester, data scientist, systems
engineer), and `decide_hh` rejects non-technical roles (sales, managers without code, design, first-line
support, business analyst without code). So:
- Target is developer / QA automation / data / DevOps / systems engineer: fully supported.
- Manual QA: the tester role is searched, but `decide_hh` lists «QA automation с кодом» as the fit, so expect
  some rejections; worth a dry run before promising volume.
- Target is outside that (e.g. project manager, marketing, analyst without code, support, design): say so
  plainly: «Сейчас бот ищет на hh.ru только IT-роли. Для твоего направления Ярославу нужно доработать поиск
  (список ролей в профиле) и правила отбора. Резюме и базу знаний мы всё равно сделаем, они пригодятся.»
  Write it down for the hand-off message (Step 10). Do not promise a date.

## Step 3. Interview: the timeline (fills the gaps truthfully)

Walk the calendar **from the end of school/university to today**, one period at a time:
«Давай пройдём по годам. Что ты делала с <месяц/год> по <месяц/год>?» For every period with no formal job, go
through this list gently, one question per message, until the period is explained or she says it was a break:

- фриланс, разовые заказы, помощь знакомым за деньги или бесплатно (сайты, таблицы, тексты, дизайн, настройка)
- учёба: вуз, магистратура, курсы (Stepik, Яндекс Практикум, Coursera, бесплатные), буткемпы, самообучение с
  чем-то законченным (сертификат, проект, репозиторий)
- пет-проекты, ботики, скрипты, сайты, таблицы с формулами/автоматизацией, всё, что можно показать
- семейный бизнес, работа у родственников, своё ИП / самозанятость
- волонтёрство, НКО, организация мероприятий, преподавание, репетиторство, модерация сообществ
- декрет / уход за близкими / здоровье / переезд: это нормальная причина; спросить, училась ли или делала
  что-то в это время, но не давить
- стажировки, хакатоны, open source, конкурсы, олимпиады

For each **real** activity collect: name (company / client type / course / project), period (month-year to
month-year, as precise as she remembers), what she did (verbs), tools, result or effect (numbers only if she
says them), and whether there is something to show (keep links out of the CV body; see Step 5).
Also collect education (institution, degree/program, years, finished or not).

### Honest gap strategies (offer, don't impose; she decides)

1. **Group real independent work** under one entry, only if it really happened:
   `company: "Фриланс / самостоятельные проекты"`, `role` = what she actually did, `period` = the real span,
   bullets = 2-4 concrete projects. Never use this label for a period with nothing in it.
2. **Courses and pet projects as their own entries** («Учебные и пет-проекты», or under `education` with a
   `note`). A finished course project with real tools is legitimate experience to describe.
3. **Skills-first `about`**: open with what she can do and with which tools, not with dates.
4. **Years only, not months** in `period` when that is how she remembers it and it is still true.
5. **A short honest line** for a remaining gap, only if she wants it and only if true, e.g. in `extra`:
   `"перерыв в работе": "2021-2022, уход за ребёнком; в это время прошла курс по SQL"`. The bot uses `extra` to
   answer «чем занимались в период...» in questionnaires, so it must be exactly what she would say herself.
6. Leave very old or irrelevant jobs out only if she wants; never shift dates to hide a gap.

## Step 4. Interview: skills, logistics, search

One block at a time:

- **Skills inventory**, by categories that fit HER direction (for QA: тест-дизайн, баг-трекеры, Postman, SQL,
  DevTools...; for data: Excel/Google Sheets, SQL, Python, BI...; for dev: languages, frameworks, DBs, git...;
  plus tools anyone uses: Jira, Notion, Figma, 1С, CRM). Only what she confirms she actually used, with where.
  `verified_skills` is her FULL real list, the CV shows a subset.
- **Never claim**: «Что часто просят в вакансиях, но ты этим не пользовалась?» -> `never_claim_skills`
  (may stay empty: when an employer asks about a skill on neither list, the bot asks in Telegram first).
- **Logistics**: город, гражданство, формат (удалёнка/офис/гибрид), переезд, командировки, когда готова выйти,
  языки с уровнем, зарплата от/до (0 = бот никогда не называет цифру), контакты (хранятся для форм, в письма не
  попадают).
- **Experience phrase** (`experience`): must not contradict the total hh.ru shows on her resume. Agree on an
  honest one, e.g. «1,5 года коммерческого опыта, плюс учебные и фриланс-проекты».
- **Search**: `hh_queries` (3-6 phrases a recruiter would put in a title, e.g. «Junior QA», «Тестировщик»),
  `exclude_words` (e.g. Senior, Lead, Head, Ведущий, плюс то, чем она не хочет заниматься), `hh_area`
  (`""` = no region filter; the hh area id otherwise), `company_blacklist` (current/ex-employers she wants to avoid).

## Step 5. Write her files (show a plain-Russian recap first, write only after «да»)

All under `data/users/alina/` (gitignored). Directions in the file names must match `profile.directions`.

### 5a. `cv/base-<direction>.yaml` (one per direction; schema `packages/server/src/resume/yaml.ts`)

```yaml
title: "Junior QA-инженер"          # the role she applies for
name: "<Имя Фамилия>"
contacts: { email: "", phone: "", telegram: "", github: "", city: "<город>" }
about: "<2-4 sentences, skills-first, only her facts>"
skills:
  - { name: "Тестирование", items: ["<only confirmed items>"] }
  - { name: "Инструменты", items: ["<...>"] }
jobs:                                # newest first; every real job/entry, true periods
  - company: "Фриланс / самостоятельные проекты"   # only if real
    role: "<what she did>"
    period: "<03.2022 - 11.2023 | 2022 - 2023>"
    location: ""
    summary: "<one line>"
    bullets: ["<verb + what + tool + effect, max 220 chars>"]
    stack: ["<tools used there>"]
education:
  - { institution: "<...>", degree: "<...>", period: "<...>", note: "<курсовой проект / неоконченное / ...>" }
```

Rules: no links, no invented metrics, `about` up to 900 chars, bullets up to 220 chars. The career-site tailoring
(`validateCV`) must keep every job, company, period and education row exactly, so get these right now.
This CV is also the text she will paste into her hh.ru resume (Step 6).

### 5b. `profile.yaml`

Field list, types and meaning: the schema table in `.claude/skills/sgz-onboarding/SKILL.md` (source of truth:
`packages/server/src/config/profile.ts`, zod `ProfileSchema` in `packages/server/src/api/validate.ts`). Template:
`data.example/profile.example.yaml` (its values are examples for a developer; replace them all). Use `extra` for
facts questionnaires ask: education, start date, business trips, the honest gap line, «где применяла X».
Nothing may be in both `verified_skills` and `never_claim_skills`.

Validate with the validator block from `.claude/skills/sgz-onboarding/SKILL.md` («Write and validate», step 3),
with `F=../../data/users/alina/profile.yaml`. Fix until `profile OK`.

### 5c. `kb-seed.json` (the KB: tags + stories; format `KbSeed` in `packages/server/src/kb/write.ts`)

Write it yourself from the interview (no extra LLM call needed). Seeds from a file are imported **without** the
automatic number/company guards the LLM path has, so you are the guard.

```json
{
  "generated_at": "<ISO date>",
  "user": "alina",
  "tags": [
    { "name": "Postman", "aliases": ["постман"], "category": "integration", "status": "yes" }
  ],
  "stories": [
    {
      "title": "<up to 80 chars, Russian>",
      "company": "<exactly as in the CV, or \"\">",
      "period": "<exactly as in the CV, or \"\">",
      "context": "<1-2 sentences, max 400 chars>",
      "did": "<1-3 sentences, what SHE did, with which tools, max 600 chars; required>",
      "result": "<effect in words, numbers only hers, max 400 chars, or \"\">",
      "tags": ["Postman"]
    }
  ]
}
```

- `category`: one of `language, frontend, backend, database, infra, ai, integration, practice, other`.
- `status`: `yes` for items in `verified_skills`, `no` for `never_claim_skills`, else `unknown`.
- Every story tag must be a tag name from `tags`; 1-6 tags per story. One story = one finished task or
  project. Aim for 10-30 stories; gap-period activities (freelance, courses, pet projects, volunteering) are
  stories too, which is how the bot can talk about them.
- No links, emails, phones; calm business tone, no «Привет!».

Check it and import into her **local** DB (fast, local only; proves the format):

```
node -e 'const j=require("./data/users/alina/kb-seed.json");const C="language frontend backend database infra ai integration practice other".split(" ");const n=new Set(j.tags.map(t=>t.name.toLowerCase()));const e=[];for(const t of j.tags){if(!C.includes(t.category))e.push("category: "+t.name);if(!["yes","no","unknown"].includes(t.status))e.push("status: "+t.name)}j.stories.forEach((s,i)=>{if(!s.did)e.push(i+": empty did");for(const[k,m]of[["title",100],["context",400],["did",600],["result",400]])if((s[k]||"").length>m)e.push(i+": "+k+" too long");for(const t of s.tags)if(!n.has(t.toLowerCase()))e.push(i+": unknown tag "+t);if(/https?:|www\.|@/.test(JSON.stringify(s)))e.push(i+": link/email")});console.log(e.length?e.join("\n"):"kb-seed OK: "+j.tags.length+" tags, "+j.stories.length+" stories")'
pnpm sgz db import-profile --user alina
pnpm sgz kb seed --user alina --from data/users/alina/kb-seed.json
pnpm sgz kb list --user alina
```

(`import-profile` creates the local user row if needed; the local `data/sgz.db` is only a check, the Pi has its own DB.)

## Step 6. Her hh.ru resume (she does it on hh.ru, you help with the text)

The bot needs **at least one published resume on hh.ru**; it syncs her resumes, picks one per vacancy and may
create extra copies per direction (up to `pool_expand_per_day` a day). Help her create or update it from
`cv/base-<direction>.yaml`: title, «О себе», опыт (same companies and periods as the CV), навыки. Visibility:
«видно всем» or «видно компаниям-клиентам hh». Ask whether the bot may create/rewrite resume copies
automatically (no -> `pool_expand_per_day = 0`, Step 9).

## Step 7. hh.ru login (she runs it; takes 2-5 minutes)

```
! pnpm sgz hh-login --user alina
```

A Chrome window opens on the hh.ru login page; she logs in (SMS, captcha by hand). The script polls for up to
10 minutes and prints «Сохранено N cookies в .../data/users/alina/hh-cookies.json». Rules:
- Log in **from a Russian IP without VPN** (the Pi applies from a Russian IP; hh drops sessions that hop countries).
- Don't log out of hh.ru in that window afterwards and don't change the password: that kills the saved session.
- `hh-cookies.json` is a password equivalent: never send it in a public chat.

## Step 8. Telegram (what really goes where)

1. Ask Yaroslav for the bot's @username; she opens it and presses **Start** (otherwise the bot cannot write to her).
2. Her chat id = her Telegram user id: she messages @userinfobot and copies the number (`Id`).
3. That number goes into her user row, field «Telegram chat id» (panel -> Настройки -> Пользователь), Step 9.

Routing (`packages/server/src/notify/telegram.ts`, `Notifier.forUser`): everything about her goes to **her own
chat id**: run reports, KB review cards from employer chats («Подтвердить / Дополнить / Нет навыка», and the
story she writes after «Дополнить»), review-queue cards («Отправить / Пропустить»), invitations, interview prep
and study packs, interview reminders, daily and weekly digests. Her buttons only act on her own cards. Service
alerts (a failed run, the bot not checking chats) go to the owner's chat (`TG_CHAT_ID`). With an empty chat id
her cards fall back to the owner's chat. Her chat can also use the commands `/status`, `/queue`, `/week`,
`/company`, `/salary`, `/study`, `/mock` (`/status`, `/queue`, `/week` show every user's data).

## Step 9. Limits and user settings (Yaroslav sets them on the Pi; she chooses the values)

Defaults for a new row: `daily_limit_hh` 25, `daily_limit_career` 10, `pool_expand_per_day` 2,
`allow_other_country` on, `active` on, `opus_enabled` off. Recommend starting **hh 5-10 a day** for the first
week, then raising. Global (Settings, affect everyone): max 10 applications per company per 30 days, one CV
direction per company, feedback request after a rejection (`feedback_request`), Habr `habr_daily_limit` 20.

## Step 10. Hand-off to the Pi owner

The Pi (`rpi-ts`) serves several users: users are rows in the Pi's own `sgz.db` and files in
`/opt/sgz/data/users/<slug>/`; the daily run (`--user all`) and the chat agent walk every **active** user that
has a profile. The placeholder row `alina` already exists there with no profile, so it is skipped until import.
**Important:** once her profile is imported and cookies are there, the next scheduled run applies for real.

What she sends Yaroslav (privately: AirDrop, a USB stick or an encrypted archive, not a public chat): the whole
folder `data/users/alina/` (`profile.yaml`, `cv/`, `kb-seed.json`, `hh-cookies.json`, later `habr-cookies.json`),
her Telegram chat id, chosen limits, and the fit-check note from Step 2 if any. Draft this message for her.

Commands for **Yaroslav** (on his Mac, repo root; he places her folder at `data/users/alina/` first):

```
make sync-data                                                     # data/ -> rpi-ts:/opt/sgz/data (no --delete)
ssh rpi-ts sgz db import-profile --user alina                      # profile.yaml -> the Pi's DB
ssh rpi-ts "sqlite3 /opt/sgz/data/sgz.db \"UPDATE users SET active=0, daily_limit_hh=5, tg_chat_id='<HER_CHAT_ID>' WHERE slug='alina'\""   # hold the schedule until the dry run passes
ssh rpi-ts sgz kb seed --user alina --from /opt/sgz/data/users/alina/kb-seed.json
ssh rpi-ts sgz kb list --user alina
```

(Or the same in the panel: `/u/alina/settings?tab=user` -> «Активен» off, limit 5, chat id -> Сохранить. Re-run `import-profile` after every profile.yaml
change; a human answer given in Telegram or the panel always wins over the file.)

## Step 11. First dry run, then the real run (Yaroslav starts it)

Dry run: panel -> Алина -> Запуски -> Новый запуск (source `hh`, dry run, limit 3), or

```
ssh -t rpi-ts sgz run --user alina --source hh --dry-run --limit 3
```

It syncs her hh resumes into the pool, searches, decides, writes letters, and never presses «Откликнуться».
Go through the result with her in the panel: which vacancies it picked and why, the letters, the skips on the
«Отфильтровано» page. Adjust `hh_queries` / `exclude_words` / directions in her profile if the picks are off
(then `make sync-data` + `import-profile` again). When she likes the picks:

```
ssh -t rpi-ts sgz run --user alina --source hh --limit 3
ssh rpi-ts "sqlite3 /opt/sgz/data/sgz.db \"UPDATE users SET active=1 WHERE slug='alina'\""   # or panel: «Активен» on
```

She checks the 3 applications on hh.ru («Отклики»). From now on the daily scheduled run and the chat agent include her.

**Habr Career (optional)**: only if she has a Habr Career profile. She runs `! pnpm sgz habr-login --user alina`
(log in, click through the listed pages, close the window), sends `habr-cookies.json`; Yaroslav:
`make sync-data`, then `ssh -t rpi-ts sgz run --user alina --source habr --dry-run --limit 3`. No Habr cookies
means Habr is simply skipped for her.

**Career sites (optional, review queue)**: needs `cv/base-<direction>.yaml` (already done) and sites added for
her (panel -> Настройки -> Карьерные сайты, or `ssh rpi-ts sgz site import --user alina --csv <file>`; imported
sites start disabled). The bot tailors a CV + letter and puts it into «Очередь»; **nothing is submitted until a
human presses «Отправить»**.

## Step 12. Panel tour and daily routine

Panel: address and password from Yaroslav (home Wi-Fi: `http://sgz.rp.i`; outside: via Tailscale). Her pages are
under `/u/alina/`: Обзор (day summary, login health), Запуски (runs and their log), Отклики (every application
and its status), Очередь (career-site applications waiting for a decision: send / inspect form / rebuild /
skip), Отфильтровано (what was skipped and why), Резюме, Чаты (employer conversations and bot replies),
База знаний (tags «есть / нет / ?» and stories; add or fix stories here), Настройки (profile, user, sites).

Daily, 5-10 minutes:
1. Telegram: read the run report; answer skill cards if they reach her («Дополнить» = write a short true story,
   «Нет навыка» = she hasn't used it). Unanswered cards fall back to «не заявлять» after a while.
2. Panel -> Чаты: anything marked for a human (test tasks, interview times) -> reply or confirm herself.
3. Panel -> Очередь (if career sites are on): send or skip each item.
4. Panel -> База знаний once a week: confirm seed stories, add new ones (a finished course, a new project).
5. New real experience -> update `profile.yaml` / `cv/` / hh.ru resume and ask Yaroslav for `make sync-data` +
   `import-profile`.

## Done when

- [ ] `data/users/alina/profile.yaml` passes the validator (`profile OK`), every fact confirmed by her
- [ ] `cv/base-<direction>.yaml` per direction; every period accounted for truthfully or consciously left as a gap
- [ ] `kb-seed.json` passes the check and imports locally (`kb list` shows her tags and stories)
- [ ] at least one published hh.ru resume matching the CV
- [ ] `hh-cookies.json` saved from a Russian IP
- [ ] she pressed Start in the bot; chat id known
- [ ] Yaroslav: sync-data, import-profile, limits + chat id set, KB imported on the Pi
- [ ] dry run reviewed with her; real run with limit 3 checked on hh.ru; `active` back on
- [ ] she knows the panel address, the daily routine and whom to ask

## Troubleshooting (real failure modes)

| Symptom | Cause | Fix |
|---|---|---|
| run log `alina: no profile, skipping`; chats ignored | profile never imported on the Pi | `make sync-data` + `ssh rpi-ts sgz db import-profile --user alina` |
| `kb seed`: `user not found: alina` | no user row in that DB | run `db import-profile --user alina` first (creates the row) |
| run fails `FAILED_LOGIN_EXPIRED` / «hh.ru login expired»; panel health `hh_login_ok: false` | stale cookies (password change, logout, new IP) | she re-runs `hh-login` from a Russian IP, sends the new `hh-cookies.json`; Yaroslav `make sync-data` + `ssh rpi-ts sudo systemctl restart sgz` |
| `hh-login`: «login timed out» | not finished in 10 min, or stuck on SMS | run it again; finish within 10 minutes |
| `hh-login` cannot start the browser | Chrome not at the default path | install Chrome or pass `--bin "<path to chrome>"` |
| captcha / 429 / «too many requests» | hh rate-limited the account or IP | wait 24 h, do not re-login repeatedly; lower `daily_limit_hh` to 5; see `docs/RUNBOOK.md` |
| dry run finds nothing or rejects everything | non-IT target (search limited to `IT_ROLES`, `decide_hh` rejects non-technical roles) or too strict `exclude_words` / narrow `hh_queries` | fit check (Step 2); widen queries; ask Yaroslav about per-profile roles |
| picks from the wrong direction | profile `directions` / resume titles don't match | align `directions`, `base-<direction>.yaml` names and hh resume titles |
| career run: `no base CV ... (expected base-<direction>.yaml)` | file name does not match a `directions` entry | rename to `base-<direction>.yaml` |
| bot answers «не использовала» for something she knows | skill missing from `verified_skills` / KB tag `no` or `?` | add it (panel -> База знаний or profile), re-import |
| she gets no cards in Telegram | her chat id is empty or wrong in the user row (cards then go to `TG_CHAT_ID`), or she never pressed Start | Step 8 |
| Habr: «FAILED_LOGIN_EXPIRED» | Habr cookies stale | `habr-login` again, send cookies, sync + restart |
| «claude failed» / empty JSON | the Pi's Claude login or rate limit | Yaroslav: `docs/RUNBOOK.md` «claude failed» |
