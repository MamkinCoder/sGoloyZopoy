import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { RunBusyError } from "@sgz/shared";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = "unauthorized") => new HttpError(401, msg);
export const notFound = (msg = "not found") => new HttpError(404, msg);

export function formatZod(e: ZodError): string {
  return e.issues.map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`).join("; ");
}

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof ZodError) return c.json({ error: formatZod(err) }, 400);
  if (err instanceof RunBusyError) return c.json({ error: err.message }, 409);
  if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
  console.error("api error:", err);
  return c.json({ error: err.message || "internal error" }, 500);
}
