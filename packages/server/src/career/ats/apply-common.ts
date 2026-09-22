import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Answer, Question } from "@sgz/shared";

/** "Иванов Иван Иванович" / "John Smith" → first + last. Single token → last = "". */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0] ?? "", last: "" };
  // Russian profiles are usually written "Фамилия Имя [Отчество]"; latin ones "First Last".
  const cyrillic = /[Ѐ-ӿ]/.test(full);
  if (cyrillic && parts.length >= 2) return { first: parts[1] ?? "", last: parts[0] ?? "" };
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

export async function fileFromPath(path: string, type = "application/pdf"): Promise<File> {
  const bytes = await readFile(path);
  return new File([bytes], basename(path), { type });
}

export const basicAuth = (key: string): string => `Basic ${Buffer.from(`${key}:`).toString("base64")}`;

/** Text the ATS receives for a question given the LLM answer (option index → option label). */
export function answerValues(q: Question, a: Answer | undefined): string[] {
  if (!a) return [];
  const opts = q.options ?? [];
  if (a.option_idxs?.length) return a.option_idxs.map((i) => opts[i]).filter((s): s is string => !!s);
  if (a.option_idx !== undefined) return opts[a.option_idx] ? [opts[a.option_idx] as string] : [];
  return a.text?.trim() ? [a.text.trim()] : [];
}

export const byIdx = (answers: Answer[]): Map<number, Answer> => new Map(answers.map((a) => [a.idx, a]));
