// PDF ?꾧뎄 ?쒕퉬?ㅼ썙而???attend/sw.js ?⑦꽩 + vendor(??⑸웾쨌遺덈?)留?cache-first.
// 諛고룷留덈떎 CACHE 踰꾩쟾 ?щ┫ 寃?vendor 援먯껜??踰꾩쟾?쇰줈 媛깆떊??.
var CACHE = 'tf-pdfpng-v15';
var SHELL = [
  './', './index.html', './edit.js', './install.js', './manifest.json',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs', './vendor/pdf-lib.min.js',
  './vendor/PretendardVariable.woff2',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/apple-icon-180.png', './icons/favicon-32.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE)
      .then(function(c){ return c.addAll(SHELL); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys()
      .then(function(keys){ return Promise.all(keys.map(function(k){ if (k !== CACHE) return caches.delete(k); })); })
      .then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  var immutable = url.origin === self.location.origin &&
    (url.pathname.indexOf('/vendor/') !== -1 || url.pathname.indexOf('/icons/') !== -1);
  if (immutable){
    // vendor 2MB+ ??留?濡쒕뱶 ?щ떎?대줈??諛⑹?(?띾룄). 媛깆떊? CACHE 踰꾩쟾 bump濡?
    e.respondWith(
      caches.match(req).then(function(r){
        return r || fetch(req).then(function(res){
          if (res && res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); }); }
          return res;
        });
      })
    );
    return;
  }
  e.respondWith(
    fetch(req).then(function(res){
      if (res && res.ok && url.origin === self.location.origin){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(req, copy); });
      }
      return res;
    }).catch(function(){
      return caches.match(req).then(function(r){ return r || caches.match('./index.html'); });
    })
  );
});
