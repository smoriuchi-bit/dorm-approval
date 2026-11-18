/* 画面のファイルを端末に保存し、次から素早く開けるようにする。
   データ（Apps Script とのやりとり）は保存しない。
   画面を更新したときは VERSION の数字を変えてください。 */
const VERSION = 'dorm-v3.0.0';
const SHELL = ['./', 'index.html', 'approve.html', 'assets/app.css', 'assets/app.js', 'assets/vendor/html2canvas.min.js',
  'assets/vendor/jspdf.umd.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;           // Apps Script やフォントはそのまま通す
  // ページ本体と config.js は、まずネットから取りにいき、つながらないときだけ保存分を使う
  if (req.mode === 'navigate' || url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
    return;
  }
  // そのほか（CSS・JS・画像）は保存分をすぐ使う
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
