# Задача: изучить карьерный сайт компании

Ты смотришь на текст страницы карьерного сайта. Нужно определить, какая система вакансий (ATS) там используется, где список вакансий, есть ли JSON-эндпоинт, и как откликаться. Отвечай только по тому, что видно в тексте и URL; чего не видно - оставляй пустым.

## URL

{{url}}

{{#if hints}}
## Подсказки от человека

{{hints}}
{{/if}}

## Текст страницы (обрезан)

{{page_text}}

## Как определять ATS

- greenhouse: ссылки boards.greenhouse.io / job-boards.greenhouse.io / gh_jid → `jobs_json_url` = https://boards-api.greenhouse.io/v1/boards/<token>/jobs
- lever: jobs.lever.co/<token> → https://api.lever.co/v0/postings/<token>?mode=json
- ashby: jobs.ashbyhq.com/<token> → https://api.ashbyhq.com/posting-api/job-board/<token>
- workable: apply.workable.com/<token> → https://apply.workable.com/api/v3/accounts/<token>/jobs
- teamtailor: <sub>.teamtailor.com → /jobs
- smartrecruiters: jobs.smartrecruiters.com/<company> → https://api.smartrecruiters.com/v1/companies/<company>/postings
- huntflow: <sub>.huntflow.io ; potok: <sub>.potok.io
- hh_hosted: список вакансий ведёт на hh.ru/employer/… или company.hh.ru
- custom: всё остальное.

`apply_mode`: `ats_api`, если ATS из списка выше даёт публичный API отклика (greenhouse, lever, ashby, workable); иначе `agent` (отклик через браузер).
`discover_hints` - как найти список вакансий и открыть карточку: где меню, какие фильтры, что кликать. 1-3 предложения для агента.
`apply_hints` - где на карточке кнопка отклика, какие поля обычно есть, нужен ли аккаунт. 1-3 предложения. Пусто, если не видно.
`notes` - всё остальное полезное: язык сайта, регионы, если вакансий для разработчиков нет.

## Схема ответа

```json
{
  "ats": string,             // greenhouse | lever | ashby | workable | teamtailor | smartrecruiters | huntflow | potok | hh_hosted | custom
  "listing_url": string,     // абсолютный URL страницы со списком вакансий или ""
  "jobs_json_url": string,   // абсолютный URL JSON-эндпоинта или ""
  "apply_mode": string,      // ats_api | agent
  "discover_hints": string,
  "apply_hints": string,
  "notes": string
}
```

Верни только JSON.
