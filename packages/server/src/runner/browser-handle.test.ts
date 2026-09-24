import { describe, expect, it, vi } from "vitest";
import type { BrowserSession, User } from "@sgz/shared";
import { createBrowserHandle } from "./context.js";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("createBrowserHandle", () => {
  it("a new Chrome on the profile waits until a fire-and-forget close finished", async () => {
    let closed = () => undefined as void;
    const order: string[] = [];
    const session = (n: number) => ({ close: () => new Promise<void>((r) => (closed = () => (order.push(`closed ${n}`), r()))) }) as unknown as BrowserSession;
    let n = 0;
    const launcher = { launch: vi.fn(async () => (order.push(`launch ${++n}`), session(n))) };
    const b = createBrowserHandle({ cfg: { dataDir: "/tmp/sgz-bh", chromiumBin: "", userAgent: "" } as never, launcher, hh: {} as never, habr: null }, { profileDir: () => "/tmp/p", snapshotDir: "/tmp/s", log: silent });
    const user = { slug: "y" } as User;
    await b.open(user);
    void b.close(); // the agent's idle close
    const next = b.open(user);
    await Promise.resolve();
    expect(launcher.launch).toHaveBeenCalledTimes(1);
    closed();
    await next;
    expect(order).toEqual(["launch 1", "closed 1", "launch 2"]);
  });
});
