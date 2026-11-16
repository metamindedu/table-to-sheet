# 표 따오기 (Table to Sheet)

> 웹페이지의 표를 골라 **병합셀·숫자까지 살려** Excel/CSV/클립보드로 내보내는 Chrome 확장.
> **전부 무료, 전부 로컬.** 서버 업로드·계정·행 수 제한이 없습니다.

경쟁 확장 리뷰 분석 근거는 [`research/REVIEW-ANALYSIS.md`](research/REVIEW-ANALYSIS.md),
제품 명세는 [`docs/SPEC.md`](docs/SPEC.md)에 있습니다.

## 설치 (개발자 모드)

1. Chrome 주소창에 `chrome://extensions` 입력
2. 오른쪽 위 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드** → `C:/programs/table-to-sheet/extension` 폴더 선택
4. 툴바의 주황색 표 아이콘 클릭 → 표 목록 확인

## 사용법

- **팝업**: 아이콘 클릭 → 감지된 표 목록(크기·미리보기) → 선택 → 미리보기 확인 → `복사`(Excel에 `Ctrl+V`) 또는 `CSV/JSON/MD`
- **우클릭**: 표 위에서 우클릭 → **표 따오기 — 이 표를 클립보드로 복사** (감지 실패 대비 경로)
- 옵션: 첫 행 머리글, 숫자·날짜 정리, 병합셀 값 채우기 (기본값은 확장 옵션 페이지에서 설정)

## 지원 범위

| 항목 | 지원 |
|---|---|
| `<table>` (thead/tbody/tfoot, rowspan·colspan) | ✅ |
| `role="table" / role="grid"` (ARIA) | ✅ |
| div 기반 카드형 그리드 | ✅ (열 정렬 휴리스틱) |
| 가상화·지연 렌더 표(높이 0) | ✅ (client rect 기준 판정) |
| **iframe 내부 표** | ✅ (모든 프레임 감지·추출) |
| 머리글 감지 | ✅ (`th`, `role=columnheader`) |
| 숫자·통화·날짜 정규화 | ✅ (옵션) |
| **페이지네이션·더 보기 자동 수집** | ✅ (최대 10페이지, 중복 제거·URL 이동 감지) |
| **XLSX (병합셀·숫자 서식·머리글 고정·자동 필터)** | ✅ (의존성 없이 생성) |
| **열 선택·셀 편집** | ✅ (숨긴 열은 모든 내보내기에 반영) |
| 중첩 표 | 상위 표와 하위 표를 각각 후보로 제시 |
| 이미지 속 표 | ❌ 별도 OCR 확장 사용 |

### 실사이트 감지 검증 (2026-11-16, `node test/real-sites.mjs`)

| 사이트 | 결과 | 최대 표 | 감지 |
|---|---|---:|---:|
| ko.wikipedia 인구 | ✅ | 292×11 | 50ms |
| en.wikipedia 에디터 비교 | ✅ | 67×10 | 154ms |
| MDN table 요소 | ✅ | 21×7 | 8ms |
| 네이버금융 시세(SPA) | ✅ | **101×9** | 22ms |
| 연합뉴스 / 한겨레 | ✅ | 15×3 / 4×2 | 12ms / 3ms |
| Hacker News | ✅ | 61×3 | 3ms |
| 공공데이터포털 / KOSIS | ✅ | 5×3 / 10×2 | 8ms / 12ms |
| GitHub Trending (표 없음) | ✅ 0개(정상) | - | 2ms |

## 권한과 개인정보

- 요청 권한: `activeTab`, `scripting`, `storage`, `downloads`, `contextMenus`, `clipboardWrite`
- **host_permissions 없음** — 사용자가 아이콘을 누른 탭에만 스크립트를 주입합니다.
- 네트워크 요청 0건: 표는 브라우저 메모리에서만 처리되고 어디로도 전송되지 않습니다.
  (E2E 테스트가 외부 요청 0건을 검사합니다.)
- 개인정보처리방침: https://metamindedu.github.io/table-to-sheet/privacy.html

## 링크

- 소스: https://github.com/metamindedu/table-to-sheet
- 개인정보처리방침: https://metamindedu.github.io/table-to-sheet/privacy.html
- 문의: metamind@kakao.com

## 테스트

```bash
npm install
node test/core.test.mjs      # 감지·병합셀·정규화·직렬화 (실제 Chrome DOM) — 25 checks
node test/xlsx.test.mjs      # XLSX 생성 → SheetJS(독립 파서)로 재검증 — 13 checks
node test/e2e.test.mjs       # 확장 로드 → 팝업 UI → 클립보드/다운로드/수집/iframe — 27 checks
node test/perf.mjs           # 2000행 표 + 표 30개 성능
node test/real-sites.mjs     # 실제 웹사이트 10곳 감지 검증
```

E2E는 테스트용 임시 복사본에만 `host_permissions`를 주입합니다(배포 매니페스트는 최소 권한 유지).

## 사용 팁

- **Excel 파일**: `병합셀 값 채우기`가 켜져 있으면 값을 모든 칸에 채우고, 끄면 실제 병합셀로 저장합니다.
- **페이지 수집**: 페이지네이션·더 보기 표에서 `⟳ 다음 페이지까지 수집`을 누르면 최대 10페이지를 합칩니다.
  URL이 바뀌는(서버 이동) 페이지네이션은 안전하게 중단합니다.
- **iframe**: 금융·공공 사이트처럼 표가 iframe 안에 있어도 목록에 `· frame` 배지로 표시됩니다.

## 파일 구조

```
extension/
  manifest.json            MV3 (무빌드, 순수 JS)
  background.js            컨텍스트 메뉴
  content/table-core.js    감지·추출·정규화·직렬화 (chrome 비의존, 테스트 가능)
  content/content.js       메시지 글루 + 토스트
  popup/popup.html|css|js  목록·미리보기·내보내기
  options/options.html|js  기본값 설정
  icons/                   16/32/48/128 (tools/make-icons.py 생성)
test/                      core·e2e 테스트 + 픽스처
research/                  경쟁 리뷰 수집/분석
docs/                      SPEC, 스크린샷
tools/                     아이콘 생성, 스크린샷, 패키징
```

## 로드맵

- ~~**M2**: XLSX(병합셀 유지), 컨텍스트 메뉴 검증~~ ✅ (0.2.0)
- ~~**M3**: 페이지네이션·더 보기 자동 수집, iframe 지원~~ ✅ (0.2.0)
- **다음**: 열 선택/숨김, 셀 편집 후 내보내기, 다중 표 시트 일괄 내보내기
- **M4**: 스토어 제출(에셋·개인정보 폼)
