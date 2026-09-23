import { Hono } from "hono";
import { z } from "zod";
import { clientIp, type AuthService } from "../auth.js";
import { HttpError, unauthorized } from "../errors.js";
import { parseBody } from "../validate.js";

const LoginSchema = z.object({ password: z.string() });

export function authRoutes(auth: AuthService): Hono {
  const r = new Hono();

  r.post("/login", async (c) => {
    const ip = clientIp(c);
    if (auth.limiter.blocked(ip)) throw new HttpError(429, "too many login attempts, try later");
    const { password } = await parseBody(c, LoginSchema);
    if (!auth.checkPassword(password)) {
      auth.limiter.fail(ip);
      throw unauthorized("wrong password");
    }
    auth.limiter.reset(ip);
    auth.issue(c);
    return c.json({ ok: true });
  });

  r.post("/logout", (c) => {
    auth.clear(c);
    return c.json({ ok: true });
  });

  r.get("/me", (c) => c.json({ authenticated: !auth.authRequired || auth.verify(c), auth_required: auth.authRequired }));

  return r;
}
