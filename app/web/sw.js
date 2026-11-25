/* 여긴할인 서비스워커
 * 같은 사이트 파일은 '네트워크 먼저' → 실패할 때만 저장본 사용
 * (혜택 데이터 data/benefits.json이 바뀌면 다음 실행에 바로 반영되도록)
 * 카카오·오픈스트리트맵 등 외부 요청은 건드리지 않음
 */
const CACHE_VERSION = 'heresale-v39';
const PRECACHE = ['/', '/index.html', '/app.js', '/app.css', '/data/benefits.json', '/data/cards_catalog.json', '/data/logos.json', '/data/promos.json', '/data/points.json', '/manifest.json', '/icon.svg', '/icon-192.png', '/icon-512.png', '/privacy.html', '/location-terms.html', '/terms.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});
