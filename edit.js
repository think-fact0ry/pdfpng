/* 편집하기 — 받은 서류 위에 도장·서명·글자를 얹는다.
 *
 * 좌표 규율(이 파일 전체의 대전제):
 *   모든 기하값은 "그 페이지 표시폭(dispW)의 배수"로만 저장한다. x도 y도 같은 스칼라로 나누므로
 *   창 크기·화면 배율·페이지 크기가 달라져도 비율이 절대 깨지지 않는다. 화면 픽셀은 어디에도 저장하지 않는다.
 *   높이는 저장하지 않고 원본 종횡비로 매번 계산한다 → 크기 조절이 자동으로 비율 고정이 된다.
 *
 * PDF 좌표계 변환은 pdf.js 뷰포트(convertToPdfPoint)에 맡긴다. 그 함수가 CropBox 오프셋과
 * 페이지 /Rotate 속성을 이미 반영하고, pdf-lib의 drawImage도 같은 절대 좌표 공간을 쓰므로
 * 우리가 따로 보정할 것이 없다. ⚠️ page.setRotation()은 절대 호출하지 않는다(원본 회전이
 * 유지된다는 전제 위에서 역변환이 성립한다). pdf-lib page.getSize()도 쓰지 않는다(MediaBox 기준이라 어긋난다).
 */
export function initEdit(ctx){
  const { pdfjsLib, PDFLib, $, toast, busy, dl, showDone, baseName, DPI,
          getPjs, renderPageCanvas, saveItems, idb, ensureRW, setTab, getOutDir } = ctx;
  const { PDFDocument, rgb, degrees, LineCapStyle } = PDFLib;

  const PT_MM   = 25.4 / 72;      // 1pt를 mm로
  const INK_SW  = 0.0035;         // 펜 굵기(표시폭 배수) — A4에서 약 0.7mm
  const STAMP_W = 0.13;           // 도장 기본 폭 — A4에서 약 27mm(실물 도장 크기대)
  const TEXT_H  = 0.028;          // 글자 기본 높이 — A4에서 약 6mm
  const MIN_W = 0.015, MAX_W = 1.6;

  /* ── 상태 ── */
  let doc = null;        // {name, bytes, pjs, pages:[geo]}
  let assets = [];       // {id, name, type, bytes, natW, natH, url, lastW, temp}
  let objects = [];      // {id, page, type:'image'|'ink', assetId?, u, v, w, pts?, sw?}
  let sel = null, page = 0, tool = 'select', out = 'pdf';
  let undoStack = [], seq = 0, renderGen = 0, curTask = null;

  const uid = () => ++seq;
  const el = {};
  const geoOf = i => doc.pages[i];
  const assetOf = id => assets.find(a => a.id === id);
  const objsOn = p => objects.filter(o => o.page === p);
  /* 이미지 오브젝트의 높이(표시폭 배수) — 종횡비는 원본이 정한다 */
  const objH = o => { const a = assetOf(o.assetId); return a ? o.w * a.natH / a.natW : o.w; };

  /* ══════════ 좌표 변환 ══════════ */

  const vpOf = g => g.vp;

  /* 화면 사각형(표시 pt) → pdf-lib drawImage 인자.
     A = 화면 좌하단(이미지 로컬 원점), 회전각 = 화면 +x 방향이 PDF에서 향하는 각도. */
  function dispToPdfImage(g, dx, dy, dw, dh){
    const vp = vpOf(g);
    const A = vp.convertToPdfPoint(dx, dy + dh);
    const B = vp.convertToPdfPoint(dx + dw, dy + dh);
    const rot = Math.round(Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI);
    return { x: A[0], y: A[1], width: dw, height: dh, rot: ((rot % 360) + 360) % 360 };
  }

  /* 잉크 획 → drawSvgPath용 path.
     pdf-lib은 path에 늘 scale(1,-1)을 걸므로, 각 점을 절대 PDF 좌표로 바꾼 뒤 y만 뒤집어 적으면
     x:0,y:0,rotate:0으로 그대로 앉는다 — 회전·CropBox 추론이 아예 필요 없다. */
  function inkPathD(g, pts){
    const vp = vpOf(g), k = g.dispW;
    const P = pts.map(([u, v]) => vp.convertToPdfPoint(u * k, v * k));
    if (!P.length) return '';
    if (P.length === 1) return `M${P[0][0]} ${-P[0][1]} l0.1 0.1`;
    let d = `M${P[0][0]} ${-P[0][1]}`;
    for (let i = 1; i < P.length - 1; i++){                  // 중점 2차 베지에 = 각지지 않는 곡선
      const mx = (P[i][0] + P[i + 1][0]) / 2, my = (P[i][1] + P[i + 1][1]) / 2;
      d += ` Q${P[i][0]} ${-P[i][1]} ${mx} ${-my}`;
    }
    return d + ` L${P.at(-1)[0]} ${-P.at(-1)[1]}`;
  }

  /* ══════════ 문서 열기 ══════════ */

  async function measurePages(pjsDoc){
    const pages = [];
    for (let i = 0; i < pjsDoc.numPages; i++){
      const p = await pjsDoc.getPage(i + 1);
      const vp = p.getViewport({ scale: 1 });   // 회전·CropBox가 이미 반영된 표시 좌표계
      pages.push({ index: i, vp, view: p.view.slice(), rotate: p.rotate, dispW: vp.width, dispH: vp.height });
    }
    return pages;
  }

  /* 이미지 1장 → 그 이미지 크기의 1페이지 PDF(여백 없음). 이후 경로는 PDF와 완전히 동일하다. */
  async function imageDocBytes(file){
    const bytes = await file.arrayBuffer();
    const out = await PDFDocument.create();
    const img = /\.png$/i.test(file.name) ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    const s = Math.min(595.28 / img.width, 841.89 / img.height, 1);
    const w = img.width * s, h = img.height * s;
    out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    const u = await out.save();
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
  }

  async function loadDoc(file){
    busy(true, '문서를 여는 중이에요');
    try {
      const isPdf = /\.pdf$/i.test(file.name);
      const bytes = isPdf ? await file.arrayBuffer() : await imageDocBytes(file);
      const src = { bytes };
      const pjs = await getPjs(src);                 // getPjs가 .slice(0) 사본을 넘겨 원본 detach를 막는다
      const pages = await measurePages(pjs);
      doc = { name: file.name, bytes, pjs: src.pjs, pages };
      objects = []; undoStack = []; sel = null; page = 0; setTool('select');
      busy(false);
      renderAll();
    } catch (err){
      busy(false); doc = null;
      toast(err && err.name === 'PasswordException' ? '암호가 걸린 PDF예요' : '문서를 열 수 없어요');
    }
  }

  /* ══════════ 도장·서명 이미지(에셋) ══════════ */

  const ASSET_KEY = 'edAssets';

  async function persistAssets(){
    const keep = assets.filter(a => !a.temp)
      .map(a => ({ id: a.id, name: a.name, type: a.type, bytes: a.bytes, natW: a.natW, natH: a.natH, lastW: a.lastW }));
    try { await idb.set(ASSET_KEY, keep); } catch(e){}
  }

  function hydrate(a){
    a.url = URL.createObjectURL(new Blob([a.bytes], { type: a.type === 'png' ? 'image/png' : 'image/jpeg' }));
    return a;
  }

  async function restoreAssets(){
    try {
      const saved = await idb.get(ASSET_KEY);
      if (Array.isArray(saved)){
        assets = saved.map(hydrate);
        seq = Math.max(seq, ...assets.map(a => a.id || 0));
        renderChips();
      }
    } catch(e){}
  }

  async function addAsset(file){
    if (!/\.(png|jpe?g)$/i.test(file.name)){ toast('PNG·JPG 이미지만 넣을 수 있어요'); return null; }
    const bytes = await file.arrayBuffer();
    const type = /\.png$/i.test(file.name) ? 'png' : 'jpg';
    const a = hydrate({ id: uid(), name: file.name, type, bytes, natW: 0, natH: 0, lastW: STAMP_W });
    const img = new Image(); img.src = a.url; await img.decode();
    a.natW = img.naturalWidth; a.natH = img.naturalHeight;
    assets.push(a); await persistAssets(); renderChips();
    return a;
  }

  function removeAsset(id){
    const a = assetOf(id); if (!a) return;
    URL.revokeObjectURL(a.url);
    assets = assets.filter(x => x.id !== id);
    objects = objects.filter(o => o.assetId !== id);
    persistAssets(); renderChips(); syncObjects(); renderRailMarks(); renderFoot();
  }

  function clearAssets(){
    assets.filter(a => !a.temp).forEach(a => URL.revokeObjectURL(a.url));
    const gone = new Set(assets.filter(a => !a.temp).map(a => a.id));
    assets = assets.filter(a => a.temp);
    objects = objects.filter(o => !gone.has(o.assetId));
    persistAssets(); renderChips(); syncObjects(); renderRailMarks(); renderFoot();
    toast('저장해둔 도장을 지웠어요');
  }

  /* 글자 → 투명 PNG 에셋. pdf-lib에 한글 폰트를 실을 필요 없이 이미 로드된 웹폰트를 그대로 쓴다. */
  async function textAsset(text){
    try { await document.fonts.ready; } catch(e){}
    const F = 96, pad = Math.round(F * 0.16);
    const m = document.createElement('canvas').getContext('2d');
    const font = `600 ${F}px 'Pretendard Variable', Pretendard, sans-serif`;
    m.font = font;
    const w = Math.ceil(m.measureText(text).width) + pad * 2;
    const h = Math.ceil(F * 1.34) + pad * 2;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.font = font; g.fillStyle = '#191f28'; g.textBaseline = 'middle';
    g.fillText(text, pad, h / 2);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const bytes = await blob.arrayBuffer();
    const a = hydrate({ id: uid(), name: text, type: 'png', bytes, natW: w, natH: h, lastW: 0, temp: true });
    assets.push(a);
    return a;
  }

  /* ══════════ 오브젝트 조작 ══════════ */

  function snapshot(){
    undoStack.push(JSON.stringify(objects));
    if (undoStack.length > 30) undoStack.shift();
  }
  function undo(){
    if (!undoStack.length) return;
    objects = JSON.parse(undoStack.pop());
    if (!objects.some(o => o.id === sel)) sel = null;
    syncObjects(); renderRailMarks(); renderFoot();
  }

  function place(asset, w){
    const g = geoOf(page);
    const ww = w || asset.lastW || (asset.temp ? (asset.natW / asset.natH) * TEXT_H : STAMP_W);
    const hh = ww * asset.natH / asset.natW;
    snapshot();
    const o = { id: uid(), page, type: 'image', assetId: asset.id,
                u: 0.5 - ww / 2, v: (g.dispH / g.dispW) / 2 - hh / 2, w: ww };
    objects.push(o); sel = o.id;
    syncObjects(); renderRailMarks(); renderFoot();
    return o;
  }

  function stampAllPages(){
    const o = objects.find(x => x.id === sel);
    if (!o || o.type !== 'image') return;
    snapshot();
    let n = 0;
    for (let p = 0; p < doc.pages.length; p++){
      if (p === o.page) continue;
      objects.push({ id: uid(), page: p, type: 'image', assetId: o.assetId, u: o.u, v: o.v, w: o.w });
      n++;
    }
    renderRailMarks(); renderFoot();
    toast(`나머지 ${n}페이지에도 넣었어요`);
  }

  function delSel(){
    if (sel == null) return;
    snapshot();
    objects = objects.filter(o => o.id !== sel);
    sel = null;
    syncObjects(); renderRailMarks(); renderFoot();
  }

  /* ══════════ 그리기(화면) ══════════ */

  /* ⚠️ toggleEmpty가 먼저다 — #edMain이 display:none인 채로 renderStage를 부르면 clientWidth가 0으로 측정된다 */
  function renderAll(){ toggleEmpty(); renderChips(); renderRail(); renderFoot(); renderStage(); }
  function toggleEmpty(){
    const has = !!doc;
    el.empty.style.display = has ? 'none' : '';
    el.main.style.display = has ? '' : 'none';
  }

  const railIO = new IntersectionObserver(es => es.forEach(en => {
    if (en.isIntersecting) railThumb(+en.target.dataset.p, en.target);
  }), { rootMargin: '300px' });

  function renderRail(){
    railIO.disconnect();               // 옛 버튼 관찰이 남으면 IntersectionObserver가 DOM을 붙잡는다
    el.rail.innerHTML = '';
    if (!doc) return;
    doc.pages.forEach((g, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.p = i;
      b.className = i === page ? 'on' : '';
      b.innerHTML = `<div class="rth"></div><div class="rn"><span class="rd"></span><span>${i + 1}</span></div>`;
      b.addEventListener('click', () => setPage(i));
      el.rail.appendChild(b);
      railIO.observe(b);
    });
    renderRailMarks();
  }
  async function railThumb(i, btn){
    if (btn._done) return; btn._done = true;
    try {
      const g = geoOf(i);
      const c = await renderPageCanvas(await doc.pjs, i, 150 / g.dispW);
      const box = btn.querySelector('.rth'); box.innerHTML = ''; box.appendChild(c);
    } catch(e){ btn._done = false; }
  }
  function renderRailMarks(){
    [...el.rail.children].forEach((b, i) => {
      b.classList.toggle('on', i === page);
      b.classList.toggle('has', objects.some(o => o.page === i));
    });
  }

  async function renderStage(){
    if (!doc) return;
    const g = geoOf(page);
    el.page.style.setProperty('--par', (g.dispW / g.dispH).toFixed(6));   // 치수는 CSS가 정한다
    el.ink.setAttribute('viewBox', `0 0 1000 ${(1000 * g.dispH / g.dispW).toFixed(3)}`);
    syncObjects();
    const cssW = el.page.clientWidth || 600;      // 캔버스 해상도용 측정(레이아웃 계산 아님)
    const gen = ++renderGen;
    if (curTask){ try { curTask.cancel(); } catch(e){} curTask = null; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    try {
      const c = await renderPageCanvas(await doc.pjs, page, cssW * dpr / g.dispW, { onTask: t => (curTask = t) });
      if (gen !== renderGen) return;
      el.base.width = c.width; el.base.height = c.height;
      el.base.getContext('2d').drawImage(c, 0, 0);
      c.width = c.height = 0;                       // 사본 즉시 해제 — 스테이지 캔버스는 늘 1장만 산다
    } catch(err){ /* 페이지를 빨리 넘기면 렌더가 취소된다 — 정상 */ }
  }

  function setPage(i){
    if (i === page || !doc) return;
    page = i; sel = null;
    renderRailMarks(); renderStage(); renderFoot();
  }

  /* 오브젝트 DOM·잉크 SVG를 현재 페이지 상태에 맞춘다 */
  function syncObjects(){
    if (!doc) return;
    const g = geoOf(page), asp = g.dispW / g.dispH;
    el.objs.innerHTML = '';
    objsOn(page).filter(o => o.type === 'image').forEach(o => {
      const a = assetOf(o.assetId); if (!a) return;
      const d = document.createElement('div');
      d.className = 'edobj' + (o.id === sel ? ' sel' : '');
      d.dataset.id = o.id;
      d.style.left = (o.u * 100) + '%';
      d.style.top = (o.v * asp * 100) + '%';
      d.style.width = (o.w * 100) + '%';
      d.style.height = (objH(o) * asp * 100) + '%';
      d.innerHTML = `<img src="${a.url}" alt="" draggable="false">
        <span class="edsz"></span>
        <span class="h nw" data-h="nw"></span><span class="h ne" data-h="ne"></span>
        <span class="h sw" data-h="sw"></span><span class="h se" data-h="se"></span>`;
      el.objs.appendChild(d);
    });
    const strokes = objsOn(page).filter(o => o.type === 'ink');
    el.ink.innerHTML = strokes.map(o => {
      const d = o.pts.map(([u, v], i) => `${i ? 'L' : 'M'}${(u * 1000).toFixed(2)} ${(v * 1000).toFixed(2)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="#191f28" stroke-width="${(o.sw * 1000).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('');
  }

  function renderChips(){
    const keep = assets.filter(a => !a.temp);
    el.chips.innerHTML = keep.length
      ? `<span class="lb">저장해둔 도장</span>` + keep.map(a =>
          `<button type="button" class="edchip" data-a="${a.id}"><img class="ci" src="${a.url}" alt="">
             <span class="cn">${escapeHtml(a.name)}</span><span class="cd" data-x="${a.id}" role="button" aria-label="빼기">×</span></button>`
        ).join('') + `<button type="button" class="edchip" id="edChipsClear" style="border-style:dashed"><span class="cn">모두 비우기</span></button>`
      : '';
  }
  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function renderFoot(){
    if (!doc) return;
    const byPage = new Map();
    objects.forEach(o => byPage.set(o.page, (byPage.get(o.page) || 0) + 1));
    const total = objects.length;
    el.cnt.innerHTML = total
      ? `<b>${total}개</b> 넣었어요 · ` + [...byPage.keys()].sort((a, b) => a - b).map(p => `${p + 1}쪽 ${byPage.get(p)}`).join(' · ')
      : `${doc.pages.length}페이지 · 아직 넣은 게 없어요`;
    el.undo.disabled = !undoStack.length;
    el.del.disabled = sel == null;
    el.all.disabled = sel == null || doc.pages.length < 2 || !objects.some(o => o.id === sel && o.type === 'image');
    el.go.textContent = out === 'pdf' ? 'PDF로 저장' : 'PNG로 저장';
    el.go.disabled = !objects.length;
  }

  function setTool(t){
    tool = t;
    el.pen.classList.toggle('on', t === 'pen');
    el.page.classList.toggle('pen', t === 'pen');
    if (t === 'pen'){ sel = null; syncObjects(); renderFoot(); }
  }

  /* ══════════ 포인터 (이동·크기조절·펜) ══════════ */
  /* 전역에서 HTML5 드래그를 막아뒀으므로(index.html: document dragstart preventDefault)
     이동·크기조절·펜은 전부 pointer 이벤트로만 구현한다. */
  function bindPointer(){
    let mode = null, start = null, ink = null;

    const norm = e => {
      const r = el.page.getBoundingClientRect();
      return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.width, w: r.width };
    };

    el.page.addEventListener('pointerdown', e => {
      if (!doc) return;
      if (tool === 'pen'){
        const n = norm(e);
        snapshot();
        ink = { id: uid(), page, type: 'ink', pts: [[n.u, n.v]], sw: INK_SW };
        objects.push(ink); mode = 'ink';
        try { el.page.setPointerCapture(e.pointerId); } catch(_){}
        syncObjects(); e.preventDefault();
        return;
      }
      const h = e.target.closest('.h');
      const box = e.target.closest('.edobj');
      if (!box){ if (sel != null){ sel = null; syncObjects(); renderFoot(); } return; }
      const o = objects.find(x => x.id === +box.dataset.id); if (!o) return;
      sel = o.id; syncObjects(); renderFoot();
      const n = norm(e);
      snapshot();
      start = { u: o.u, v: o.v, w: o.w, pu: n.u, pv: n.v, o, corner: h ? h.dataset.h : null };
      mode = h ? 'size' : 'move';
      el.page.setPointerCapture(e.pointerId);
      if (h) el.objs.querySelector(`.edobj[data-id="${o.id}"]`)?.classList.add('sizing');
      e.preventDefault();
    });

    el.page.addEventListener('pointermove', e => {
      if (!mode) return;
      const n = norm(e);
      if (mode === 'ink'){
        const last = ink.pts[ink.pts.length - 1];
        if (Math.hypot(n.u - last[0], n.v - last[1]) < 0.0015) return;   // 지터·용량 동시 절감
        ink.pts.push([n.u, n.v]);
        syncObjects();
        return;
      }
      const o = start.o, du = n.u - start.pu, dv = n.v - start.pv;
      if (mode === 'move'){ o.u = start.u + du; o.v = start.v + dv; }
      else {
        const asp = objH({ ...o, w: 1 });                                 // 높이/폭 비
        const grow = (start.corner === 'se' || start.corner === 'ne') ? du : -du;
        const w = Math.min(MAX_W, Math.max(MIN_W, start.w + grow));
        const d = start.w - w;
        o.w = w;
        o.u = start.u + (start.corner === 'nw' || start.corner === 'sw' ? d : 0);
        o.v = start.v + (start.corner === 'nw' || start.corner === 'ne' ? d * asp : 0);
        const node = el.objs.querySelector(`.edobj[data-id="${o.id}"]`);
        if (node) node.querySelector('.edsz').textContent = (w * geoOf(page).dispW * PT_MM).toFixed(0) + 'mm';
      }
      const node = el.objs.querySelector(`.edobj[data-id="${o.id}"]`);
      if (node){
        const asp = geoOf(page).dispW / geoOf(page).dispH;
        node.style.left = (o.u * 100) + '%'; node.style.top = (o.v * asp * 100) + '%';
        node.style.width = (o.w * 100) + '%'; node.style.height = (objH(o) * asp * 100) + '%';
        if (mode === 'size') node.classList.add('sizing');
      }
    });

    const end = () => {
      if (!mode) return;
      if (mode === 'ink'){
        if (ink.pts.length < 2 && objects[objects.length - 1] === ink){ objects.pop(); undoStack.pop(); }
        ink = null; syncObjects();
      } else if (mode === 'size'){
        const a = assetOf(start.o.assetId); if (a && !a.temp){ a.lastW = start.o.w; persistAssets(); }
      }
      el.objs.querySelectorAll('.sizing').forEach(n => n.classList.remove('sizing'));
      mode = null; start = null;
      renderRailMarks(); renderFoot();
    };
    el.page.addEventListener('pointerup', end);
    el.page.addEventListener('pointercancel', end);
  }

  /* ══════════ 내보내기 ══════════ */

  /* 알파가 살아 있는 PNG를 그대로 넣는다. 실패(16bit·인터레이스 등)하면 캔버스로 다시 구워 재시도. */
  async function embedAsset(pdf, a, maxPt){
    let bytes = a.bytes, type = a.type;
    const cap = Math.ceil(Math.max(maxPt, 1) * 300 / 72);          // 300dpi면 충분 — 원본 유출 폭도 줄인다
    if (a.natW > cap){
      const bmp = await createImageBitmap(new Blob([a.bytes]));
      const c = document.createElement('canvas');
      c.width = cap; c.height = Math.round(cap * a.natH / a.natW);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bytes = await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer();
      type = 'png';
    }
    try { return type === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes); }
    catch(e){
      const bmp = await createImageBitmap(new Blob([a.bytes]));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return pdf.embedPng(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer());
    }
  }

  async function buildEditedPdf(){
    const pdf = await PDFDocument.load(doc.bytes.slice(0));
    const pages = pdf.getPages();
    const embeds = new Map();                                       // 소스당 embed 1회 — 없으면 파일이 폭증한다
    const maxPt = new Map();
    objects.forEach(o => { if (o.type === 'image')
      maxPt.set(o.assetId, Math.max(maxPt.get(o.assetId) || 0, o.w * geoOf(o.page).dispW)); });

    for (const o of objects){                                       // 배열 순서 = 겹침 순서
      const g = geoOf(o.page), pg = pages[o.page];
      if (!pg) continue;
      if (o.type === 'image'){
        const a = assetOf(o.assetId); if (!a) continue;
        if (!embeds.has(o.assetId)) embeds.set(o.assetId, await embedAsset(pdf, a, maxPt.get(o.assetId)));
        const dw = o.w * g.dispW, dh = objH(o) * g.dispW;
        const r = dispToPdfImage(g, o.u * g.dispW, o.v * g.dispW, dw, dh);
        pg.drawImage(embeds.get(o.assetId), { x: r.x, y: r.y, width: r.width, height: r.height, rotate: degrees(r.rot) });
      } else {
        const d = inkPathD(g, o.pts); if (!d) continue;
        pg.drawSvgPath(d, { x: 0, y: 0, scale: 1, borderColor: rgb(0.098, 0.122, 0.157),
                            borderWidth: o.sw * g.dispW, borderLineCap: LineCapStyle.Round });
      }
    }
    return pdf.save();
  }

  /* PNG 경로는 좌표 변환이 없다 — 뷰포트가 이미 회전·CropBox를 반영해 렌더하므로 폭 배수만 곱하면 된다 */
  async function buildEditedPngs(base){
    const pjs = await doc.pjs, n = doc.pages.length, items = [];
    const bmps = new Map();                                        // 소스당 1회 디코드
    for (let i = 0; i < n; i++){
      const c = await renderPageCanvas(pjs, i, DPI / 72);
      const k = c.width, g2 = c.getContext('2d');
      for (const o of objsOn(i)){
        if (o.type === 'image'){
          const a = assetOf(o.assetId); if (!a) continue;
          if (!bmps.has(a.id)) bmps.set(a.id, await createImageBitmap(new Blob([a.bytes])));
          g2.drawImage(bmps.get(a.id), o.u * k, o.v * k, o.w * k, objH(o) * k);
        } else {
          g2.strokeStyle = '#191f28'; g2.lineWidth = o.sw * k; g2.lineCap = 'round'; g2.lineJoin = 'round';
          g2.beginPath();
          o.pts.forEach(([u, v], j) => j ? g2.lineTo(u * k, v * k) : g2.moveTo(u * k, v * k));
          if (o.pts.length === 1) g2.lineTo(o.pts[0][0] * k + 0.1, o.pts[0][1] * k + 0.1);
          g2.stroke();
        }
      }
      items.push({ name: n === 1 ? `${base}.png` : `${base}-이미지-${i}.png`,
                   blob: await new Promise(r => c.toBlob(r, 'image/png')) });
      c.width = c.height = 0;
    }
    bmps.forEach(b => b.close && b.close());
    return items;
  }

  /* 어떤 도장을 몇 곳에 넣었는지 되읽어준다 — 다른 센터 직인을 찍는 사고를 잡는 유일한 장치 */
  function doneSub(){
    const cnt = new Map();
    objects.forEach(o => { if (o.type === 'image'){ const a = assetOf(o.assetId); if (a && !a.temp) cnt.set(a.name, (cnt.get(a.name) || 0) + 1); } });
    const parts = [...cnt].map(([n, c]) => `'${n}' ${c}곳`);
    const ink = objects.filter(o => o.type === 'ink').length;
    if (ink) parts.push(`서명 ${ink}개`);
    return parts.join(' · ');
  }

  async function save(){
    if (!doc || !objects.length) return;
    const base = baseName(doc.name).replace(/-편집됨$/, '') + '-편집됨';
    if (out === 'pdf'){
      const name = base + '.pdf';
      let fh = null;
      // 저장은 언제나 새 파일 — 원본 스캔본을 덮어쓰면 되돌릴 방법이 없다(변환 탭의 폴더 직저장 경로를 쓰지 않는 이유)
      if ('showSaveFilePicker' in window){
        try { fh = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] }); }
        catch(e){ return; }
      }
      busy(true, 'PDF를 만들고 있어요');
      try {
        const blob = new Blob([await buildEditedPdf()], { type: 'application/pdf' });
        if (fh){ const w = await fh.createWritable(); await w.write(blob); await w.close(); }
        else dl(name, blob);
        busy(false); showDone('PDF를 저장했어요', doneSub(), false);
      } catch(err){ busy(false); toast('PDF를 만드는 데 실패했어요'); }
    } else {
      const dir = getOutDir();
      if (dir && !(await ensureRW(dir))){ toast('폴더 권한을 허용하면 저장할 수 있어요'); return; }
      busy(true, 'PNG를 만들고 있어요');
      try {
        const items = await buildEditedPngs(base);
        const over = await saveItems(items, dir);
        busy(false);
        const subs = [doneSub()];
        if (over) subs.push(`같은 이름 ${over}장은 덮어썼어요`);
        if (!dir) subs.push('다운로드 폴더로 받았어요');
        showDone(`PNG ${items.length}장 저장했어요`, subs.filter(Boolean).join(' · '), false);
      } catch(err){ busy(false); toast('PNG를 만드는 데 실패했어요'); }
    }
  }

  /* ══════════ 드롭·입력 ══════════ */

  async function drop(files){
    const ok = files.filter(f => /\.(pdf|png|jpe?g)$/i.test(f.name));
    if (!ok.length){ toast('PDF·PNG·JPG만 넣을 수 있어요'); return; }
    if (!doc){ await loadDoc(ok[0]); return; }
    const imgs = ok.filter(f => /\.(png|jpe?g)$/i.test(f.name));
    if (imgs.length === ok.length){                       // 문서가 열려 있고 이미지만 떨궜다 = 도장 추가
      for (const f of imgs){ const a = await addAsset(f); if (a) place(a); }
      return;
    }
    pendingDoc = ok.find(f => /\.pdf$/i.test(f.name));
    if (!objects.length) { await loadDoc(pendingDoc); pendingDoc = null; return; }
    el.repSheet.classList.add('on');                       // 편집한 게 있으면 문서 교체는 확인부터
  }
  let pendingDoc = null;

  function reset(){
    doc = null; objects = []; undoStack = []; sel = null; page = 0;
    assets.filter(a => a.temp).forEach(a => URL.revokeObjectURL(a.url));
    assets = assets.filter(a => !a.temp);
    if (curTask){ try { curTask.cancel(); } catch(e){} curTask = null; }
    el.base.width = el.base.height = 0;
    el.objs.innerHTML = ''; el.ink.innerHTML = '';
    toggleEmpty(); renderChips();
  }

  /* ══════════ 배선 ══════════ */

  function wire(){
    Object.assign(el, {
      empty: $('#edEmpty'), main: $('#edMain'), rail: $('#edRail'), cv: $('#edCv'),
      page: $('#edPage'), base: $('#edBase'), ink: $('#edInk'), objs: $('#edObjs'),
      chips: $('#edChips'), cnt: $('#edCnt'), go: $('#edGo'), undo: $('#edUndo'),
      del: $('#edDel'), all: $('#edAll'), pen: $('#edPen'), zone: $('#edZone'),
      repSheet: $('#edResetSheet')
    });

    el.zone.addEventListener('click', () => $('#edInput').click());
    $('#edInput').addEventListener('change', e => { if (e.target.files[0]) loadDoc(e.target.files[0]); e.target.value = ''; });
    $('#edAddImg').addEventListener('click', () => $('#edImg').click());
    $('#edImg').addEventListener('change', async e => {
      for (const f of [...e.target.files]){ const a = await addAsset(f); if (a) place(a); }
      e.target.value = '';
    });

    el.pen.addEventListener('click', () => setTool(tool === 'pen' ? 'select' : 'pen'));
    el.undo.addEventListener('click', undo);
    el.del.addEventListener('click', delSel);
    el.all.addEventListener('click', stampAllPages);

    el.chips.addEventListener('click', e => {
      if (e.target.id === 'edChipsClear' || e.target.closest('#edChipsClear')) return clearAssets();
      const x = e.target.closest('.cd');
      if (x){ e.stopPropagation(); return removeAsset(+x.dataset.x); }
      const chip = e.target.closest('.edchip[data-a]');
      if (chip && doc) place(assetOf(+chip.dataset.a));
      else if (chip) toast('먼저 서류를 열어주세요');
    });

    // 글자 넣기
    $('#edAddTxt').addEventListener('click', () => {
      if (!doc) return toast('먼저 서류를 열어주세요');
      $('#edTxtVal').value = ''; $('#edTxtSheet').classList.add('on');
      setTimeout(() => $('#edTxtVal').focus(), 60);
    });
    const closeTxt = () => $('#edTxtSheet').classList.remove('on');
    $('#edTxtNo').addEventListener('click', closeTxt);
    $('#edTxtOk').addEventListener('click', async () => {
      const v = $('#edTxtVal').value.trim(); if (!v) return closeTxt();
      closeTxt(); place(await textAsset(v));
    });
    $('#edTxtVal').addEventListener('keydown', e => { if (e.key === 'Enter') $('#edTxtOk').click(); });

    // 처음부터 / 문서 교체 확인 (같은 시트를 두 용도로 쓴다)
    $('#edReset').addEventListener('click', () => { pendingDoc = null; el.repSheet.querySelector('.ct2').textContent = '편집한 걸 모두 지우고 처음부터 할까요?'; el.repSheet.classList.add('on'); });
    $('#edResetNo').addEventListener('click', () => { pendingDoc = null; el.repSheet.classList.remove('on'); });
    $('#edResetGo').addEventListener('click', async () => {
      el.repSheet.classList.remove('on');
      const next = pendingDoc; pendingDoc = null;
      reset();
      if (next) await loadDoc(next);
    });

    // 출력 형식 세그 — 기본 PDF
    $('#edOut').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      out = b.dataset.o;
      [...$('#edOut').children].forEach(x => x.classList.toggle('on', x === b));
      renderFoot();
    });
    el.go.addEventListener('click', save);
    // §4.9 비활성 눌림 = shake
    el.go.parentElement.addEventListener('pointerdown', () => {
      if (!doc || objects.length) return;
      el.go.classList.remove('shake'); void el.go.offsetWidth; el.go.classList.add('shake');
    });

    document.addEventListener('keydown', e => {
      if (!doc || !$('#scrEdit').classList.contains('on')) return;
      if (e.target.tagName === 'INPUT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'){ e.preventDefault(); undo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace'){ if (sel != null){ e.preventDefault(); delSel(); } }
      else if (e.key === 'Escape'){ if (tool === 'pen') setTool('select'); else if (sel != null){ sel = null; syncObjects(); renderFoot(); } }
    });

    let rz;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (doc && $('#scrEdit').classList.contains('on')) renderStage(); }, 160); });

    bindPointer();
    restoreAssets();
    // 편집 탭을 처음 열 때 스테이지 크기가 0이면 다시 그린다(숨겨진 동안 clientWidth=0)
    document.querySelectorAll('.hd .seg button').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.t === 'edit' && doc) setTimeout(renderStage, 0);
    }));
  }

  wire();

  return {
    hasDoc: () => !!doc,
    drop, loadDoc, addAsset, place, stampAllPages, delSel, undo, setPage, setTool,
    setOut: v => { out = v; [...$('#edOut').children].forEach(x => x.classList.toggle('on', x.dataset.o === v)); renderFoot(); },
    addInk: (p, pts) => { snapshot(); objects.push({ id: uid(), page: p, type: 'ink', pts, sw: INK_SW }); syncObjects(); renderRailMarks(); renderFoot(); },
    buildPdf: buildEditedPdf, buildPngs: buildEditedPngs, save, reset, clearAssets,
    state: () => ({ doc, assets, objects, sel, page, tool, out, undo: undoStack.length }),
    geom: { measurePages, dispToPdfImage, inkPathD, vpOf, objH }
  };
}
