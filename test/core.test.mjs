#!/usr/bin/env node
/**
 * TableCore 단위/E2E 테스트 — 실제 Chrome + 실제 DOM
 *  - 표 감지(테이블/ARIA/div-grid), 병합셀 그리드, 값 정규화, 직렬화(TSV/CSV/JSON/MD)
 */
import { existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CORE = join(root, 'extension', 'content', 'table-core.js');
const FIXTURE = join(here, 'fixtures', 'tables.html');
const PORT = 8871;

function findChrome() {
  const base = join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  const found = [];
  try {
    for (const d of readdirSync(base)) {
      const p = join(base, d, 'chrome-win64', 'chrome.exe');
      if (existsSync(p)) found.push({ d, p });
    }
  } catch {}
  const num = (s) => (s.match(/\d+/g) || []).map(Number);
  found.sort((a, b) => {
    const av = num(a.d);
    const bv = num(b.d);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const x = (bv[i] || 0) - (av[i] || 0);
      if (x) return x;
    }
    return 0;
  });
  return found[0]?.p || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
}

const server = http
  .createServer((req, res) => {
    if (!existsSync(FIXTURE)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    createReadStream(FIXTURE).pipe(res);
  })
  .listen(PORT);

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-first-run', '--hide-scrollbars'],
  defaultViewport: { width: 1200, height: 900 },
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.addScriptTag({ path: CORE });

  const detected = await page.evaluate(() => TableCore.detect(document).map(({ element, ...rest }) => rest));
  console.log('detected:', detected.map((d) => `${d.kind}:${d.rows}x${d.cols}:${d.label}`).join(' | '));

  const byKind = (kind) => detected.filter((t) => t.kind === kind);
  check('표 4개 감지 (table 2 + div 1 + role 1)', detected.length === 4, `count=${detected.length}`);
  check('레이아웃 표 제외', !detected.some((t) => /레이아웃|왼쪽 메뉴/.test(t.label)), detected.map((t) => t.label).join(' / '));

  // 1) 기본 표
  const simple = await page.evaluate(() => {
    const list = TableCore.detect(document);
    const t = list.find((x) => x.label.includes('상품'));
    return { id: t?.id, data: t ? TableCore.extract(t.id) : null };
  });
  check('기본 표 4×4', !!simple.data && simple.data.height === 4 && simple.data.width === 4, simple.data ? `${simple.data.height}×${simple.data.width}` : 'none');
  check('기본 표 값', simple.data?.rows?.[1]?.[0]?.v === '노트북' && simple.data.rows[1][2].v === '1,420,000', JSON.stringify(simple.data?.rows?.[1]?.map((c) => c.v)));
  const tsvSimple = await page.evaluate((id) => TableCore.serialize.tsv(TableCore.extract(id), { normalizeNumbers: true }), simple.id);
  check('TSV 숫자 정규화 (1,420,000 → 1420000)', tsvSimple.split('\n')[1].split('\t')[2] === '1420000', tsvSimple.split('\n')[1]);
  const csvSimple = await page.evaluate((id) => TableCore.serialize.csv(TableCore.extract(id), {}), simple.id);
  check('CSV 머리글', csvSimple.split('\r\n')[0] === '상품,수량,단가,합계', csvSimple.split('\r\n')[0]);

  // 2) 병합셀
  const merged = await page.evaluate(() => {
    const list = TableCore.detect(document);
    const t = list.find((x) => x.label.includes('지역'));
    const data = TableCore.extract(t.id);
    return { data, tsv: TableCore.serialize.tsv(data, { fillSpans: true }), tsvNoFill: TableCore.serialize.tsv(data, { fillSpans: false }) };
  });
  check('병합셀 논리 크기 4×5', merged.data.height === 4 && merged.data.width === 5, `${merged.data.height}×${merged.data.width}`);
  check('병합 정보 3건 (rowspan 1 + colspan 2)', merged.data.merges.length === 3, JSON.stringify(merged.data.merges));
  check('rowspan 앵커 값', merged.data.rows[0][0].v === '지역' && merged.data.rows[1][0].v === '', JSON.stringify([merged.data.rows[0][0].v, merged.data.rows[1][0].v]));
  const fillRow0 = merged.tsv.split('\n')[0].split('\t');
  check('병합셀 채우기(2025·2026 반복)', fillRow0.join('|') === '지역|2025|2025|2026|2026', fillRow0.join('|'));
  const noFillRow0 = merged.tsvNoFill.split('\n')[0].split('\t');
  check('병합셀 채우기 끄기', noFillRow0.join('|') === '지역|2025||2026|', noFillRow0.join('|'));

  // 3) div 그리드
  const divGrid = await page.evaluate(() => {
    const list = TableCore.detect(document);
    const t = list.find((x) => x.kind === 'div');
    return t ? { label: t.label, data: TableCore.extract(t.id) } : null;
  });
  check('div 그리드 감지 4×3', !!divGrid && divGrid.data.height === 4 && divGrid.data.width === 3, divGrid ? `${divGrid.data.height}×${divGrid.data.width}` : 'none');
  check('div 그리드 값', divGrid?.data?.rows?.[1]?.[0]?.v === '김민수', JSON.stringify(divGrid?.data?.rows?.[1]?.map((c) => c.v)));

  // 4) ARIA table
  const role = await page.evaluate(() => {
    const list = TableCore.detect(document);
    const t = list.find((x) => x.kind === 'role');
    return t ? { data: TableCore.extract(t.id) } : null;
  });
  check('ARIA 표 3×3 + 머리글 플래그', !!role && role.data.height === 3 && role.data.width === 3 && role.data.rows[0][0].h === true, role ? `${role.data.height}×${role.data.width}` : 'none');

  // 5) 직렬화 escaping
  const escaping = await page.evaluate((id) => {
    const data = TableCore.extract(id);
    const clone = JSON.parse(JSON.stringify(data));
    clone.rows[1][0].v = '쉼표, 있음';
    clone.rows[1][1].v = '따옴표 "포함"';
    return {
      csv: TableCore.serialize.csv(clone, {}),
      md: TableCore.serialize.markdown(clone, {}),
      json: TableCore.serialize.json(clone, {}),
    };
  }, simple.id);
  check('CSV 이스케이프', escaping.csv.includes('"쉼표, 있음"') && escaping.csv.includes('"따옴표 ""포함"""'), escaping.csv.split('\r\n')[1]);
  check('Markdown 표 생성', escaping.md.startsWith('| 상품 |') && escaping.md.includes('| --- |'), escaping.md.split('\n')[0]);
  check('JSON 키 매핑', JSON.parse(escaping.json)[0].상품 === '쉼표, 있음', JSON.stringify(JSON.parse(escaping.json)[0]).slice(0, 80));

  // 6) 값 정규화 함수
  const norm = await page.evaluate(() => ({
    n1: TableCore.normalizeValue('1,420', { normalizeNumbers: true }),
    n2: TableCore.normalizeValue('₩2,840,000', { normalizeNumbers: true }),
    n3: TableCore.normalizeValue('2026. 11. 16.', { normalizeDates: true }),
    n4: TableCore.normalizeValue('1,420', {}),
    d1: TableCore.parseDate('2026/1/5'),
    raw: TableCore.normalizeValue('  가\u00a0나\u200b  ', {}),
  }));
  check('숫자 정규화', norm.n1 === '1420' && norm.n2 === '2840000', JSON.stringify(norm));
  check('날짜 정규화', norm.n3 === '2026-11-16' && norm.d1 === '2026-01-05', JSON.stringify([norm.n3, norm.d1]));
  check('정규화 꺼짐 시 원본 유지', norm.n4 === '1,420', norm.n4);
  check('NBSP/제로폭/공백 정리', norm.raw === '가 나', JSON.stringify(norm.raw));

  // 7) 숫자 파싱 회귀 (쉼표 없는 4자리+, 잘못된 쉼표 거부)
  const numbers = await page.evaluate(() => ({
    plain: TableCore.normalizeValue('1420000', { normalizeNumbers: true }),
    plain4: TableCore.parseNumber('1234'),
    badComma: TableCore.parseNumber('1,42'),
    phone: TableCore.parseNumber('010-1234-5678'),
    date: TableCore.parseNumber('2026-11-01'),
    percent: TableCore.parseNumber('12.5%'),
    negative: TableCore.parseNumber('-3,500'),
    unit: TableCore.parseNumber('1,420개'),
  }));
  check('쉼표 없는 4자리 숫자', numbers.plain === '1420000' && numbers.plain4 === 1234, JSON.stringify(numbers));
  check('잘못된 쉼표/전화번호/날짜 거부', numbers.badComma === null && numbers.phone === null && numbers.date === null, JSON.stringify([numbers.badComma, numbers.phone, numbers.date]));
  check('퍼센트/음수/단위', numbers.percent === 0.125 && numbers.negative === -3500 && numbers.unit === 1420, JSON.stringify([numbers.percent, numbers.negative, numbers.unit]));

  // 8) 컨텍스트 메뉴용 nearest
  const nearest = await page.evaluate(() => {
    const td = document.querySelector('#t-simple tbody td');
    const el = TableCore.nearestTableElement(td);
    return { tag: el?.tagName, id: el?.id };
  });
  check('nearestTableElement', nearest.tag === 'TABLE' && nearest.id === 't-simple', JSON.stringify(nearest));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 결과: ${results.length - failed.length}/${results.length} 통과 ===`);
if (failed.length) process.exitCode = 1;
