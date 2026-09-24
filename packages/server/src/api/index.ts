// createApp(deps): Hono — the whole HTTP surface: JSON API under /api, SSE run log, embedded SPA.
import { Hono } from "hono";
import { createAuth } from "./auth.js";
import type { ApiDeps } from "./deps.js";
import { errorHandler } from "./errors.js";
import { agentRoutes } from "./routes/agent.js";
import { applicationRoutes } from "./routes/applications.js";
import { authRoutes } from "./routes/auth.js";
import { careerRoutes } from "./routes/career.js";
import { chatRoutes } from "./routes/chats.js";
import { resumeRoutes } from "./routes/resumes.js";
import { runRoutes } from "./routes/runs.js";
import { systemRoutes } from "./routes/system.js";
import { userRoutes } from "./routes/users.js";
import { spaStatic } from "./static.js";

export type { ApiDeps } from "./deps.js";

const PUBLIC_PATHS = new Set(["/api/login", "/api/logout", "/api/me", "/api/health-lite"]);

export function createApp(deps: ApiDeps): Hono {
  const auth = createAuth(deps.cfg.panelPassword);
  const log = deps.log ?? ((line: string) => console.log(line));
  const app = new Hono();

  app.onError(errorHandler);
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    if (c.req.path.startsWith("/api/")) {
      log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - t0}ms`);
    }
  });

  app.use("/api/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/api/health-lite", (c) => c.json({ ok: true, version: deps.version }));

  app.use("/api/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    return auth.guard(c, next);
  });

  const api = new Hono();
  api.route("/", authRoutes(auth));
  api.route("/", userRoutes(deps));
  api.route("/", applicationRoutes(deps));
  api.route("/", resumeRoutes(deps));
  api.route("/", chatRoutes(deps));
  api.route("/", runRoutes(deps));
  api.route("/", careerRoutes(deps));
  api.route("/", systemRoutes(deps));
  api.route("/", agentRoutes(deps));
  app.route("/api", api);

  app.use("*", spaStatic(deps.spaDir));
  return app;
}
