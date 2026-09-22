// Thin typed wrappers over node:sqlite: statement cache, param coercion, row mappers, transactions.
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";

export type Row = Record<string, SQLOutputValue>;
export type Param = SQLInputValue | boolean | undefined;

const toInput = (p: Param): SQLInputValue => {
  if (p === undefined) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  return p;
};

export class Sql {
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly db: DatabaseSync) {}

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get(sql: string, ...params: Param[]): Row | undefined {
    return this.stmt(sql).get(...params.map(toInput));
  }

  all(sql: string, ...params: Param[]): Row[] {
    return this.stmt(sql).all(...params.map(toInput));
  }

  run(sql: string, ...params: Param[]): { changes: number; lastId: number } {
    const r = this.stmt(sql).run(...params.map(toInput));
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  /** Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.depth--;
    }
  }
}

export const nowISO = (): string => new Date().toISOString();

export type Cell = SQLOutputValue | undefined;

export const num = (v: Cell): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0));
export const numOrNull = (v: Cell): number | null => (v === null || v === undefined ? null : num(v));
export const str = (v: Cell): string => (v === null || v === undefined ? "" : String(v));
export const strOrNull = (v: Cell): string | null => (v === null || v === undefined ? null : String(v));
export const bool = (v: Cell): boolean => num(v) !== 0;

export function json<T>(v: Cell, fallback: T): T {
  if (v === null || v === undefined || v === "") return fallback;
  try {
    const parsed: unknown = JSON.parse(String(v));
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Object columns: `{}` in the DB means "nothing stored" and maps to null. */
export function jsonObjOrNull<T extends object>(v: Cell): T | null {
  const parsed = json<T | null>(v, null);
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) return null;
  return parsed;
}

export const toJson = (v: unknown): string => JSON.stringify(v ?? null);

/** `IN (?,?,?)` placeholder list. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");
