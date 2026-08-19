const CACHE_VERSION = "v2";
const STATIC_CACHE = `receipt-app-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `receipt-app-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./currencies.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./maskable-icon-512.png",
];

// 為替レートAPIは常に最新を取りに行くため、SWのキャッシュ対象から除外する
const NEVER_CACHE_HOSTS = ["open.er-api.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return; // ネットワークにそのまま任せる

  const isSameOrigin = url.origin === self.location.origin;
  const isTesseractAsset = /jsdelivr\.net|tessdata|unpkg\.com/.test(url.hostname) || /\.(wasm|traineddata(\.gz)?)$/.test(url.pathname);

  if (isSameOrigin) {
    // アプリ本体は更新をすぐ反映したいので、まずネットワークを試す
    event.respondWith(networkFirst(req));
  } else if (isTesseractAsset) {
    // OCRエンジンの大容量アセットはURL自体がバージョン管理されているためキャッシュ優先でよい
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}
