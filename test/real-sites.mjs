#!/usr/bin/env node
/**
 * 실사이트 감지 정확도 검증 — 실제 웹페이지 10곳에서 detect/extract 동작과 성능을 측정한다.
 * 실행: node test/real-sites.mjs [--limit N]
 * 결과는 표로 출력하며, 실패(로딩/차단)도 그대로 보고한다.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, '..', 'extension', 'content', 'table-core.js');
const CORE_SRC = readFileSync(CORE, 'utf8');

const SITES = [
  { name: 'ko.wikipedia 인구', url: 'https://ko.wikipedia.org/wiki/대한민국의_인구' },
  { name: 'en.wikipedia 에디터 비교', url: 'https://en.wikipedia.org/wiki/Comparison_of_text_editors' },
  { name: 'MDN table 요소', url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table' },
  { name: '네이버금융 시세', url: 'https://finance.naver.com/sise/sise_market_sum.naver' },
  { name: '연합뉴스', url: 'https://www.yna.co.kr/' },
  { name: '한겨레', url: 'https://www.hani.co.kr/' },
  { name: 'Hacker News', url: 'https://news.ycombinator.com/' },
  { name: '공공데이터포털', url: 'https://www.data.go.kr/' },
  { name: 'KOSIS', url: 'https://kosis.kr/index/index.do' },
  { name: 'GitHub Trending (표 없음)', url: 'https://github.com/trending' },
];

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

const limitArg = process.argv.indexOf('--limit');
const sites = limitArg > -1 ? SITES.slice(0, Number(process.argv[limitArg + 1]) || SITES.length) : SITES;

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-first-run', '--lang=ko-KR', '--disable-blink-features=AutomationControlled'],
  defaultViewport: { width: 1366, height: 900 },
});

const rows = [];
try {
  for (const site of sites) {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' });
    const result = { name: site.name, status: '', tables: 0, biggest: '', ms: 0, sample: '', error: '' };
    try {
      const resp = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // SPA/지연 표를 기다린다 (최대 8초, 실패해도 계속)
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));

      // 모든 프레임에 주입 (CSP 영향 없는 Runtime.evaluate)
      const frames = page.frames();
      result.frames = frames.length;
      let total = 0;
      let biggest = null;
      let detectMs = 0;
      for (const frame of frames) {
        try {
          await frame.evaluate(CORE_SRC);
        } catch (e) {
          continue;
        }
        const data = await frame.evaluate(() => {
          const t0 = performance.now();
          const list = TableCore.detect(document);
          const ms = Math.round(performance.now() - t0);
          const top = list[0];
          let sample = '';
          if (top) {
            const d = TableCore.extract(top.id);
            sample = (d.rows[0] || []).slice(0, 4).map((c) => c.v).join(' | ').slice(0, 70);
          }
          return { count: list.length, ms, top: top ? { rows: top.rows, cols: top.cols, sample } : null };
        });
        total += data.count;
        detectMs += data.ms;
        if (data.top && (!biggest || data.top.rows * data.top.cols > biggest.rows * biggest.cols)) biggest = data.top;
      }
      result.status = resp ? resp.status() : 'no-response';
      result.tables = total;
      result.ms = detectMs;
      result.biggest = biggest ? `${biggest.rows}×${biggest.cols}` : '';
      result.sample = biggest ? biggest.sample : '';
    } catch (err) {
      result.status = 'ERR';
      result.error = String(err.message || err).slice(0, 90);
    }
    rows.push(result);
    console.log(
      `${result.error ? '❌' : '✅'} ${result.name.padEnd(22)} status=${String(result.status).padEnd(4)} frames=${String(result.frames).padEnd(2)} tables=${String(result.tables).padEnd(3)} biggest=${(result.biggest || '-').padEnd(8)} detect=${result.ms}ms  ${result.error || result.sample}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}

const ok = rows.filter((r) => !r.error);
const withTables = rows.filter((r) => r.tables > 0);
console.log(`\n=== 실사이트 결과: 로딩 ${ok.length}/${rows.length}, 표 감지 ${withTables.length}/${rows.length} ===`);
const slow = rows.filter((r) => r.ms > 500);
if (slow.length) console.log('느린 페이지:', slow.map((r) => `${r.name}=${r.ms}ms`).join(', '));
if (rows.some((r) => r.error)) process.exitCode = 1;
