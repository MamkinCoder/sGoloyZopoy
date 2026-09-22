// Workstream B public surface. Other packages import only these names.
export { createLauncher, chromiumArgs, CHROMIUM_ARGS, VIEWPORT } from "./launcher.js";
export { loadCookies, saveCookies, defaultUserAgent, filterDomain } from "./cookies.js";
export { FakeSession, FakeLauncher, type FakeCall } from "./fake.js";
export { ActionCache, type CacheEntry, type CachedAction, type HostCache } from "./cache.js";
export { adaptLLM } from "./adapter.js";
