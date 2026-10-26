/* Service worker: keeps the app shell available offline.
   Live ETA requests always go to the network and are never cached. */

const CACHE = "b3a-shell-v2";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

/* A cached copy of the app page must be at least this big; anything smaller
   is a truncated or empty body and must never replace a good copy. */
const MIN_PAGE_BYTES = 2000;
const MIN_ASSET_BYTES = 200;

/* Shown when the app is opened offline and no cached copy is available. */
const OFFLINE_PAGE = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b7a75">
<title>離線 Offline · B3A 富泰邨 ⇄ 深圳灣口岸</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#eef2f7;color:#1b2430;padding:24px;
       font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",Roboto,sans-serif}
  .box{background:#fff;border:1px solid #dde5ee;border-radius:16px;padding:24px;max-width:420px;
       box-shadow:0 8px 24px rgba(16,32,48,.08);text-align:center}
  h1{font-size:1.1rem;margin:0 0 8px}
  p{font-size:.88rem;color:#697586;line-height:1.6;margin:0 0 8px}
  button{margin-top:12px;background:#0b7a75;color:#fff;border:0;border-radius:10px;
         padding:10px 16px;font-size:.9rem;font-weight:800}
</style>
</head>
<body>
  <div class="box">
    <h1>暫時離線 · Offline</h1>
    <p>未能連接網絡，所以未能取得實時到站時間。<br>
       No connection, so live arrival times are unavailable.</p>
    <p>連線後再開一次即可 · Reopen the app once you are back online.</p>
    <button onclick="location.reload()">重試 · Retry</button>
  </div>
</body>
</html>`;

/* Store a response safely.
   - buffered first: streaming bodies can fail to be stored (iOS Safari)
   - tiny/empty or non-OK responses are dropped, so a broken fetch can never
     overwrite the good copy already in the cache */
async function stash(req, res, minBytes) {
  try {
    const method = typeof req === "string" ? "GET" : req.method;
    if (!res || !res.ok || res.type === "opaque" || method !== "GET") return;
    const buf = await res.clone().arrayBuffer();
    if (!buf || buf.byteLength < minBytes) return;
    const copy = new Response(buf, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers
    });
    const cache = await caches.open(CACHE);
    await cache.put(req, copy);
  } catch (_) { /* storage is best effort */ }
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    // fetch one by one so a single failure cannot abort the whole install
    await Promise.all(SHELL.map(async (path) => {
      try {
        const url = new URL(path, self.location.href).href;
        const rq = new Request(url);
        const res = await fetch(rq, { cache: "no-store" });
        await stash(rq, res, path.endsWith("index.html") || path === "./" ? MIN_PAGE_BYTES : MIN_ASSET_BYTES);
      } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // live API -> straight to network

  const isPage = req.mode === "navigate" ||
                 url.pathname.endsWith("/") ||
                 url.pathname.endsWith("index.html");

  /* The page itself is network-first so any update shows up right away,
     but a cached copy still lets the app open with no connection. */
  if (isPage) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          await stash(req, res, MIN_PAGE_BYTES);
          return res;
        }
        throw new Error("HTTP " + (res ? res.status : "?"));
      } catch (_) {
        const hit = (await caches.match(req)) ||
                    (await caches.match(new URL("./index.html", self.location.href).href));
        if (hit) return hit;
        return new Response(OFFLINE_PAGE, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
    })());
    return;
  }

  /* Icons and other shell files almost never change: cache-first. */
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      await stash(req, res, MIN_ASSET_BYTES);
      return res;
    } catch (err) {
      throw err;
    }
  })());
});
