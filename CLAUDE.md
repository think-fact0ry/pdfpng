# pdfpng — PDF 도구 (변환 · 병합 · 편집) 작업 매뉴얼

> 이 폴더 파일을 읽으면 자동 로드된다. 루트 `CLAUDE.md` §4-3의 상세판.
> `think-fact0ry.github.io/pdfpng/` · **별도 git 레포**(메인 `.gitignore`가 `/pdfpng/` 제외) · SmallPDF 대체(연 168,000원 절감, 2026-07-21 해지 완료).
> 사용자 = 유성·현아 2명, 데스크톱 엣지 표준. **전 과정 브라우저 안에서만 처리** — 아동·인사 정보를 외부로 안 올리는 게 이 도구의 존재 이유다. 서버·시트·백엔드 결합 0, 외부 API 0.

## 파일

| 파일 | 무엇 |
|---|---|
| `index.html` | 앱 전체(CSS·마크업·변환·병합) + `edit.js` import. `:root`의 `TOKENS:START/END` 블록은 **`디자인프리뷰/토큰동기.js`가 생성하는 자동 미러 — 수동 편집 금지** |
| `edit.js` | 편집 탭(도장·서명·글자). `initEdit(ctx)` 하나를 export하고 필요한 것은 전부 ctx로 주입받는다 |
| `sw.js` | 서비스워커. `vendor/`·`icons/`는 cache-first, 나머지는 network-first |
| `manifest.json` | scope `/pdfpng/`, `.pdf` 연결 프로그램(`file_handlers` → `launchQueue`) |
| `vendor/` | pdf.js 4.10.38(+worker) · pdf-lib · Pretendard. **전부 로컬 벤더링 — CDN 도입 금지** |

## 배포 (⚠️ 매번 확인)

1. **`sw.js`의 `CACHE` 버전을 올린다.** 안 올리면 현아 PC에 옛 화면이 그대로 뜨고, 그걸 "왜 안 바뀌지"로 30분 태운다(2026-07-21 로고 사건에서 캐시를 오진한 전례 / 2026-07-28에 이 규칙을 알고도 커밋에서 빠뜨려 보정 커밋을 따로 냄 — 그래서 이 파일이 생겼다).
2. **새 파일을 추가했으면 `sw.js`의 `SHELL` 목록에도 넣는다.** `addAll`은 하나만 404여도 서비스워커 설치 **전체가 실패**하므로 경로를 실측하고 커밋한다.
3. `git push`가 곧 라이브다(GitHub Pages). 반영은 1~3분, 확인은 캐시버스트 curl(`?x=$RANDOM`). 새 파일만 404면 보안·인코딩을 의심하기 전에 `gh run list` 먼저 — 실패면 rerun 말고 빈 커밋으로 fresh run.

## 검증 규율

- **`window.__tf`에 파이프라인 함수를 노출한다** — 이 레포의 확립된 관행. 새 기능도 여기 등록해서 헤드리스로 검증한다.
- 드라이버는 설치 의존성 0으로 만든다: Edge를 `--headless=new --remote-debugging-port`로 띄우고 Node 내장 `WebSocket`으로 CDP `Runtime.evaluate`(puppeteer 불필요). 로컬 정적 서버 필요(ES 모듈은 `file://`에서 막힘).
- **통과 개수만 보지 말고 찍힌 값을 훑는다** — `null`·`undefined`가 보이면 그 테스트는 통과가 아니라 무효다. 상세=[[as-of-time-logic-test-the-boundary]].
- 좌표·정렬은 눈이 아니라 **출력물의 픽셀**로 단언한다(합성 PDF에 단색 이미지를 놓고 재렌더해 바운딩박스 비교).

## 편집 탭 — 손대기 전에 알아야 할 것

- **좌표는 전부 "그 페이지 표시폭(dispW)의 배수"로만 저장한다**(x도 y도 같은 스칼라). 화면 px 저장 금지 — 창 크기·확대에 깨진다. 높이는 저장하지 않고 원본 종횡비로 계산(비율 자동 고정).
- **PDF 좌표 변환은 pdf.js `viewport.convertToPdfPoint`에 위임**한다. CropBox 오프셋과 `/Rotate`가 거기서 이미 반영되고 pdf-lib `drawImage`도 같은 절대 공간을 쓴다. ⛔ `page.setRotation()` 호출 금지(원본 회전 유지가 역변환의 전제) / ⛔ pdf-lib `page.getSize()` 금지(MediaBox 기준이라 CropBox 페이지에서 어긋남 — 기하는 pdf.js `page.view`에서만).
- **같은 이미지를 여러 곳에 → embed는 소스당 1회, draw만 N회**(250KB 도장 10곳 = 2.5MB 폭증 방지).
- **저장은 언제나 새 파일 + 저장 위치 물어보기.** 변환 탭의 폴더 직저장(`getFileHandle(create:true)`)은 같은 이름을 말없이 덮어쓴다 — 편집 결과에 그 경로를 재사용하면 **원본 스캔본이 파괴되고 복구 경로가 없다.**
- 상세 전문=[[pdf-overlay-coordinates]] · UI 원칙=`docs/1_원칙_디자인UX.md §4.9`(액션 버튼 ≠ 모드 도구) · 직인 파일 관리=`docs/2_레퍼런스_직인_미러_위치.md`.

## 건드리면 깨지는 것

- `document.addEventListener('dragstart', e => e.preventDefault())` — `<img>` 썸네일의 네이티브 드래그가 전역 파일 드롭존에 오인 삽입되던 실사고(`aea098a`) 방어. **모든 조작은 pointer 이벤트로** 구현한다.
- 전역 드롭 핸들러의 `curTab()` 분기 — 빠뜨리면 편집 탭에 떨군 파일이 변환 목록으로 샌다.
- `manifest.json`의 `icons`에 **apple-icon-180을 넣지 말 것** — 크로미움이 작업표시줄 소형 아이콘으로 그걸 골라 사각형으로 오염된다(`a209440`). apple-touch는 `<link>`로만.
- pdf.js는 넘긴 ArrayBuffer의 소유권을 가져간다 → 원본 `bytes`는 어디에도 직접 넘기지 말고 항상 `.slice(0)` 사본으로.

## 남은 것 · 정본

할 일·결정 대기의 정본은 **`docs/6_백로그_작업.md` §🖨️**(0-14). 여기 중복 기재하지 않는다.
