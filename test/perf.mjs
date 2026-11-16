#!/usr/bin/env node
/**
 * 성능 점검 — 큰 표/표가 많은 페이지에서 detect() 비용 측정.
 * 기준: detect() < 1500ms, extract() < 2500ms (정보성, 초과 시 경고)
 */
import { existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CORE = join(root, 'extension', 'content', 'table-core.js');
const PORT = 8874;

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

const bigRows = Array.from({ length: 2000 }, (_, i) =>
  `<tr><td>항목 ${i + 1}</td><td>${(i + 1) * 7}</td><td>${(1000 + i).toLocaleString('en-US')}</td><td>2026-11-${String((i % 28) + 1).padStart(2, '0')}</td><td>설명 텍스트 ${i}</td><td>${i % 3 === 0 ? '완료' : '진행'}</td></tr>`,
).join('\n');

const manyTables = Array.from({ length: 30 }, (_, t) =>
  `<h3>표 ${t + 1}</h3><table><thead><tr><th>이름</th><th>값</th><th>비고</th></tr></thead><tbody>${
    Array.from({ length: 12 }, (_, r) => `<tr><td>행 ${r}</td><td>${r * 3}</td><td>설명</td></tr>`).join('')
  }</tbody></table>`,
).join('\n');

const PAGE = `<!doctype html><meta charset="utf-8"><title>perf</title>
<style>table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px;font-size:12px}</style>
<h1>성능 픽스처</h1>
<h2>큰 표 (2000 × 6)</h2>
<table id="big"><thead><tr><th>항목</th><th>수량</th><th>금액</th><th>날짜</th><th>설명</th><th>상태</th></tr></thead><tbody>${bigRows}</tbody></table>
<h2>표 30개</h2>
${manyTables}`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT);

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, defaultViewport: { width: 1400, height: 900 } });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.addScriptTag({ path: CORE });

  const detectMs = await page.evaluate(() => {
    const t0 = performance.now();
    const list = TableCore.detect(document);
    return { ms: Math.round(performance.now() - t0), count: list.length, big: list.find((t) => t.rows > 100)?.rows || 0 };
  });
  console.log(`detect(): ${detectMs.ms}ms, 감지 ${detectMs.count}개, 큰 표 행수 ${detectMs.big}`);

  const extractMs = await page.evaluate(() => {
    const list = TableCore.detect(document);
    const big = list.find((t) => t.rows > 100);
    const t0 = performance.now();
    const data = TableCore.extract(big.id);
    return { ms: Math.round(performance.now() - t0), size: `${data.height}×${data.width}` };
  });
  console.log(`extract(): ${extractMs.ms}ms (${extractMs.size})`);

  const tsvMs = await page.evaluate(() => {
    const list = TableCore.detect(document);
    const big = list.find((t) => t.rows > 100);
    const data = TableCore.extract(big.id);
    const t0 = performance.now();
    const text = TableCore.serialize.tsv(data, { normalizeNumbers: true });
    return { ms: Math.round(performance.now() - t0), kb: Math.round(text.length / 1024) };
  });
  console.log(`TSV 직렬화: ${tsvMs.ms}ms, ${tsvMs.kb}KB`);

  const ok = detectMs.ms < 1500 && extractMs.ms < 2500;
  console.log(ok ? '✅ 성능 기준 통과' : '⚠️ 성능 기준 초과');
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
