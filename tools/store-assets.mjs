#!/usr/bin/env node
/**
 * 스토어 자산 생성 — 실제 확장 팝업을 캡처해 1280×800 스크린샷과 프로모 타일을 만든다.
 * 결과: store/assets/*.png
 */
import { cp, mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { createReadStream, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = join(root, 'store', 'assets');
await mkdir(outDir, { recursive: true });
const PORT = 8876;

const server = http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    createReadStream(join(root, 'test', 'fixtures', 'tables.html')).pipe(res);
  })
  .listen(PORT);

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

const extDir = await mkdtemp(join(tmpdir(), 'ts-assets-'));
await cp(join(root, 'extension'), extDir, { recursive: true });
const mf = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
mf.host_permissions = [`http://127.0.0.1:${PORT}/*`];
await writeFile(join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', '--font-render-hinting=none'],
  defaultViewport: { width: 1280, height: 800 },
});

const b64 = (p) => readFile(p).then((b) => b.toString('base64'));
let listShot;
let detailShot;
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
  listShot = await popup.screenshot({ encoding: 'base64' });

  const labels = await popup.$$eval('#tableList .name', (els) => els.map((e) => e.textContent));
  const idx = labels.findIndex((l) => l.includes('지역'));
  await popup.$$eval('#tableList li', (els, i) => els[i].click(), idx);
  await popup.waitForSelector('#preview tr', { timeout: 8000 });
  await popup.evaluate(() => document.getElementById('optNumbers').click());
  await new Promise((r) => setTimeout(r, 350));
  detailShot = await popup.screenshot({ encoding: 'base64' });
} finally {
  await browser.close();
  server.close();
}

const iconB64 = await b64(join(root, 'extension', 'icons', 'icon-128.png'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function frame({ title, subtitle, points, shot, badge }) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:1280px;height:800px;overflow:hidden;background:#080a0f;color:#eef2f8;
    font-family:"Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;}
  .bg{position:absolute;inset:0;background:
     radial-gradient(900px 500px at 12% 0%, rgba(255,90,43,.20), transparent 60%),
     radial-gradient(700px 420px at 95% 100%, rgba(64,120,255,.16), transparent 60%);}
  .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:48px 48px;}
  .left{position:absolute;left:64px;top:74px;width:560px;}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
  .brand img{width:44px;height:44px;border-radius:12px}
  .brand b{font-size:19px;letter-spacing:-.3px}
  h1{font-size:47px;line-height:1.16;letter-spacing:-1.6px;font-weight:800}
  h1 em{font-style:normal;color:#ff6a3d}
  p.sub{margin-top:16px;font-size:17.5px;line-height:1.55;color:#a9b7cd;max-width:520px}
  ul{margin-top:26px;display:flex;flex-wrap:wrap;gap:9px;list-style:none;max-width:520px}
  li{font-size:13.5px;font-weight:700;color:#dbe4f2;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);padding:7px 13px;border-radius:999px}
  .win{position:absolute;right:64px;top:56px;width:466px;height:704px;border-radius:16px;background:#12151c;
    border:1px solid rgba(255,255,255,.14);box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 0 1px rgba(0,0,0,.4);overflow:hidden}
  .bar{height:38px;display:flex;align-items:center;gap:6px;padding:0 14px;background:#0e1117;border-bottom:1px solid rgba(255,255,255,.09)}
  .dot{width:9px;height:9px;border-radius:50%;background:#3a4152}
  .url{margin-left:10px;flex:1;height:22px;border-radius:6px;background:rgba(255,255,255,.06);display:flex;align-items:center;
    padding:0 9px;font-size:10.5px;color:#7f8ca3;overflow:hidden;white-space:nowrap}
  .win img{width:100%;height:calc(100% - 38px);object-fit:cover;object-position:top center;display:block}
  .badge{position:absolute;right:36px;top:18px;font-size:11px;font-weight:800;color:#ffb39c;
    background:rgba(255,90,43,.14);border:1px solid rgba(255,90,43,.42);padding:5px 11px;border-radius:999px}
  .foot{position:absolute;left:64px;bottom:44px;font-size:12.5px;color:#6f7d93}
  </style></head><body>
  <div class="bg"></div><div class="grid"></div>
  <div class="left">
    <div class="brand"><img src="data:image/png;base64,${iconB64}"><b>표 따오기 (Table to Sheet)</b></div>
    <h1>${title}</h1>
    <p class="sub">${subtitle}</p>
    <ul>${points.map((p) => `<li>${p}</li>`).join('')}</ul>
  </div>
  <div class="win"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><div class="url">chromewebstore.google.com/detail/table-to-sheet</div></div>
    <img src="data:image/png;base64,${shot}"></div>
  ${badge ? `<div class="badge">${badge}</div>` : ''}
  <div class="foot">100% 로컬 처리 · 서버 전송 없음 · 전 기능 무료</div>
  </body></html>`;
}

const shots = [
  {
    file: 'screenshot-1-1280x800.png',
    title: '표를 고르면<br><em>엑셀로 바로</em>',
    subtitle: '페이지에서 표를 자동으로 찾아 목록으로 보여줍니다. 클릭 한 번으로 복사하거나 Excel·CSV로 저장하세요.',
    points: ['자동 표 감지', '병합셀 유지', '클립보드 TSV', '무료'],
    shot: listShot,
    badge: '표 4개 감지',
  },
  {
    file: 'screenshot-2-1280x800.png',
    title: '병합셀·숫자까지<br><em>그대로 살려서</em>',
    subtitle: 'rowspan·colspan을 논리 그리드로 펼치고, 숫자·날짜를 정리합니다. 열 숨김과 셀 수정도 그대로 반영됩니다.',
    points: ['XLSX · CSV · JSON · MD', '머리글 고정', '열 선택', '셀 편집'],
    shot: detailShot,
    badge: '병합셀 4×5',
  },
];

const composeDir = join(root, '.tmp-assets');
mkdirSync(composeDir, { recursive: true });
const shotBrowser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
try {
  const page = await shotBrowser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  for (const s of shots) {
    const file = join(composeDir, s.file.replace('.png', '.html'));
    writeFileSync(file, frame(s), 'utf8');
    await page.goto(`file://${file.replace(/\\/g, '/')}`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: join(outDir, s.file) });
    console.log('saved', join(outDir, s.file));
  }

  // 프로모 타일 440×280 / 마퀴 1400×560
  const tile = (w, h, big) => `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{width:${w}px;height:${h}px;overflow:hidden;background:#0b0e13;color:#fff;
      font-family:"Malgun Gothic",system-ui,sans-serif;position:relative}
    .bg{position:absolute;inset:0;background:radial-gradient(${w * 0.7}px ${h}px at 8% 0%,rgba(255,90,43,.28),transparent 62%)}
    .wrap{position:relative;height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 ${w * 0.07}px}
    h1{font-size:${big ? 46 : 27}px;font-weight:800;letter-spacing:-1px;line-height:1.2}
    h1 em{font-style:normal;color:#ff6a3d}
    p{margin-top:${big ? 14 : 8}px;color:#aab7cc;font-size:${big ? 18 : 13}px}
    img{position:absolute;right:${w * 0.045}px;top:${h * 0.18}px;width:${big ? 92 : 44}px;opacity:.95}
    </style></head><body><div class="bg"></div><div class="wrap">
    <h1>표 따오기<br><em>엑셀로 바로</em></h1><p>병합셀·숫자까지 살려서 · 전부 무료 · 전부 로컬</p></div>
    <img src="data:image/png;base64,${iconB64}"></body></html>`;

  for (const [file, w, h, big] of [
    ['promo-440x280.png', 440, 280, false],
    ['marquee-1400x560.png', 1400, 560, true],
  ]) {
    const file2 = join(composeDir, file.replace('.png', '.html'));
    writeFileSync(file2, tile(w, h, big), 'utf8');
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(`file://${file2.replace(/\\/g, '/')}`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: join(outDir, file) });
    console.log('saved', join(outDir, file));
  }
} finally {
  await shotBrowser.close();
}
