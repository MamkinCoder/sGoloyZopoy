-- One source of skill claims: kb_tags.status (docs/ARCHITECTURE.md section 4). The phase-1 Telegram answers kept in
-- setting `skills_learned:<user>` = {"yes": [...], "no": [...]} move into the tags: a tag (by name or alias, ASCII
-- case-insensitive) still `unknown` takes the answer, a later KB answer (yes/no) wins; a skill without a tag gets one.
-- The settings (and the dead one-skill card names `skill_pending:*`) are deleted: no code reads them any more.
CREATE TEMP TABLE learned_skills AS
SELECT CAST(substr(s.key, 16) AS INTEGER) AS user_id, trim(j.value) AS name, l.status AS status
FROM settings s
JOIN (SELECT 'yes' AS status UNION ALL SELECT 'no') l
JOIN json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '{}' END, '$.' || l.status) j
WHERE s.key LIKE 'skills_learned:%'
  AND j.type = 'text' AND trim(j.value) != ''
  AND CAST(substr(s.key, 16) AS INTEGER) IN (SELECT id FROM users);

UPDATE kb_tags SET
  status = (
    SELECT l.status FROM learned_skills l
    WHERE l.user_id = kb_tags.user_id
      AND (lower(l.name) = lower(trim(kb_tags.name))
           OR EXISTS (SELECT 1 FROM json_each(kb_tags.aliases_json) a WHERE lower(trim(a.value)) = lower(l.name)))
    LIMIT 1),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'unknown'
  AND EXISTS (
    SELECT 1 FROM learned_skills l
    WHERE l.user_id = kb_tags.user_id
      AND (lower(l.name) = lower(trim(kb_tags.name))
           OR EXISTS (SELECT 1 FROM json_each(kb_tags.aliases_json) a WHERE lower(trim(a.value)) = lower(l.name))));

INSERT OR IGNORE INTO kb_tags (user_id, name, status)
SELECT l.user_id, l.name, l.status FROM learned_skills l
WHERE NOT EXISTS (
  SELECT 1 FROM kb_tags t
  WHERE t.user_id = l.user_id
    AND (lower(trim(t.name)) = lower(l.name)
         OR EXISTS (SELECT 1 FROM json_each(t.aliases_json) a WHERE lower(trim(a.value)) = lower(l.name))));

DELETE FROM settings WHERE key LIKE 'skills_learned:%' OR key LIKE 'skill\_pending:%' ESCAPE '\';
DROP TABLE learned_skills;
