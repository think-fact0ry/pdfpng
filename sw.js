// PDF 도구 서비스워커 — attend/sw.js 패턴 + vendor(대용량·불변)만 cache-first.
// 배포마다 CACHE 버전을 올릴 것. vendor 교체도 이 버전으로 갱신된다.
var CACHE = 'tf-pdfpng-v19';   // 11-08 토스트 문구 가운뎃점 → 두 문장, 콤마(유성 「토스트 문구 속 가운뎃점 수정해」). v18 11-08 토스트 = docs/1 §5.5 진회색 알약(유성 「초록 바탕 성공 토스트는 진회색+초록원으로 바꾸고, 나머지는 모두 권장대로」). v17 11-07 green100~400 새 값(유성 「green100 전부 맞추기」 → 「200, 300, 400도 바꿀 것」 → 「Go」)
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
    // vendor 2MB+ 는 매 로드 재다운로드 방지(속도). 갱신은 CACHE 버전 bump로.
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
