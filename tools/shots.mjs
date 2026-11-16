#!/usr/bin/env node
/**
 * UI 스크린샷 — 실제 Chrome + 확장 로드 후 팝업 화면을 캡처한다.
 * 결과: docs/shots/list.png, docs/shots/detail.png
 */
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8873;
const outDir = join(root, 'docs', 'shots');
await mkdir(outDir, { recursive: true });

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
    createReadStream(join(here, '..', 'test', 'fixtures', 'tables.html')).pipe(res);
  })
  .listen(PORT);

const extDir = await mkdtemp(join(tmpdir(), 'ts-shot-'));
await cp(join(root, 'extension'), extDir, { recursive: true });
const mf = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
mf.host_permissions = [`http://127.0.0.1:${PORT}/*`];
await writeFile(join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'],
  defaultViewport: { width: 1200, height: 900 },
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 30000 });
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  const tabId = (await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id))).reduce((a, b) => Math.max(a, b), 0);

  const popup = await browser.newPage();
  await popup.setViewport({ width: 420, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`, { waitUntil: 'load' });
  await popup.waitForSelector('#tableList li', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400));
  await popup.screenshot({ path: join(outDir, 'list.png') });
  console.log('saved', join(outDir, 'list.png'));

  const labels = await popup.$$eval('#tableList .name', (els) => els.map((e) => e.textContent));
  const idx = labels.findIndex((l) => l.includes('상품'));
  await popup.$$eval('#tableList li', (els, i) => els[i].click(), idx);
  await popup.waitForSelector('#preview tr', { timeout: 8000 });
  await popup.evaluate(() => document.getElementById('optNumbers').click());
  await new Promise((r) => setTimeout(r, 300));
  await popup.screenshot({ path: join(outDir, 'detail.png') });
  console.log('saved', join(outDir, 'detail.png'));
} finally {
  await browser.close();
  server.close();
}
