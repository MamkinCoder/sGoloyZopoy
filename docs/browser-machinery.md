# Browser machinery: a reference for scraping and automating websites

How sGoloyZopoy reads sites and fills forms, written so the parts can be lifted into a future project ("we need to
scrape / automate website X"). Everything described lives in `packages/server/src/browser/`,
`packages/server/src/career/` and `packages/server/src/llm/`. Paths below are relative to the repo root.

## 1. The idea in one paragraph

Prefer plain HTTP. When a browser is needed, drive a local Chromium with **Stagehand v4**, which turns a sentence
("fill the email field with %email%") into a concrete element by asking an LLM. The LLM is **Claude through
`claude -p`** (no API key). Every element the LLM finds is saved in our own **action cache** (a JSON file per site),
so the next run replays it with no LLM call; a replay that breaks is **healed** once and re-saved. Around that sit a
few cheap, deterministic guards that catch "the click succeeded but nothing happened", a **snapshot** of the page on
every failure, and a browser that does not advertise itself as automated.

## 2. Layers

```
site flow (e.g. career/agent-apply.ts)     fixed steps: open form, fill name, email, letter, upload CV, submit
      │  s.act("Fill the email field with %email%", { cacheKey: "career.apply.email", variables })
      ▼
BrowserSession interface  (packages/shared/src/browser.ts)      what every site flow codes against
      │  implemented by
      ▼
StagehandSession  (browser/session.ts)
   ├─ ActionCache  (browser/cache.ts)       <host>.json: step key → xpath + method + args
   ├─ covered-click guard (coveredClickJs)  a click on a covered element goes through the DOM
   ├─ fill / upload / evaluate / waitForText / snapshot   deterministic, no LLM
      ▼
Stagehand v4  (@browserbasehq/stagehand)    observe / act / extract; needs an LLM for observe + extract
      │  model.generate(messages)
      ▼
browser/adapter.ts → llm/stagehand.ts → llm/index.ts → llm/claude.ts
      │  spawn: claude -p --output-format json --model haiku [--json-schema …]
      ▼
Chromium over CDP (launcher.ts)  + a second raw CDP connection (cdp.ts) for URL blocking
```

Site code never imports Stagehand: it only sees `BrowserSession`. Tests use a scripted fake
(`packages/server/test/hh/fake-session.ts`, `FakeSession`) with hooks for act / evaluate / extract / waitForText.

## 3. Stagehand in short

Browserbase's open-source (MIT) library. Three verbs we use:

| verb | what it does | LLM? |
|---|---|---|
| `observe("the apply button")` | serialises the page as an accessibility tree (roles, labels, ids), asks the LLM which element matches, returns an xpath + method (`click`, `fill`…) + args | yes |
| `act({ selector, method, arguments })` | performs a known action through CDP: a real mouse event at the element's centre for `click`, typing for `fill` | no |
| `extract("the open questions", zodSchema)` | page tree + instruction → JSON validated by the schema | yes |

Not used: `agent` (autonomous multi-step loop: more LLM calls, less predictable), its **self-heal** (switched off in
`launcher.ts`, see §5) and its **cache** (in v4 this is Browserbase's server-side cache: needs their paid account,
sends page data to them; v3 had a local `cacheDir`, v4 dropped it). Local Chromium mode is fully supported; nothing
we run touches Browserbase.

Stagehand v4 loads itself into Chromium as an extension (`Extensions.loadUnpacked` over CDP), so
`--disable-extensions` must never be passed, and a Chromium without that CDP method (some local builds) cannot run it.

## 4. The LLM bridge (`claude -p` instead of an API key)

1. `launcher.ts`: `Stagehand.create({ model: { generate } })` with `generate = adaptLLM(llm.stagehand())`.
2. `browser/adapter.ts`: Stagehand's chat messages (text, images, tool calls) → plain text; images become
   `[image png]` (we never need vision). JSON replies are parsed back, fenced or not.
3. `llm/stagehand.ts` `flattenMessages`: one prompt, `### SYSTEM / ### USER / ### OUTPUT FORMAT (json schema)`.
4. `llm/index.ts` `stagehand()`: goes through the same `invoke` as every other LLM task, so it is logged in
   `llm_calls` and waits for the one-Claude-at-a-time mutex.
5. `llm/claude.ts`: `claude -p --output-format json --model <tier>` (+ `--json-schema` when the CLI has it).
   Stagehand uses the `fast` tier (Haiku; `SGZ_STAGEHAND_TIER` changes it): picking an element is classification.

Cost: 3-8 s per call on a Raspberry Pi, serialised with every other Claude job. That is why the cache exists.

## 5. Action cache and healing (our code)

`browser/cache.ts` `ActionCache`, used by `StagehandSession.act()` in `browser/session.ts`.

- **File**: `<cacheDir>/<host>.json`, e.g. `action-cache/corp.ivi.ru.json`. Entry per step key:
  `{ selector, method, arguments, description, hits, lastOkAt, failures }`. Written tmp + rename (crash-safe).
- **Key**: host + a stable step name we choose (`career.apply.submit`), not the instruction text, so prompts can be
  reworded without losing the cache.
- **Variables**: fills are stored as `%email%` / `%cover_letter%` and substituted at replay, so personal data never
  lands in the cache.
- **`act()` flow**:
  1. cached entry → replay it (no LLM). Success: `hits++`, done.
  2. replay failed → `failures++` (entry dropped after 2 in a row) → `observe` (one LLM call) → perform →
     save the new selector. That is the healing: once per breakage, persisted.
  3. no entry → the same observe → perform → save.
- **Why not Stagehand's self-heal**: it repairs inside one call and saves nothing, so a broken selector would cost an
  LLM call on every future run (and a second one when ours also kicks in).
- **What it cannot heal**: an action that "succeeds" on the wrong element (nothing failed). §6 covers that.
- **Not cached today**: `observe` for the CV file input (`findFileInput`), `extract` of extra form questions, the
  `extract` success check. A repeat run of a cached site is therefore ~2-3 LLM calls instead of ~8.

Inspect or reset: read the JSON; delete an entry to force a fresh lookup.

## 6. Reliability guards (catch "it clicked, nothing happened")

Learned the hard way on corp.ivi.ru (§11). All are generic, none is site-specific.

| guard | where | what it does |
|---|---|---|
| **covered-click** | `coveredClickJs` in `browser/session.ts`, before every cached/observed click | Hit-tests the target at its centre (`elementFromPoint`, after scrolling it into view). If something else is on top (modal, overlay, cookie banner) it calls `el.click()` through the DOM instead of a mouse event. A label over its own checkbox counts as clear; a target outside the document (iframe) or without a box is left to Stagehand. |
| **submit probe** | `SUBMIT_PROBE_JS` in `career/agent-apply.ts`, armed before the submit click | Records a `submit` event, any non-GET `fetch` / XHR, and `beforeunload`. Polled for 6 s after the click; a vanished probe means the page navigated. |
| **requestSubmit fallback** | `requestSubmitJs` | Probe saw nothing → `form.requestSubmit(button)` on the button's form (fires the site's own submit handlers, like a real click). Button not in this document → skip, fall back to the confirmation check. |
| **no-effect failure** | `applyViaAgent` | Still nothing → `FAILED_UI "submit had no effect"`: definitely not sent. Distinct from `FAILED_NO_CONFIRMATION` (something went out, no thank-you seen: check before retrying). |
| **success check** | `confirmSubmission` | Waits for phrases (`Спасибо`, `Thank you`, `отправлен`…), then one `extract` as a fallback. |
| **consent / name / letter helpers** | `TICK_CONSENT_JS`, `TAG_NAME_FIELDS_JS`, `LETTER_LIMIT_JS` | Deterministic page scripts for recurring form chores: tick personal-data boxes, tell Имя from Фамилия, respect a letter length limit. |
| **act returns its selector** | `ActResult.selector` | Lets a flow run follow-up DOM code on the exact element the action hit. |

Rule of thumb for any new flow: after an action that must have an effect, **verify the effect** (event, request,
navigation, DOM change) instead of trusting `success: true`.

## 7. Debugging

- **Snapshots** (`session.snapshot(name)`): `<name>.html` (the live DOM at that moment, including script-set state
  such as `data-status="spam"`), `<name>.png` (viewport screenshot) and `<name>.url`. Written on every career apply
  failure and dry run, and by the hh / Habr clients at their failure points. On the Pi:
  `/opt/sgz/data/snapshots/run-<id>/`. Panel: the red link on a failed row of the Applications page opens the html.
  The html has no styles/images when opened; use the png for looks.
- **Logs**: `journalctl -u sgz` on the Pi; filter out Stagehand's `CDP response failed … Frame … not found` noise
  (`grep -v "CDP response failed"`). Run events: `runs`, `applications.reason_detail`, `llm_calls` in `sgz.db`.
- **Safe live reproduction** (how the IVI bug was found): a small node script that uses the real `createLauncher`
  with a copy of the site's action-cache file and dummy data, and first blocks every request that could deliver the
  form on the page target (`Network.setBlockedURLs` over a raw CDP connection: e.g. `*wp-json*`, `*admin-ajax*`, the
  vacancy URL, the ATS host). Then replay the cached steps and log, per step: form status attributes, open popups,
  `elementFromPoint` at the target, and the events that fired (`mousedown/click/submit/…` captured on `document`).
  Run it where the bot runs (the Pi), with the service idle.
- **Test doubles**: `FakeSession` for flow tests (`packages/server/test/career/agent-submit.test.ts`); page scripts
  are tested against a minimal fake DOM via `new Function("document", …)` (`covered-click.test.ts`,
  `letter-limit.test.ts`).

## 8. Looking like a normal browser (reCAPTCHA v3 and co.)

Context: the bot only ever submits the seeker's own application, one per human tap. The goal is that an ordinary
form does not reject it as "a bot", not mass automation.

### What the scoring looks at (research, 2026)

- **IP reputation dominates.** Residential / mobile IPs score high, datacenter ranges low regardless of anything
  else. The Pi browses from a home residential IP (`--no-proxy-server` keeps Chromium off the VPN exit the service
  env sets for Claude/Telegram): keep it that way; never run the browser from a VPS.
- **Browser environment**: user-agent coherence, client hints, screen vs window, WebGL/canvas, languages,
  `navigator.webdriver`, headless markers.
- **Session**: cookies and history (a persistent profile helps; a Google-signed-in profile helps most).
- **Behaviour**: instant machine-speed actions score lower than human pacing.

### What the launcher sets (`browser/launcher.ts`)

| tell (headless default) | fix |
|---|---|
| UA says `HeadlessChrome/153`, or a hard-coded `Chrome/131` that contradicts the browser's own client hints (`Chromium 153`) | `--user-agent` built at launch from `chromium --version` in Chrome's reduced form (`Chrome/<major>.0.0.0`, platform token per OS). Passed as a **flag**, so `navigator.userAgentData` keeps the browser's real brands. `SGZ_USER_AGENT` overrides; the default is empty (derive). |
| `navigator.languages` = `en-US,en` (headless ignores `--lang`) | `--accept-lang=ru-RU,ru,en-US,en` |
| screen 800x600 under a 1366x850 window | `--screen-info={1366x900}` |
| no WebGL | `--enable-unsafe-swiftshader` (software WebGL; some CPU on the Pi) |
| `navigator.webdriver` | already `false` with Stagehand v4's launch |

Pitfalls found while doing this:
- Overriding the UA per page with CDP `Emulation.setUserAgentOverride` **blanks client hints** unless you pass
  `userAgentMetadata`, and the metadata cannot be read on the initial `about:blank` (not a secure context). The launch
  flag avoids both.
- `acceptLanguage` / `--accept-lang` with `q=` weights shows up verbatim in `navigator.languages`; list plain tags.
- Logins (`sgz hh-login`, `habr-login`) and runs must present the same UA family; both now use the derived one.

### Measuring

- `https://antcpt.com/score_detector/` shows the reCAPTCHA v3 score the browser gets (free tier buckets: 0.1 / 0.3 /
  0.7 / 0.9). The bot's browser scored 0.9 before and after the flags above.
- Dump the fingerprint with one `evaluate`: `navigator.userAgent`, `userAgentData.brands`, `languages`,
  `screen` vs `outerWidth/Height`, the WebGL `UNMASKED_RENDERER_WEBGL`, `navigator.webdriver`.
- A site's own score is not visible from the client. Contact Form 7 (WordPress) marks a submission `spam` below its
  threshold (default 0.5, filter `wpcf7_recaptcha_threshold`) but also for its disallowed list or Akismet, with the
  same "error" text for spam and mail failure; read `data-status` on the form to tell which. CF7 6.x requests a fresh
  token at submit time, so slow form filling does not expire it.

### Not done (options if a site still rejects)

Headful Chromium on a virtual display (xvfb), images on for apply runs, a profile signed in to Google, human-paced
mouse movement / delays before submit. Paid captcha-solving services are out of scope.

## 9. HTTP first: ATS clients

Before reaching for a browser, check whether the site runs on an ATS (applicant tracking system) with a public API.
`packages/server/src/career/ats/`:
- generic clients per system (`greenhouse.ts`, `lever.ts`, `ashby.ts`, `workable.ts`, `smartrecruiters.ts`,
  `teamtailor.ts`, `hh-hosted.ts`, …) and ~70 per-site clients in `sites/` (`ivi.ts`, `mts.ts`, …);
- each implements `ATSClientImpl` (`ats/types.ts`): `detect`, `listJobs`, `fetchJob`, optionally `apply` over HTTP,
  plus `notes` documenting what was verified live (endpoints, pagination, what is not exposed);
- plain `fetch` + regex/JSON parsing, no browser and no LLM; fixtures in `packages/server/test/career/fixtures/`.

Browser + Stagehand is the fallback for discovery on unknown sites and for applying where no HTTP apply exists.

## 10. Running on a small machine (Pi 4, 1.8 GB)

- `launcher.ts` flags: `--disable-gpu --disable-dev-shm-usage --renderer-process-limit=2`, images off
  (`--blink-settings=imagesEnabled=false`), a disk cache capped at 50 MB in a temp dir.
- `cdp.ts` `installAssetBlocker`: a second raw CDP connection (Node's global WebSocket) that sets
  `Network.setBlockedURLs` on every page target: images, fonts, media, analytics (Yandex Metrika, GA, GTM, DoubleClick,
  top.mail.ru). Stagehand exposes no request interception, Chrome allows several CDP clients.
- One browser at a time, persistent per-user profile (`userDataDir`) so logins survive, memory guard before browser
  jobs, `KillMode=control-group` in the systemd unit so orphaned Chromium dies with the service.

## 11. Case study: corp.ivi.ru (2026-09-28)

1. The cached "open the form" step clicked the header «Хочу в команду», which opens a popup with a *different*
   general form; the vacancy form behind it was filled (fills do not need hit-testing).
2. The submit click, a mouse event at the button's centre, landed on the popup overlay and only closed it. Stagehand
   reported success; the form stayed `data-status="init"`; the old code said "no confirmation".
3. Found by the safe reproduction (§7): `elementFromPoint` at the button = `DIV#cf7Popup.popup-active`, events =
   mousedown/mouseup/click on the popup.
4. Fixed generically: covered-click guard + submit probe + requestSubmit fallback. The next real send reached the
   server, which answered `spam` (CF7); the reason is not visible client-side (§8).

Lessons: verify effects, hit-test before clicking, snapshot the live DOM, reproduce with sending blocked, and measure
bot signals instead of guessing.

## 12. Checklist for "automate website X"

1. Look for an API first: network tab, `/wp-json`, JSON in the HTML, a known ATS. If found, write an HTTP client
   (§9) with `notes` and fixtures.
2. Otherwise copy `packages/server/src/browser/` + `packages/shared/src/browser.ts` + the LLM bridge (§4), and write
   the flow as fixed `act` steps with stable `cacheKey`s and `%variables%`.
3. Guard every consequential action with an effect check (§6); snapshot on every failure (§7).
4. First run on a site: expect one LLM call per step; check the cache file afterwards.
5. Dry-run mode that fills but does not submit; a reproduction script with sending URLs blocked.
6. Browse from a residential IP with the launcher's flags (§8); measure the fingerprint once per new Chromium.
7. Tests: `FakeSession` for the flow, fake-DOM tests for page scripts.
