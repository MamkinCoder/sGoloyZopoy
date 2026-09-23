// fetch() for Telegram through an HTTP CONNECT proxy. On the Pi api.telegram.org is reachable only via
// the VPN proxy, while everything else (hh.ru, career sites) must go direct, so the proxy can't be global.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Duplex } from "node:stream";

/** Telegram's fetch: through SGZ_TG_PROXY / HTTPS_PROXY / ALL_PROXY when set (the Pi), plain fetch otherwise. */
export const telegramFetch = (env: NodeJS.ProcessEnv = process.env): typeof fetch | undefined => {
  const p = env.SGZ_TG_PROXY || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  return p && /^http:\/\//.test(p) ? proxiedFetch(p) : undefined;
};

function proxiedFetch(proxyUrl: string): typeof fetch {
  const proxy = new URL(proxyUrl);
  const agent = new https.Agent({ keepAlive: false });
  // Tunnel each TLS connection through CONNECT host:443.
  agent.createConnection = ((opts: { host?: string; port?: number; servername?: string }, cb: (err: Error | null, s?: Duplex) => void) => {
    const target = `${opts.host}:${opts.port ?? 443}`;
    const req = http.request({ host: proxy.hostname, port: Number(proxy.port) || 80, method: "CONNECT", path: target });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return cb(new Error(`proxy CONNECT ${target}: ${res.statusCode}`));
      cb(null, tls.connect({ socket, servername: opts.servername ?? opts.host }));
    });
    req.on("error", (e) => cb(e));
    req.end();
  }) as unknown as https.Agent["createConnection"];

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = { ...(init?.headers as Record<string, string> | undefined), ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) };
    return new Promise<Response>((resolve, reject) => {
      const req = https.request({ host: url.hostname, path: url.pathname + url.search, method: init?.method ?? "GET", headers, agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502 })));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(body);
    });
  }) as typeof fetch;
}
