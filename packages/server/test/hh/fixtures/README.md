# hh fixtures — SYNTHETIC

Except `chatlist.html`, `chatlist-page2.html` and `chat-genai.html`: trimmed live hh.ru/chat recordings
(2026-09-24), with the seeker's name, participant names and ids scrubbed (company names kept).

Every file here was written by hand to exercise the parsers in `src/hh/state.ts` and the flows in
`src/hh/client.ts`. They mimic the shape we *expect* from hh.ru (`<template id="HH-Lux-InitialState">`
plus a few `data-qa` elements) but none of the key names or selectors are verified.

Replace them with scrubbed real recordings:

```
pnpm sgz hh-record --user <slug> --vacancy <id> --resumes --chats
```

then run the recorded html through `scrubHtml()` (`src/hh/scrub.ts`) with your name/phone/e-mail as
replacements before copying it here. Keep the same file names so the tests keep working, and update the
candidate paths in `state.ts` / `selectors.ts` if the real keys differ (the parsers log `matchedPath`).
