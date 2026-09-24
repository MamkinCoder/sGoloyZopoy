# sGoloyZopoy architecture: batch runs, the always-on agent, the knowledge base

Status: design contract for the rebuild started 2026-09-24. Builders implement against this file; change
it in the same commit when reality forces a deviation.

## 1. Two execution planes

| | Batch runs | Always-on agent |
|---|---|---|
| What | 12:00 hh + habr apply, career `rotate` chunks, manual runs, send/inspect/retailor/force | employer chats, Telegram interactions, knowledge-base questions, anything reactive |
| Engine | `runner/service.ts` (one main slot, watchdog, `runs` table, reports) | `agent/` job queue worker inside `sgz serve` (`jobs` table) |
| Browser | main Chrome profile `chrome-profile` | agent profile `chrome-profile-chat` (same hh/habr cookies) |
| Trigger | scheduler / autopilot tick / API | recurring schedules + events (new chat message, Telegram tap, KB answer) |
| Failure unit | a whole run | one job (retries with backoff, then `failed` + alert) |

The planes never wait for each other. Batch runs no longer touch chats at all. The runner's `chats` slot
(added 2026-09-24) is replaced by the agent.

- As built (board adapters): hh and Habr Career are two `Board {search, fetch, send}` adapters
  (`runner/hh.ts hhBoard`, `runner/habr.ts`) over one search -> classify -> fetch -> decide -> apply loop and one
  `force:<id>` path in `runner/board.ts` (`runBoard`, `forceApply`). hh keeps its stages around it (pool sync,
  viewers first, tailored copies inside its `send`, touch, pool expand); Habr's allowance throws `BoardExhausted`.
  Per-board log texts and the small force differences (hh: memory guard, `was` detail, log line) are kept as they
  were. Career sites stay separate (review queue, rotate); every source builds its classify options with
  `filters.ts filterOpts` and re-checks the company quota with `companyQuotaSkip` (also used by `classify`).

## 2. The agent: a persistent job queue

`sgz serve` starts `createAgent(deps)`; it owns a loop and a handler registry.

```
jobs(id, kind, key UNIQUE-when-open, payload_json, state, priority, run_after, attempts, max_attempts,
     last_error, lease_until, created_at, updated_at)
state: queued -> running -> done | failed | queued (retry, run_after = now + backoff)
```

- `enqueue(kind, payload, {key, runAfter, priority})`. A `key` dedupes: at most one open (`queued`/`running`)
  job per key, so "sync chats" or "draft task 42" can be requested from ten places safely.
- **Resources.** A handler declares `needs: "browser" | "llm" | "none"`. The worker runs at most one browser
  job at a time (one agent Chrome), at most `SGZ_CLAUDE_PARALLEL` LLM jobs (the existing claude semaphore),
  `none` jobs freely. Browser is opened lazily and closed after `AGENT_BROWSER_IDLE_MS` without browser jobs.
- **Recurring schedules** are rows in code, e.g. `{kind: "chats.sync", every: 5 min}`. A tick enqueues them
  by key; no job, no work.
- **Crash safety.** `running` jobs whose `lease_until` passed are requeued at boot and by the loop.
  Every handler is idempotent (reads state from the DB, never from memory).
- **Observability.** `GET /api/agent/jobs?state=` + a panel section; a job that exhausts retries alerts
  once in Telegram (dedup via the existing alert pattern). The chat stall alert watches `chats.sync`.
- As built (review round 3): a timed-out job keeps its resource until its handler really returns (the browser is
  closed on timeout, the retry and other browser jobs wait), so there is never a second agent Chrome; the handle
  also waits for a close in progress before launching on the same profile. No browser job starts while
  MemAvailable < `SGZ_MEMORY_GUARD_MB`. A requeued job already at `max_attempts` (its runs died with the process,
  e.g. OOM) fails instead of running again after every restart. A handler with `onFailed` alerts itself per job
  (chat tasks: «Не ответил работодателю: <employer>»); the once-per-kind alert is only for jobs without one
  (`chats.sync`, `chats.prep`). A DB error in the loop is logged, not fatal. With `SGZ_RUNNER=false` the agent
  runs no chat jobs (below), so Telegram taps and stories are refused («агент выключен») instead of queued for nobody.
- As built (one scheduler): `commands/serve.ts` is wiring only. Its old timers are agent schedules
  (`scheduler/jobs.ts serveJobs`): `interviews.remind`, `health.heartbeat`, `health.chats`, `digest.day`,
  `digest.week`, `learn.lessons` (llm) and `runner.autopilot` (none; parked sends, then touch / career rotate via
  `runner.start`). `Schedule.due(now)` is a cheap check made every `everyMs`; the job is enqueued only when it is
  true, so the jobs table holds real work only. Day keys (`digest_last_day`, `retro_last_day`, `touch_last_at`,
  `queue_send_pending`) are unchanged. The agent always starts in `sgz serve`; with `SGZ_RUNNER=false` it has only
  the digest/retro handlers and `keepUnknown` leaves chat jobs queued. Every "alert once" (`alert_open:job:*`,
  `alert_open:heartbeat`, `alert_open:chats`, `alert_last:*`, `habr_alert_day:*`) goes through `notify/alert.ts`
  (`openAlert` / `alertOnce` / `closeAlert`: until closed, a ttl, or a UTC day; a failed send stays closed).
- As built (LLM lane): the agent runs `llm` and `browser` handlers inside `llmCaller` (AsyncLocalStorage in
  `llm/mutex.ts`), so `runClaude` waits in the mutex's priority list ahead of batch runs, the job's timeout clock
  starts at the first slot acquire (`onAcquire`; ponytail: an llm job hanging before any claude call has no clock),
  and the job's `AbortSignal` (also `JobContext.signal`) kills its claude child on timeout. `none` handlers run
  outside it, so a batch run started by `runner.autopilot` keeps normal priority.

Handlers are the unit of extension: new always-on features = new job kinds, not new timers.

## 3. Chat replies as a state machine

One **reply task** per employer turn (one or more consecutive employer messages in a thread).

```
chat_tasks(id, thread_id, message_ids_json, state, topics_json, draft, tg_message_id, attempts, last_error,
           created_at, updated_at)
state: new -> triage -> awaiting_review -> drafting -> ready -> sending -> sent
                                  \-> superseded (employer wrote again before we sent: merged into a new task)
       any -> failed (after retries; alerted)
```

Jobs (all keyed by task id, so repeats are harmless):
1. `chats.sync` (browser, every 5 min and right after any send): read chat lists hh + habr, store new
   messages, open a task for every thread with unanswered employer messages. New employer messages on a thread
   with an open unsent task mark it `superseded` and open a fresh task covering all unanswered messages.
2. `chats.triage` (llm): decide what the turn needs: `topics` = technologies/skills the employer asks about
   (normalized to KB tags), `kind` = question | scheduling | test task | rejection | bot survey | ack-only.
   Ack-only and rejection keep today's behavior (no reply / feedback request). Otherwise -> review.
3. **Review gate** (`kb.review`, none): for every topic, a KB review item (section 4). While any item is
   unresolved the task stays `awaiting_review`. Mode setting `kb_review_mode`: `always` (current: every topic
   is shown to Yaroslav) | `new_only` (only topics without confirmed stories: a tag with stories counts only when it is `yes` or one
   of its stories is confirmed) | `off`.
4. `chats.draft` (llm): when all review items are resolved, write the reply from the KB stories of the topics
   + profile + vacancy + history (answer_chat rules: always forward, Moscow office + relocation, never claim
   what the KB marks `no`). -> `ready`.
5. `chats.send` (browser): send, re-read the thread to confirm our message is there, mark messages handled,
   `sent`. Enqueue `chats.sync` for the same thread shortly after (hh AI assistants reply within seconds).

A Telegram tap or a typed story only writes to the DB and enqueues `chats.draft` / `kb.review` for that
task: instant, restart-proof, independent of any run.

### As built in phase 1 (deviations from the sketch above, 2026-09-24)

- `chat_tasks` also has `user_id`, `target` (hh chat url / Habr login, where `chats.send` writes), `choices_json`
  (quick-reply buttons of an hh chat-bot question), `kind` and `reminded`. Terminal state `closed` = handled
  without a reply (ack-only, rejection, empty draft, answered by hand, chat closed); `sent` always means a reply
  went out. State changes are compare-and-set, so a sync superseding a task while its draft is written is safe.
- The review step is job `chats.review` behind `ReviewGate` (`agent/chats/review.ts`: `prefill / ask / record /
  card`); phase 1's gate reads `verified_skills` / `never_claim_skills` + learned answers and sends one grouped
  card (`ct:<task>:<topic>:y|n`). Phase 3 replaced the gate with the KB review (§4 as built); `tasks.ts` only gained the KB block for the draft, `expire` on fallback and carrying answers into the fresh task when `chats.send` supersedes.
  The 2 h reminder and 12 h fallback are delayed jobs `chats.remind` / `chats.fallback`; the invitation brief is
  `chats.prep` (llm). A task whose job failed is not reopened until the employer writes again.
  Round 3: both timers are enqueued before the card (a Telegram outage never fails the task) and restart
  (`EnqueueOptions.replace`) when the draft sends the task back with new topics. The fallback answers a topic
  whose tag is `yes` (verified_skills, confirmed) as «yes» and only unknown ones as «нет». Topics that are aliases
  of one tag are answered together; a draft that still names an answered skill fails the task to the human
  (no retry loop). `chats.send` marks the task right before the click: a retry never clicks again, it only
  confirms by the text's first 60 chars or fails to the human; after a successful `sendMessage` a page copy
  that does not match exactly is only logged. Closing or failing a task expires its KB reviews; `kbText` also
  drops a «Дополнить» wait nothing waits for any more.
- Board adapters: `tasks.ts chatBoard(env, thread)` is the thread's site (`open / read / send / url`, Habr by the
  `habr:` key prefix), so `chats.send` and the alert links never branch on the site; `habrPageMessage` is the one
  Habr-message mapping, `settleThread` the one "nothing to send" close used by both syncs. Threads are read by id
  with `Store.getChatThread`.
- The re-sync after a send is the normal full `chats.sync` pulled to +30 s (key dedupe), not a per-thread sync:
  unchanged threads cost one list read.
- hh chat-bot surveys (the questionnaire widget) are still answered inside `chats.sync` (one LLM call inside a
  browser job); a job of their own if they get frequent. Only the survey's own question messages count as
  answered by it: typed employer text next to it gets a reply task. Habr's «вы договорились о работе?» survey
  marks only itself handled.
- The agent's tables are on `SqliteStore` (`db/jobs.ts`, `db/chat-tasks.ts`, `db/kb-reviews.ts`), not on the shared `Store` contract:
  only the agent and the API view (`ApiDeps.agent`) use them. Stage `chats` is gone from runs entirely (batch A: also
  from the shared `Stage` type; `JobsRepo.getJob`, used only by tests, is deleted).
- Batch A: the Telegram `getUpdates` offset is persisted (setting `tg_offset`, read at start, saved before each
  update is handled), so a restart (every deploy) never replays an update: a replayed «Дополнить» story would land
  on the next waiting review and mark the wrong tag `yes`. At most once on purpose. `Notifier.edit` goes through the
  same retry loop as sends (network / 429 / 5xx), then only logs.

## 4. Knowledge base (the seeker's experience, replacing "master CV" as the source of truth)

```
kb_tags(id, user_id, name, aliases_json, category, status: yes|no|unknown, updated_at)
kb_stories(id, user_id, title, company, period, context, did, result, source: seed|telegram|panel,
           confirmed INTEGER, hash, created_at, updated_at)
kb_story_tags(story_id, tag_id)
kb_reviews(id, user_id, task_id NULL, tag_id, state: pending|confirmed|expanded|denied|expired,
           tg_message_id, prompt, created_at, resolved_at)
```

- A **tag** is a technology or skill (Grafana, React, RAG, "code review", "system design") with aliases
  (react.js, реакт). `status` replaces `verified_skills` / `never_claim_skills` (kept in sync for older
  code paths until they read the KB directly).
- A **story** is what was done: company + period + context + what I did + result/metrics, linked to many
  tags. Stories are the only material CVs, letters and chat answers may use; anything not in a story or the
  profile is not claimed.
- **Seeding** (`sgz kb seed --user`): one LLM pass over base CVs, profile.yaml (+ extra facts), the Habr
  proposal and hh resume texts -> stories + tags, `source: seed, confirmed: 0`. Re-runnable (idempotent by
  content hash), never deletes human-added stories.
  As built (phase 2): `kb_stories.hash` (added to the doc's schema) holds the content hash of a story as first
  inserted, so an edited seed story is not re-added by the next seed; a seed only adds, it never edits or
  deletes rows. hh resume texts are not read yet (the base CVs carry the same facts). Tag statuses are
  deterministic: `verified_skills` -> `yes`, `never_claim_skills` -> `no`, everything else `unknown`; an existing
  tag's status changes only while `unknown`. Numbers, periods and companies in stories survive only when present
  in the sources (`kb/write.ts guardStory`). `--dry-run [--out f]` writes the JSON without a DB, `--from f` imports
  such a JSON without the LLM (seed on the Mac, import on the Pi). `sgz kb list --user [--tag]` prints it.
  Round 3: a story is skipped when its hash was ever imported (setting `kb_seed_hashes:<user>`, so a deleted seed
  story stays deleted) or a story with the same company + title exists (an LLM re-run rewords); the hash is taken
  before `no` tags leave the draft. A tag's status comes from its name; an LLM alias naming another profile skill is
  dropped (it survives only as the one alias naming a tag whose own name is not in the profile). Numbers need
  their unit in the sources («3 раза» is not allowed by «Python 3»), and quantity words («вдвое», «сотни») need to
  be there verbatim. `upsertKbTag` also matches an existing tag by an incoming alias (when exactly one tag is hit)
  and drops an alias naming another tag.
- **Profile sync** (until consumers read the KB): `syncProfileSkills` after every status change, `sgz db
  import-profile` applies it too. A `yes` tag is added to `verified_skills` and removed from `never_claim_skills`,
  `no` the other way round, `unknown` tags and skills without a tag are left alone (union, never a replace).
  Removal matches the tag name only (an alias never deletes an entry). The reverse: a panel edit of the profile
  lists (`PUT /users/:slug/profile`, `applyProfileSkills`) moves the tags first (name in never -> `no`, in verified
  -> `yes`, in neither -> `unknown`), so the next sync keeps the edit.
  As built (batch A): **`kb_tags.status` is the only source of skill claims.** The phase-1 `skills_learned:<user>`
  setting (+ `learnSkill` / `learnedSkills` / `withLearnedSkills`, `runner/skills.ts`) is deleted; migration `008a`
  folded it into the tags (only where a tag was `unknown`, missing tags created) and dropped the settings. Writers
  only move tags, `syncProfileSkills` is the one (one-way) writer of the profile lists: a Telegram answer
  (`record`: `setKbTagStatus` + sync), a panel edit (`applyProfileSkills`, which now also creates a tag for a listed
  skill no tag knows, + sync), `sgz db import-profile` (`importProfile`: profile.yaml sets only tags with no status
  yet, never_claim first, a human answer wins; then sync).
- **Ingest** (`kb/llm.ts ingestKb`, pure, phase 3 calls it): the human's text -> 1..3 stories, numbers only from
  that text; `saveIngested` stores them `confirmed` and marks the asked tag `yes`.
- **Telegram review card** (one per chat task, all topics in one message):
  ```
  НЕОЛАНТ спрашивает: «Писали unit/компонентные тесты на Jest или Vitest?»
  Jest: 1 история (Яндекс: ...). [Подтвердить] [Дополнить] [Нет навыка]
  Vitest: пусто. [Дополнить] [Нет навыка]
  ```
  «Дополнить» -> the bot asks for a story about the tag; the next free-text message in that chat is the
  answer -> `kb.ingest` (llm) turns it into a structured story (never inventing numbers) -> saved, card updated.
  «Нет навыка» -> tag status `no`. When every topic is resolved the task moves to drafting.
  As built (phase 3, `agent/chats/review.ts` `kbReviewGate`, the phase-1 skills gate is deleted): the step is still
  job `chats.review` behind `ReviewGate` (+ `expire(taskId)` for the fallback, `record` takes the task id). Buttons
  are one row per topic «Подтвердить X» «Дополнить X» «Нет навыка X» (`kr:<review id>:c|e|d`; «Подтвердить» only
  with stories, it confirms only the stories the card shows (fewer than 3 when the card is shortened to fit)). `kb_reviews` gained `topic` (the task's
  name for it), `awaiting_chat` / `awaiting_at` (migration `007c`): «Дополнить» marks the review as waiting in the
  tapped chat (`TapReply.say` sends the question there), `kbText` routes the next plain message of that chat to
  job `kb.ingest` (llm) before `/mock`, and asks the next waiting review, oldest first. After the ingest the card is
  edited via `Notifier.edit` (also after an empty or failed ingest, which says so per topic). Every text is its
  own `kb.ingest` (a second story is never dropped); «Нет навыка» tapped during the ingest wins. A topic the KB does not know becomes a tag with the profile's yes/no when listed,
  else `unknown`. `new_only` also skips tags already `no`; `off` answers from the tag status (unknown = not
  claimed). `chats.draft` (round 3: stories without the `no` tags' and this task's «нет» topics' sentences, and their
  names + aliases join never_claim for the reply guard via `withKbNever`) passes a KB block over topics + vacancy +
  question with this task's answers as statuses into `answer_chat` (`{{kb}}` block).
  As built (truth + cleanup, batch A): the draft block is `kbBrief(..., {tags, text, overrides})`, the same filter as
  letters; `overrides` are the task's answers (incl. the 12 h fallback «нет»), a «no» override is scrubbed from the
  stories and joins `no` like a status-`no` tag, an asked `no` topic keeps its «не заявлять» line.
  `answerChat(..., kb?: KbBrief)` applies `withKbNever` itself like the other generators; the only per-task profile
  change left is a «да» topic added to verified_skills for that draft (an alias like Golang must not come back as
  unknown_skills). `draftProfile` / `knownProfile` are gone (triage and draft read `getProfile`). Old `ct:` / `sk:`
  buttons only answer «кнопка устарела» (their handlers are deleted).
- **Consumers** (all through one module `kb/context.ts`: `kbFor(userId, {tags?, text?}, budget)` returning
  ranked stories + tag statuses, rendered for prompts):
  chat drafting, questionnaire answers, cover letters, interview prep/study packs, `tailor_cv` (LaTeX CVs are
  forged from base CV structure = jobs/dates/contacts + KB stories as bullet material), hh tailored resume
  copies, the Habr profile proposal.
  As built (phase 4, everything but chat drafting): `kbBrief(store, userId, {text, tags?, companies?}, budget)` in
  `kb/context.ts` wraps `kbFor` for application texts and returns `{text, no}` (`KbBrief`, shared): `text` is the
  rendered block (default budget `KB_BRIEF_BUDGET` = 3000 chars of stories; Habr proposal 6000), `no` = names +
  aliases of the status-`no` tags. Status-`no` tags never reach a prompt's KB block: they leave story tag lists and
  topics, sentences naming them leave the stories, a story whose title names one is dropped. `withKbNever(profile,
  kb)` appends `no` to `never_claim_skills`, so the existing guards (blockedTech, sanitizeLetter, guardTailored,
  guardTailoredCV, validateCV, guardStudy, guardProposal) and the prompts' «никогда не заявлять» list enforce them.
  `kbForVacancy(store, userId, vacancy(s), extra)` = kbBrief over title + description (+ questions / invitation).
  Every prompt gets the same partial `prompts/_kb.md` (a `## База знаний` section, absent when the KB is empty).
  Wiring: `DecideInput.kb(vacancies)` builds one block per decide batch (`runner/learn.ts decideKb`, part of
  `decideExtras`; the force paths pass it too) -> hh/Habr letters + `tailored` about; the LLMClient methods
  `answerQuestionnaire`, `tailorCV`, `coverLetterCareer`, `interviewPrep`, `interviewStudy` take an optional last
  `kb` argument (fakes/tests without it behave as before); `tailor_cv` gets only stories whose company matches a base
  CV job (companyKey, either way contained), job identity/periods still come from the base CV (guardTailoredCV +
  validateCV unchanged). A KB read error or an empty KB gives `undefined`: no section, never a failed application.
  Not wired yet: the agent's bot-survey questionnaires in `agent/chats/hh.ts` (phase 3 owns that file).
- **Panel**: «База знаний» page: tags (status, story count), stories (edit, confirm, delete), add story.
  API under `/api/users/:slug/kb/*`.

## 5. Build phases

1. Agent queue + chat task state machine + one grouped Telegram card per task (skills gating on the existing
   yes/no data), replacing the runner's chat slot and the settings-key skill state.
2. KB tables, seed command, API, panel page.
3. KB review gate in chats (always mode), Дополнить flow via free-text, drafting from stories.
4. KB as the source for CVs, letters, questionnaires, prep.
