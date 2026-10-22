# Задача: профиль нового соискателя из его ответов в Telegram

Новый пользователь ответил на вопросы бота и, возможно, прислал PDF-резюме. Собери из этого профиль для автоотклика. Только факты из ответов и текста резюме, ничего не выдумывай и не добавляй навыки «по смыслу».

## Ответы пользователя

```json
{{answers}}
```

## Текст резюме из PDF (может быть пусто)

{{cv_text}}

## Что вернуть

- `summary` - 3-5 предложений о себе от третьего лица без имени, только из фактов выше.
- `experience` - одна короткая фраза, например «3 года backend-разработки».
- `directions` - 1-3 направления только из списка: go-backend, node-backend, python-backend, java-backend, react, vue, fullstack, android, ios, devops, data, qa, other.
- `hh_queries` - 4-8 коротких поисковых запросов для hh.ru, по которым ищут вакансии этого человека (например «golang разработчик», «backend go», «react developer»). Строго по его роли и навыкам.
- `verified_skills` - технологии, которые человек сам назвал или которые написаны в резюме. Названия в общепринятом написании.
- `cv` - структура резюме. Если текста резюме нет, оставь `jobs` и `education` пустыми и заполни только `title`, `about`, `skills`.
  - `title` - желаемая должность.
  - `about` - 3-5 предложений.
  - `skills` - группы `{name, items[]}`.
  - `jobs` - `{period, role, company, location, summary, bullets[], stack[]}` строго по резюме, периоды и компании дословно.
  - `education` - `{institution, degree, period, note}`.

## Схема ответа

```json
{
  "summary": string,
  "experience": string,
  "directions": string[],
  "hh_queries": string[],
  "verified_skills": string[],
  "cv": {
    "title": string,
    "about": string,
    "skills": [{ "name": string, "items": string[] }],
    "jobs": [{ "period": string, "role": string, "company": string, "location": string, "summary": string, "bullets": string[], "stack": string[] }],
    "education": [{ "institution": string, "degree": string, "period": string, "note": string }]
  }
}
```

Верни только JSON.
