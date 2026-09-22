// Tiny fetch + HTML helpers shared by the ATS clients. No DOM, no deps: the Pi has no headroom
// for a parser and the ATS payloads are simple enough for regexes.

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 sgz/0.1";

export const HTTP_TIMEOUT_MS = 15_000;

export async function httpFetch(url: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs}ms: ${url}`)), timeoutMs);
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  if (!headers.has("accept")) headers.set("accept", "application/json, text/html;q=0.8, */*;q=0.5");
  try {
    return await fetch(url, { ...init, headers, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await httpFetch(url, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return getJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getText(url: string): Promise<string> {
  const res = await httpFetch(url, { headers: { accept: "text/html, application/xml;q=0.9, */*;q=0.5" } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return await res.text();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  laquo: "«",
  raquo: "»",
  hellip: "...",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1]?.toLowerCase() === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** HTML → readable plain text: block tags become newlines, entities decoded, whitespace collapsed. */
export function stripHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutBlocks)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Link {
  href: string; // absolute
  text: string;
}

const ANCHOR_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

/** All <a href> in the document resolved against baseUrl; invalid/mailto/js links dropped. */
export function extractLinks(html: string, baseUrl: string, cap = 1000): Link[] {
  const out: Link[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    const raw = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!raw || /^(mailto:|tel:|javascript:|#)/i.test(raw)) continue;
    let href: string;
    try {
      href = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    out.push({ href, text: stripHtml(m[4] ?? "").replace(/\s+/g, " ").trim() });
    if (out.length >= cap) break;
  }
  return out;
}

export const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

export const pathSegments = (url: string): string[] => {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
};

/** Read a text node of a simple XML/HTML tag, CDATA-aware. Returns "" when absent. */
export function tagText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(xml);
  if (!m) return "";
  return (m[1] ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}
