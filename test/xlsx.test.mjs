#!/usr/bin/env node
/**
 * XLSX 작성기 검증 — 확장 코드로 파일을 만들고, SheetJS(독립 파서)로 다시 읽어 확인한다.
 *  - 값/시트명/병합셀/숫자 타입/잘못된 시트명 정리
 */
import { existsSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CORE = join(root, 'extension', 'content', 'table-core.js');
const XLSX_SRC = join(root, 'extension', 'content', 'xlsx.js');
const FIXTURE = join(here, 'fixtures', 'tables.html');
const OUT = join(root, '.tmp-test');
const PORT = 8875;

const mod = await import('xlsx');
const XLSX = mod.default && mod.default.read ? mod.default : mod;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
}

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

const server = http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(FIXTURE));
  })
  .listen(PORT);

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.addScriptTag({ path: CORE });
  await page.addScriptTag({ path: XLSX_SRC });

  const b64 = await page.evaluate(async () => {
    const list = TableCore.detect(document);
    const merged = list.find((t) => t.label.includes('지역'));
    const simple = list.find((t) => t.label.includes('상품'));

    const m = TableCore.extract(merged.id);
    const rowsMerged = TableCore.__internal.toTextMatrix(m, { fillSpans: false });
    const mergedBytes = await XlsxWriter.build([
      { name: '병합 테스트', rows: rowsMerged, merges: m.merges, headerRows: 2 },
    ]);

    const s = TableCore.extract(simple.id);
    const rowsNum = TableCore.__internal.toTextMatrix(s, { normalizeNumbers: true, fillSpans: true }).map((row) =>
      row.map((v) => {
        const n = TableCore.parseNumber(v);
        return n === null ? v : n;
      }),
    );
    const numBytes = await XlsxWriter.build([
      { name: 'a/b:c', rows: rowsNum, merges: [], headerRows: 1 },
      { name: '두번째', rows: [['x']], merges: [], headerRows: 0 },
    ]);

    const toB64 = (bytes) => {
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    };
    return { merged: toB64(mergedBytes), numeric: toB64(numBytes) };
  });

  const mergedPath = join(OUT, 'merged.xlsx');
  const numericPath = join(OUT, 'numeric.xlsx');
  writeFileSync(mergedPath, Buffer.from(b64.merged, 'base64'));
  writeFileSync(numericPath, Buffer.from(b64.numeric, 'base64'));
  console.log('생성:', mergedPath, Buffer.from(b64.merged, 'base64').length, 'bytes');

  /* ------------------------------------------------ 병합셀 워크북 */
  const wb = XLSX.readFile(mergedPath);
  check('시트명 유지', wb.SheetNames[0] === '병합 테스트', wb.SheetNames.join(','));
  const ws = wb.Sheets[wb.SheetNames[0]];
  check('A1 값', ws.A1?.v === '지역', String(ws.A1?.v));
  check('B1·D1 값', ws.B1?.v === '2025' && ws.D1?.v === '2026', `${ws.B1?.v},${ws.D1?.v}`);
  check('2행 헤더', ws.A2?.v === '1분기' || ws.B2?.v === '1분기', JSON.stringify({ A2: ws.A2?.v, B2: ws.B2?.v }));
  const merges = (ws['!merges'] || []).map((m) => `${XLSX.utils.encode_range(m)}`).sort();
  check('병합 3건 (A1:A2, B1:C1, D1:E1)', merges.join(',') === 'A1:A2,B1:C1,D1:E1', merges.join(','));
  check('본문 값', ws.A3?.v === '서울' && ws.E4?.v === '97', JSON.stringify({ A3: ws.A3?.v, E4: ws.E4?.v }));

  /* ------------------------------------------------ 숫자/시트명 */
  const wb2 = XLSX.readFile(numericPath);
  check('시트명 정리(a/b:c → a b c)', wb2.SheetNames[0] === 'a b c', wb2.SheetNames.join(','));
  check('시트 2개', wb2.SheetNames.length === 2 && wb2.SheetNames[1] === '두번째', wb2.SheetNames.join(','));
  const ws2 = wb2.Sheets[wb2.SheetNames[0]];
  check('숫자 타입 (C2 = 1420000)', ws2.C2?.t === 'n' && ws2.C2?.v === 1420000, `${ws2.C2?.t}:${ws2.C2?.v}`);
  check('머리글 텍스트 유지', ws2.A1?.v === '상품', String(ws2.A1?.v));
  check('금액 열 숫자', ws2.D2?.t === 'n' && ws2.D2?.v === 2840000, `${ws2.D2?.t}:${ws2.D2?.v}`);

  /* ------------------------------------------------ ZIP 무결성 */
  const raw = readFileSync(mergedPath);
  check('ZIP 시그니처', raw[0] === 0x50 && raw[1] === 0x4b, raw.subarray(0, 2).toString('hex'));
  const names = [];
  let p = 0;
  while (raw.readUInt32LE(p) === 0x04034b50) {
    const cs = raw.readUInt32LE(p + 18);
    const nl = raw.readUInt16LE(p + 26);
    const el = raw.readUInt16LE(p + 28);
    names.push(raw.slice(p + 30, p + 30 + nl).toString('utf8'));
    p += 30 + nl + el + cs;
  }
  check('필수 파트 포함', ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'].every((n) => names.includes(n)), names.join(','));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== XLSX 결과: ${results.length - failed.length}/${results.length} 통과 ===`);
if (failed.length) process.exitCode = 1;
