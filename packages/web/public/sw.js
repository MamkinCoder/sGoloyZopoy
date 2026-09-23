// Minimal service worker: makes the panel installable and keeps the hashed /assets/* offline.
// Only /assets/* is cached (cache-first, immutable file names); /api and pages always hit the network.
// The cache name carries the build id from main.tsx (?v=...), and old caches are dropped on activate.
const CACHE = `sgz-assets-${new URL(self.location.href).searchParams.get("v") || "dev"}`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("sgz-assets-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith("/assets/")) return;
  e.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) c.put(e.request, res.clone());
            return res;
          }),
      ),
    ),
  );
});
