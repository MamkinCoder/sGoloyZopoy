// Knowledge base tables: kb_tags, kb_stories, kb_story_tags (kb_reviews is phase 3). Logic lives in src/kb/.
import { mergeAliases, tagIs, type KbStory, type KbStorySource, type KbTag, type KbTagStatus, type Store } from "@sgz/shared";
import { bool, json, nowISO, num, placeholders, str, toJson, type Row, type Sql } from "./sql.js";

type KbRepo = Pick<Store, "listKbTags" | "upsertKbTag" | "setKbTagStatus" | "listKbStories" | "getKbStory" | "saveKbStory" | "deleteKbStory">;

const TAG_SELECT = `SELECT t.*, (SELECT COUNT(*) FROM kb_story_tags st WHERE st.tag_id = t.id) AS story_count FROM kb_tags t`;

const mapTag = (r: Row): KbTag => ({
  id: num(r.id),
  userId: num(r.user_id),
  name: str(r.name),
  aliases: json<string[]>(r.aliases_json, []),
  category: str(r.category),
  status: str(r.status) as KbTagStatus,
  updatedAt: str(r.updated_at),
  storyCount: num(r.story_count),
});

const mapStory = (r: Row, tags: { id: number; name: string }[]): KbStory => ({
  id: num(r.id),
  userId: num(r.user_id),
  title: str(r.title),
  company: str(r.company),
  period: str(r.period),
  context: str(r.context),
  did: str(r.did),
  result: str(r.result),
  source: str(r.source) as KbStorySource,
  confirmed: bool(r.confirmed),
  hash: str(r.hash),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
  tags,
});

export function kbRepo(s: Sql): KbRepo {
  const tagById = (id: number): KbTag | null => {
    const r = s.get(`${TAG_SELECT} WHERE t.id = ?`, id);
    return r ? mapTag(r) : null;
  };
  const withTags = (rows: Row[]): KbStory[] => {
    if (!rows.length) return [];
    const ids = rows.map((r) => num(r.id));
    const links = s.all(
      `SELECT st.story_id AS sid, t.id AS id, t.name AS name FROM kb_story_tags st JOIN kb_tags t ON t.id = st.tag_id
       WHERE st.story_id IN (${placeholders(ids.length)}) ORDER BY t.name COLLATE NOCASE`,
      ...ids,
    );
    const by = new Map<number, { id: number; name: string }[]>();
    for (const l of links) {
      const list = by.get(num(l.sid)) ?? [];
      list.push({ id: num(l.id), name: str(l.name) });
      by.set(num(l.sid), list);
    }
    return rows.map((r) => mapStory(r, by.get(num(r.id)) ?? []));
  };

  const repo: KbRepo = {
    listKbTags(userId) {
      return s.all(`${TAG_SELECT} WHERE t.user_id = ? ORDER BY t.name COLLATE NOCASE`, userId).map(mapTag);
    },

    upsertKbTag(userId, t) {
      const name = t.name.trim();
      if (!name) throw new Error("kb tag: empty name");
      return s.transaction(() => {
        // By name first, then by an incoming alias («K8s» with alias «Kubernetes» is the existing «Kubernetes»).
        const all = repo.listKbTags(userId);
        // Aliases hitting two different tags are ambiguous: no alias match then.
        const byAlias = all.filter((x) => (t.aliases ?? []).some((a) => tagIs(x, a)));
        const cur = all.find((x) => tagIs(x, name)) ?? (byAlias.length === 1 ? byAlias[0] : undefined);
        // An alias naming another tag would shadow it in every name lookup.
        const aliases = (t.aliases ?? []).filter((a) => !all.some((x) => x.id !== cur?.id && tagIs(x, a)));
        if (!cur) {
          const { lastId } = s.run(
            "INSERT INTO kb_tags (user_id, name, aliases_json, category, status, updated_at) VALUES (?,?,?,?,?,?)",
            userId,
            name,
            toJson(mergeAliases(name, aliases)),
            t.category?.trim() ?? "",
            t.status ?? "unknown",
            nowISO(),
          );
          return tagById(lastId)!;
        }
        s.run(
          "UPDATE kb_tags SET aliases_json = ?, category = ?, status = ?, updated_at = ? WHERE id = ?",
          toJson(mergeAliases(cur.name, cur.aliases, aliases, tagIs(cur, name) ? [] : [name])),
          t.category?.trim() || cur.category,
          t.status ?? cur.status,
          nowISO(),
          cur.id,
        );
        return tagById(cur.id)!;
      });
    },

    setKbTagStatus(tagId, status) {
      s.run("UPDATE kb_tags SET status = ?, updated_at = ? WHERE id = ?", status, nowISO(), tagId);
      return tagById(tagId);
    },

    listKbStories(userId, tagId) {
      const rows =
        tagId === undefined
          ? s.all("SELECT * FROM kb_stories WHERE user_id = ? ORDER BY id DESC", userId)
          : s.all(
              `SELECT k.* FROM kb_stories k JOIN kb_story_tags st ON st.story_id = k.id
               WHERE k.user_id = ? AND st.tag_id = ? ORDER BY k.id DESC`,
              userId,
              tagId,
            );
      return withTags(rows);
    },

    getKbStory(id) {
      const r = s.get("SELECT * FROM kb_stories WHERE id = ?", id);
      return r ? withTags([r])[0]! : null;
    },

    saveKbStory(st) {
      return s.transaction(() => {
        const vals = [st.title.trim(), st.company, st.period, st.context, st.did, st.result, st.source, st.confirmed, st.hash];
        let id = st.id;
        if (id === undefined) {
          id = s.run(
            `INSERT INTO kb_stories (user_id, title, company, period, context, did, result, source, confirmed, hash, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            st.userId,
            ...vals,
            nowISO(),
            nowISO(),
          ).lastId;
        } else {
          const { changes } = s.run(
            `UPDATE kb_stories SET title=?, company=?, period=?, context=?, did=?, result=?, source=?, confirmed=?, hash=?, updated_at=?
             WHERE id = ?`,
            ...vals,
            nowISO(),
            id,
          );
          if (!changes) throw new Error(`kb story ${id} not found`);
          s.run("DELETE FROM kb_story_tags WHERE story_id = ?", id);
        }
        for (const tagId of new Set(st.tagIds)) s.run("INSERT OR IGNORE INTO kb_story_tags (story_id, tag_id) VALUES (?,?)", id, tagId);
        return repo.getKbStory(id)!;
      });
    },

    deleteKbStory(id) {
      s.run("DELETE FROM kb_stories WHERE id = ?", id);
    },
  };
  return repo;
}
