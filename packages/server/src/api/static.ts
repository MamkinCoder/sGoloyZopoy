// Embedded SPA: packages/server/spa (copied from packages/web/dist at build time). Non-/api GETs
// fall back to index.html so client-side routes deep-link. Hashed /assets/* get immutable caching.
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MiddlewareHandler } from "hono";
import { fileResponse, safeFile } from "./files.js";

export const defaultSpaDir = (): string => fileURLToPath(new URL("../../spa/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

export function spaStatic(spaDir: string = defaultSpaDir()): MiddlewareHandler {
  const root = resolve(spaDir);
  const index = join(root, "index.html");
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    if (urlPath.startsWith("/api/") || urlPath === "/api") return next();

    const file = urlPath === "/" ? null : safeFile(root, join(root, urlPath));
    if (file) {
      const immutable = urlPath.startsWith("/assets/");
      return fileResponse(file, MIME[extname(file).toLowerCase()] ?? "application/octet-stream", {
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }
    if (extname(urlPath) && urlPath !== "/") return c.json({ error: "not found" }, 404);
    if (!existsSync(index)) return c.text("SPA not built: run `pnpm build` (see docs/api.md, Build)", 503);
    return fileResponse(index, MIME[".html"]!, { "Cache-Control": "no-cache" });
  };
}
