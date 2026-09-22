// File responses with a path-traversal guard: every served path must resolve under `rootDir`.
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { notFound } from "./errors.js";

export function isUnder(rootDir: string, target: string): boolean {
  const root = resolve(rootDir);
  const t = resolve(target);
  return t === root || t.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Absolute path if it exists as a regular file under rootDir, else null. */
export function safeFile(rootDir: string, target: string): string | null {
  if (!target || !isUnder(rootDir, target)) return null;
  const p = resolve(target);
  if (!existsSync(p)) return null;
  return statSync(p).isFile() ? p : null;
}

export function fileResponse(path: string, contentType: string, headers: Record<string, string> = {}): Response {
  const size = statSync(path).size;
  const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  return new Response(body, {
    headers: { "Content-Type": contentType, "Content-Length": String(size), ...headers },
  });
}

/** Serve `target` if it lives under rootDir, else 404 (never reveals why). */
export function guardedFile(rootDir: string, target: string, contentType: string, headers?: Record<string, string>): Response {
  const p = safeFile(rootDir, target);
  if (!p) throw notFound("file not found");
  return fileResponse(p, contentType, headers);
}
