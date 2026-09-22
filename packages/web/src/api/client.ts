import { toast } from "../lib/toast";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const UNAUTHORIZED_EVENT = "sgz:unauthorized";

interface Options {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Do not toast on failure (caller handles it). */
  silent?: boolean;
}

/** JSON fetch wrapper: cookie auth, `{error}` parsing, toast on failure, 401 → global event. */
export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? "GET",
    credentials: "include",
    signal: opts.signal,
    headers: { Accept: "application/json" },
  };
  if (opts.body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const err = new ApiError(0, "Сервер недоступен");
    if (!opts.silent) toast.error(err.message);
    throw err;
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) message = j.error;
    } catch {
      /* not json */
    }
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    } else if (!opts.silent) {
      toast.error(message);
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
};
