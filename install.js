// install.js — '앱으로 설치' 안내 바 + 설치 방법 카드. attend/install.js 패턴의 데스크톱판.
//   동작: 이미 앱(standalone)이면 아무것도 안 함. 브라우저로 열렸으면 하단 바를 띄우고,
//         '설치' = beforeinstallprompt 있으면 네이티브 설치창 / 없으면 기기별 수동 안내.
(function(){
  if (window.__tfinstall) return; window.__tfinstall = true;

  // 서비스워커 등록 = 설치 가능(앱) 요건. 없으면 '설치'가 바로가기만 만든다.
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js'); } catch(e){} }

  function installed(){
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  if (installed()) return;

  var css = document.createElement('style');
  css.textContent =
  '.tfi-bar{position:fixed;left:50%;transform:translateX(-50%);width:min(560px,calc(100% - 24px));bottom:calc(14px + env(safe-area-inset-bottom));z-index:600;display:none;align-items:center;gap:10px;background:#3a8a5f;color:#fff;border-radius:16px;padding:13px 14px 13px 18px;box-shadow:0 8px 24px rgba(58,138,95,.35);font-family:inherit;}'+
  '.tfi-bar.show{display:flex;}'+
  '.tfi-bar .t{flex:1;font-size:14.5px;font-weight:600;letter-spacing:-.3px;line-height:1.4;}'+
  '.tfi-bar button{font-family:inherit;cursor:pointer;border:none;}'+
  '.tfi-bar .add{font-size:14px;font-weight:700;border-radius:11px;padding:10px 16px;background:#fff;color:#2f6f4d;}'+
  '.tfi-bar .add:active{background:#eef0f3;}'+
  '.tfi-bar .x{background:transparent;color:#fff;font-size:20px;padding:4px 6px;opacity:.85;}'+
  '.tfi-dim{position:fixed;inset:0;z-index:700;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .2s;}'+
  '.tfi-dim.on{opacity:1;pointer-events:auto;}'+
  '.tfi-card{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);z-index:701;width:min(380px,88vw);background:#fff;border-radius:20px;padding:24px 22px 20px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;box-shadow:0 12px 40px rgba(0,0,0,.2);font-family:inherit;}'+
  '.tfi-card.on{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1);}'+
  '.tfi-card h3{font-size:18px;font-weight:700;letter-spacing:-.4px;margin:0 0 14px;}'+
  '.tfi-card ol{margin:0 0 18px;padding-left:22px;}'+
  '.tfi-card li{font-size:15px;color:#4e5968;font-weight:500;line-height:1.75;word-break:keep-all;}'+
  '.tfi-card li b{color:#2f6f4d;font-weight:700;}'+
  '.tfi-card .done{width:100%;font-size:17px;font-weight:700;padding:17px;border-radius:15px;border:none;background:#3a8a5f;color:#fff;cursor:pointer;}'+
  '.tfi-card .done:active{background:#2f6f4d;}';
  document.head.appendChild(css);

  var bar = document.createElement('div'); bar.className = 'tfi-bar';
  bar.innerHTML = '<div class="t">앱으로 설치할까요? 작업표시줄에 고정해 쓸 수 있어요.</div><button class="add" type="button">설치</button><button class="x" type="button" aria-label="닫기">×</button>';
  var dim = document.createElement('div'); dim.className = 'tfi-dim';
  var card = document.createElement('div'); card.className = 'tfi-card';
  card.innerHTML = '<h3>앱으로 설치하기</h3><ol></ol><button class="done" type="button">알겠어요</button>';
  document.body.appendChild(bar); document.body.appendChild(dim); document.body.appendChild(card);

  var btn = bar.querySelector('.add'), x = bar.querySelector('.x');
  var steps = card.querySelector('ol'), done = card.querySelector('.done');
  var deferred = null;

  function openGuide(){
    steps.innerHTML = [
      '오른쪽 위 <b>⋮</b>(점 3개)를 눌러요',
      "<b>'앱'</b> → <b>'이 사이트를 앱으로 설치'</b>를 눌러요",
      "설치 창에서 <b>'작업 표시줄에 고정'</b>을 체크하면 끝이에요"
    ].map(function(s){ return '<li>'+s+'</li>'; }).join('');
    dim.classList.add('on'); card.classList.add('on');
  }
  function closeGuide(){ dim.classList.remove('on'); card.classList.remove('on'); }
  done.addEventListener('click', closeGuide);
  dim.addEventListener('click', closeGuide);

  window.addEventListener('beforeinstallprompt', function(e){ e.preventDefault(); deferred = e; if (!installed()) bar.classList.add('show'); });
  btn.addEventListener('click', function(){
    if (deferred){ deferred.prompt(); deferred.userChoice.then(function(){ deferred = null; bar.classList.remove('show'); }); }
    else { openGuide(); }
  });
  x.addEventListener('click', function(){ bar.classList.remove('show'); try{ sessionStorage.setItem('tf_install_x','1'); }catch(e){} });
  window.addEventListener('appinstalled', function(){ bar.classList.remove('show'); deferred = null; });

  function maybeShow(){
    var dismissed = false; try{ dismissed = sessionStorage.getItem('tf_install_x') === '1'; }catch(e){}
    if (!installed() && !dismissed) bar.classList.add('show');
  }
  setTimeout(maybeShow, 1200);
})();
