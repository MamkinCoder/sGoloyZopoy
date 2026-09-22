# Задача: краткая сводка резюме

Ниже текст резюме с hh.ru (до 6000 символов). Составь структурную сводку для подбора вакансий. Ничего не добавляй от себя: только то, что есть в тексте.

## Резюме

{{resume_text}}

## Поля

- `direction` - одно слово-направление: go-backend, node-backend, python-backend, react, vue, fullstack, android, ios, devops, data, qa, other.
- `seniority` - junior / middle / senior по описанному опыту (годы и роли), не по названию.
- `key_skills` - до 12 технологий из резюме, как написано в нём, самые важные первыми.
- `one_line` - одно предложение до 160 символов: кто, сколько лет, основной стек.

## Схема ответа

```json
{
  "direction": string,
  "seniority": string,
  "key_skills": string[],
  "one_line": string
}
```

Верни только JSON.
