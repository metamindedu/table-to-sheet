#!/usr/bin/env node
/**
 * 경쟁 확장 리뷰 분류기 — research/reviews.json → research/REVIEW-ANALYSIS.md
 * 키워드 기반(다국어) 분류 후 대표 인용을 뽑는다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'reviews.json'), 'utf8'));

const THEMES = [
  {
    id: 'paywall',
    label: '유료화·행 수 제한',
    re: /subscri|paid|pay\b|paywall|premium|pro feature|charge|billing|250 rows|limit|unlock|유료|결제|구독|제한|плат|подписк|ограничен|pago|paga|assinatura|有料|制限/i,
  },
  {
    id: 'noop',
    label: '클릭해도 동작 안 함',
    re: /doesn'?t work|does not work|not work|nothing happen|do anything|no response|nothing|fail|broken|bug|error|안\s*됨|작동|동작|動作|не работает|no funciona|não funciona/i,
  },
  {
    id: 'pagination',
    label: '전체 표/페이지네이션 캡처 불가',
    re: /scroll|pagina|next page|load more|entire table|whole table|250 rows|10 out of|보이지|스크롤|페이지|全表|не прокруч|no se puede|rolar/i,
  },
  {
    id: 'detect',
    label: '표 감지·유형 한계(동적/div/복잡)',
    re: /not detect|doesn'?t detect|no table|table types?|complex|dynamic|div|merged|colspan|simple tables|only (the )?first|감지|인식|表全体|таблиц/i,
  },
  {
    id: 'data',
    label: '값·서식 오류(숫자/열)',
    re: /1,42|decimal|comma|numeric|number|column|header|format|cell|열|숫자|서식|столб|coluna|columna/i,
  },
  {
    id: 'privacy',
    label: '개인정보·업로드 불신 / 로컬 처리 신뢰',
    re: /upload|server|privacy|safe|secure|local|account|website of theirs|online (table|ocr)|업로드|개인정보|로컬|serwer|en ligne/i,
  },
  {
    id: 'praise',
    label: '칭찬(간편·무료·신뢰)',
    re: /great|love|perfect|excellent|amazing|easy|helpful|works? (great|well|perfect)|recommend|time saving|best|최고|편리|쉬|ありがと|отличн|excelente|muito bom|good/i,
  },
];

const isNegative = (r) => typeof r.stars === 'number' && r.stars <= 3;

const rows = [];
for (const item of data) {
  for (const r of item.reviews) {
    const text = `${r.author} ${r.text}`;
    const hits = THEMES.filter((t) => t.re.test(text)).map((t) => t.id);
    rows.push({ item: item.name, stars: r.stars, author: r.author, text: r.text, hits });
  }
}

const neg = rows.filter(isNegative);
const counts = Object.fromEntries(THEMES.map((t) => [t.id, neg.filter((r) => r.hits.includes(t.id)).length]));
const starDist = [1, 2, 3, 4, 5].map((s) => `${s}★ ${rows.filter((r) => r.stars === s).length}`).join(' · ');

const quotes = (id, limit = 4) =>
  neg
    .filter((r) => r.hits.includes(id))
    .slice(0, limit)
    .map((r) => `- ${r.stars}★ **${r.item}** — “${r.text.replace(/\s+/g, ' ').slice(0, 180)}”`)
    .join('\n');

const positives = rows
  .filter((r) => !isNegative(r))
  .slice(0, 8)
  .map((r) => `- ${r.stars}★ **${r.item}** — “${r.text.replace(/\s+/g, ' ').slice(0, 160)}”`)
  .join('\n');

const THEME_MEANING = {
  paywall: '핵심 기능(대용량·CSV·MD)이 유료',
  noop: '클릭 후 반응 없음/버그',
  pagination: '보이는 행만 캡처, 다음 페이지 불가',
  detect: '동적 표·div-grid·복잡한 표 미지원',
  data: '숫자/천단위/열 매핑 오류',
  privacy: '업로드 방식 불신, 로컬 처리 선호',
  praise: '간편함·무료·신뢰',
};

const md = `# 표 추출 확장 — 경쟁 리뷰 분석

- 수집: Chrome 웹 스토어 공개 리뷰 ${rows.length}건 (경쟁 5개, 2026-11-16)
- 별점 분포: ${starDist}
- 분석 대상: 저평점(≤3★) ${neg.length}건 중심

## 1. 불만 테마 순위 (저평점 리뷰 내 언급 수)

| 순위 | 테마 | 건수 | 의미 |
|---:|---|---:|---|
${THEMES.slice()
  .sort((a, b) => counts[b.id] - counts[a.id])
  .map((t, i) => `| ${i + 1} | ${t.label} | ${counts[t.id]} | ${THEME_MEANING[t.id]} |`)
  .join('\n')}

## 2. 테마별 대표 인용

### 유료화·행 수 제한 (${counts.paywall})
${quotes('paywall', 6)}

### 전체 표/페이지네이션 캡처 불가 (${counts.pagination})
${quotes('pagination', 6)}

### 표 감지·유형 한계 (${counts.detect})
${quotes('detect', 4)}

### 클릭해도 동작 안 함 (${counts.noop})
${quotes('noop', 4)}

### 값·서식 오류 (${counts.data})
${quotes('data', 3)}

### 개인정보·로컬 처리 (${counts.privacy})
${quotes('privacy', 4)}

## 3. 긍정 리뷰에서 확인된 기대 가치

${positives}

## 4. 결론 — 제품 기회

1. **무료 + 로컬 처리**가 가장 강한 차별화. 1위 Table Capture(20만)조차 "핵심 기능 유료화"로 1★을 맞고 있고,
   "업로드/계정 없이 로컬에서 처리"가 5★ 리뷰의 이유로 명시된다.
2. **"보이는 표만" 캡처**가 2위 이하 제품의 공통 실패. 페이지네이션·스크롤·가상 스크롤 표를 끝까지 모으는 기능이 결정적.
3. **동작 안 함** 불만이 많음 → 감지 실패 시 아무 반응 없는 UX가 최대 불만. 원클릭 감지 + 미리보기 + 실패 안내가 필요.
4. **값 오류**(1,420 → 1,42)와 병합셀/헤더 처리 정확도가 신뢰를 좌우.

→ MVP 우선순위: ① 전 기능 무료 ② 페이지네이션 자동 수집 ③ 정확한 값·병합셀 처리 ④ 실패 없는 감지 UX.
`;

writeFileSync(join(here, 'REVIEW-ANALYSIS.md'), md, 'utf8');
console.log(md);
