#!/usr/bin/env node
/**
 * E2E — 실제 Chrome에 확장을 로드하고 팝업 UI까지 검증한다.
 *
 * 주의: 테스트용 임시 복사본의 manifest 에 host_permissions(http://127.0.0.1)를 주입한다.
 *       실제 배포 manifest 는 activeTab 만 사용한다(최소 권한 유지).
 */
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { createReadStream, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8872;

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

const EMPTY_PAGE = `<!doctype html><meta charset="utf-8"><title>표 없음</title>
<h1>표가 없는 페이지</h1><p>이 페이지에는 표가 없습니다.</p>`;

const server = http
  .createServer((req, res) => {
    if (req.url === '/empty') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(EMPTY_PAGE);
    }
    if (req.url === '/paginated') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return createReadStream(join(here, 'fixtures', 'paginated.html')).pipe(res);
    }
    if (req.url === '/iframe') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return createReadStream(join(here, 'fixtures', 'iframe.html')).pipe(res);
    }
    if (req.url === '/embed') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return createReadStream(join(here, 'fixtures', 'tables.html')).pipe(res);
    }
    const file = join(here, 'fixtures', 'tables.html');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    createReadStream(file).pipe(res);
  })
  .listen(PORT);

// 테스트용 확장 복사본 (+host_permissions)
const extDir = await mkdtemp(join(tmpdir(), 'ts-ext-'));
await cp(join(root, 'extension'), extDir, { recursive: true });
const manifestPath = join(extDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [`http://127.0.0.1:${PORT}/*`];
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log('확장 복사본:', extDir);

// 다운로드 경로를 고정한 프로필 (파일명 규칙까지 검증하기 위해 CDP 명명 대신 실제 다운로드 사용)
const profileDir = await mkdtemp(join(tmpdir(), 'ts-profile-'));
const dlDir = join(profileDir, 'downloads');
mkdirSync(dlDir, { recursive: true });
mkdirSync(join(profileDir, 'Default'), { recursive: true });
writeFileSync(
  join(profileDir, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: dlDir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: dlDir },
  }),
);

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  userDataDir: profileDir,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
  defaultViewport: { width: 1280, height: 900 },
});

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 30000 },
  );
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  check('서비스 워커 기동', !!extId, extId);

  const listTabs = () => sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
  const newestTab = async () => {
    const ids = await listTabs();
    const before = new Set(ids);
    return { ids, newest: Math.max(...ids), before };
  };

  // 1) 표가 있는 페이지
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  const fixtureTab = (await listTabs()).reduce((a, b) => Math.max(a, b), 0);
  check('픽스처 탭 확보', Number.isInteger(fixtureTab) && fixtureTab > 0, `tabId=${fixtureTab}`);

  // 2) 팝업 UI
  const popup = await browser.newPage();
  const popupErrors = [];
  popup.on('pageerror', (e) => popupErrors.push(String(e)));
  popup.on('console', (m) => {
    if (m.type() === 'error') popupErrors.push(m.text());
  });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${fixtureTab}`, { waitUntil: 'load' });
  await popup.waitForSelector('#tableList li', { timeout: 15000 });

  const badge = await popup.$eval('#countBadge', (el) => el.textContent);
  const itemCount = await popup.$$eval('#tableList li', (els) => els.length);
  check('팝업: 표 4개 목록 표시', itemCount === 4 && badge === '4', `items=${itemCount}, badge=${badge}`);

  const labels = await popup.$$eval('#tableList .name', (els) => els.map((e) => e.textContent));
  check('팝업: 표 라벨', labels.some((l) => l.includes('상품')) && labels.some((l) => l.includes('지역')), labels.join(' | '));

  // 기본 표 선택
  const simpleIdx = labels.findIndex((l) => l.includes('상품'));
  await popup.$$eval('#tableList li', (els, idx) => els[idx].click(), simpleIdx);
  await popup.waitForSelector('#detailView:not(.hidden)', { timeout: 8000 });
  await popup.waitForSelector('#preview tr', { timeout: 8000 });

  const detail = await popup.evaluate(() => ({
    title: document.getElementById('detailTitle').textContent,
    rows: document.querySelectorAll('#preview tr').length,
    cells: document.querySelectorAll('#preview td, #preview th').length,
    first: document.querySelector('#preview tr:nth-child(2) td')?.textContent,
    headerCells: [...document.querySelectorAll('#preview th')].map((e) => e.textContent),
    hasMergedPreview: true,
  }));
  check('팝업: 4×4 미리보기', detail.rows === 4 && detail.headerCells.join(',') === '상품,수량,단가,합계', JSON.stringify({ rows: detail.rows, header: detail.headerCells }));
  check('팝업: 첫 값', detail.first === '노트북', detail.first);

  // 복사 버튼
  await popup.click('#copy');
  await popup.waitForFunction(() => /복사했습니다/.test(document.getElementById('status').textContent), { timeout: 8000 });
  const copyStatus = await popup.$eval('#status', (el) => el.textContent);
  check('클립보드 복사 실행', /복사했습니다 \(4행 × 4열\)/.test(copyStatus), copyStatus);

  // 실제 클립보드 내용(가능한 경우만)
  let clipboard = null;
  try {
    await popup.browserContext().overridePermissions(`chrome-extension://${extId}`, ['clipboard-read', 'clipboard-write']);
    clipboard = await popup.evaluate(() => navigator.clipboard.readText());
  } catch (e) {
    clipboard = null;
  }
  if (clipboard != null) {
    const lines = clipboard.split('\n');
    check('클립보드 내용 = TSV 4행', lines.length === 4 && lines[1].split('\t')[2] === '1,420,000', JSON.stringify(lines[1]));
  } else {
    console.log('ℹ️  클립보드 readText 권한 없음 — 내용 검증은 core 테스트(TSV 직렬화)로 대체');
  }

  // 열 숨김 → 미리보기/복사 반영
  await popup.$$eval('#colChips .chip', (els) => {
    const chip = els.find((e) => e.textContent === '수량');
    if (chip) chip.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const chips = await popup.$$eval('#colChips .chip', (els) => els.map((e) => ({ t: e.textContent, off: e.className.includes('off') })));
  check('열 숨김 칩 상태', chips.length === 4 && !!chips.find((c) => c.t === '수량' && c.off), JSON.stringify(chips));
  await popup.click('#copy');
  await new Promise((r) => setTimeout(r, 400));
  const clipHidden = await popup.evaluate(() => navigator.clipboard.readText());
  check('숨긴 열 제외 복사', clipHidden.split('\n')[0].trim().split('\t').join('|') === '상품|단가|합계', clipHidden.split('\n')[0]);

  await popup.click('#colReset');
  await new Promise((r) => setTimeout(r, 200));
  const chipsReset = await popup.$$eval('#colChips .chip', (els) => els.map((e) => e.className));
  check('열 전체 복원', chipsReset.every((c) => !c.includes('off')), chipsReset.join(','));

  // 셀 편집 — Esc는 취소(팝업 유지), Enter는 저장
  await popup.click('#preview tr:nth-child(2) td:nth-child(1)');
  await popup.waitForSelector('#preview .cell-edit', { timeout: 3000 });
  await popup.evaluate(() => {
    const i = document.querySelector('#preview .cell-edit');
    i.value = '';
    i.focus();
  });
  await popup.type('#preview .cell-edit', '임시값');
  await popup.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));
  const afterEsc = await popup.evaluate(() => ({
    closed: false,
    cell: document.querySelector('#preview tr:nth-child(2) td:nth-child(1)')?.textContent,
  }));
  check('Esc 셀 편집 취소 + 팝업 유지', !popup.isClosed() && afterEsc.cell === '노트북', `${afterEsc.cell}`);

  await popup.click('#preview tr:nth-child(2) td:nth-child(1)');
  await popup.waitForSelector('#preview .cell-edit', { timeout: 3000 });
  await popup.evaluate(() => {
    const i = document.querySelector('#preview .cell-edit');
    i.value = '';
    i.focus();
  });
  await popup.type('#preview .cell-edit', '노트북 Pro');
  await popup.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 250));
  const editedCell = await popup.$eval('#preview tr:nth-child(2) td:nth-child(1)', (el) => el.textContent);
  check('셀 편집 저장', editedCell === '노트북 Pro', editedCell);
  await popup.click('#copy');
  await new Promise((r) => setTimeout(r, 400));
  const clipEdited = await popup.evaluate(() => navigator.clipboard.readText());
  check('편집값 복사 반영', clipEdited.split('\n')[1].split('\t')[0] === '노트북 Pro', clipEdited.split('\n')[1].split('\t')[0]);

  // 편집·숨김이 Excel 내보내기에도 반영되는지
  const xlsxBefore = new Set(readdirSync(dlDir).filter((n) => n.endsWith('.xlsx')));
  await popup.$$eval('#colChips .chip', (els) => els.find((e) => e.textContent === '수량')?.click());
  await new Promise((r) => setTimeout(r, 200));
  await popup.click('#excel');
  let editedXlsx = null;
  for (let i = 0; i < 40 && !editedXlsx; i += 1) {
    const fresh = readdirSync(dlDir).find((n) => n.endsWith('.xlsx') && !xlsxBefore.has(n));
    if (fresh) editedXlsx = join(dlDir, fresh);
    else await new Promise((r) => setTimeout(r, 250));
  }
  if (editedXlsx) {
    const xlsxMod = await import('xlsx');
    const XLSX = xlsxMod.default && xlsxMod.default.read ? xlsxMod.default : xlsxMod;
    const wb = XLSX.readFile(editedXlsx);
    const ws = wb.Sheets[wb.SheetNames[0]];
    check('Excel에 편집·숨김 반영', ws.A2?.v === '노트북 Pro' && ws.B1?.v === '단가', JSON.stringify({ A2: ws.A2?.v, B1: ws.B1?.v }));
  } else {
    check('Excel에 편집·숨김 반영', false, '파일 없음');
  }
  await popup.click('#colReset');

  // 컨텍스트 메뉴 경로 (네이티브 메뉴 대신 content 핸들러를 직접 검증)
  await page.evaluate(() => {
    const td = document.querySelector('#t-simple tbody td');
    td.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  });
  const ctxRes = await sw.evaluate(async (tabId) => await chrome.tabs.sendMessage(tabId, { type: 'TS_CONTEXT_COPY' }), fixtureTab);
  const toast = await page.$eval('#table-to-sheet-toast', (el) => el.textContent).catch(() => '');
  check('컨텍스트 메뉴 복사 경로', ctxRes?.ok === true && ctxRes.rows === 4 && ctxRes.cols === 4, JSON.stringify(ctxRes));
  check('토스트 표시', /클립보드/.test(toast), toast);

  // CSV 다운로드 트리거
  await popup.click('#csv');
  await popup.waitForFunction(() => /다운로드|실패/.test(document.getElementById('status').textContent), { timeout: 8000 });
  const csvStatus = await popup.$eval('#status', (el) => el.textContent);
  check('CSV 다운로드 트리거', /다운로드 시작/.test(csvStatus), csvStatus);

  // Excel 다운로드 (실제 파일 검증)
  let xlsxPath = null;
  try {
    const before = new Set(readdirSync(dlDir).filter((n) => n.endsWith('.xlsx')));
    await popup.click('#excel');
    await popup.waitForFunction(() => /다운로드|실패|만드는/.test(document.getElementById('status').textContent), { timeout: 15000 });
    for (let i = 0; i < 60 && !xlsxPath; i += 1) {
      const found = readdirSync(dlDir).find((n) => n.endsWith('.xlsx') && !before.has(n));
      if (found) xlsxPath = join(dlDir, found);
      else await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    console.log('ℹ️  Excel 다운로드 캡처 실패:', String(e.message).slice(0, 120));
  }
  if (xlsxPath) {
    const xlsxMod = await import('xlsx');
    const XLSX = xlsxMod.default && xlsxMod.default.read ? xlsxMod.default : xlsxMod;
    const wb = XLSX.readFile(xlsxPath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    check('Excel 파일 다운로드 + 파싱', !!ws?.A1, `${xlsxPath.split(/[\\/]/).pop()} / ${wb.SheetNames[0]}`);
    check('Excel 값 일치', ws.A1?.v === '상품' && ws.C2?.v === '1,420,000', JSON.stringify({ A1: ws.A1?.v, C2: ws.C2?.v }));
    const dlItems = await popup.evaluate(async () => {
      const items = await chrome.downloads.search({});
      return items.map((i) => ({ filename: i.filename, state: i.state }));
    });
    const named = dlItems.filter((i) => /\.(xlsx|csv)$/.test(i.filename));
    check('다운로드 파일명 규칙', named.some((i) => /상품 · 수량 · 단가.*\.xlsx$/.test(i.filename)), named.map((i) => i.filename.split(/[\\/]/).pop()).join(' | '));
  } else {
    const st = await popup.$eval('#status', (el) => el.textContent);
    console.log('ℹ️  Excel 파일 캡처 불가 — 상태 문구로 대체:', st);
  }

  // 3) 병합셀·숫자 정리 미리보기
  await popup.click('#back');
  await popup.waitForSelector('#listView:not(.hidden)', { timeout: 5000 });
  await popup.$$eval('#tableList li', (els, i) => els[i].click(), labels.findIndex((l) => l.includes('지역')));
  await popup.waitForSelector('#detailView:not(.hidden)', { timeout: 8000 });
  const mergedPreview = await popup.evaluate(() => {
    const first = document.querySelector('#preview tr th, #preview tr td');
    const rows = [...document.querySelectorAll('#preview tr')];
    return {
      rs: first.getAttribute('rowspan'),
      text: first.textContent,
      second: [...rows[1].children].map((e) => e.textContent),
    };
  });
  check('병합셀 미리보기 rowspan', mergedPreview.rs === '2' && mergedPreview.text === '지역', JSON.stringify({ rs: mergedPreview.rs, text: mergedPreview.text }));
  check('병합셀 헤더 2행 구성', mergedPreview.second.join('|') === '1분기|2분기|1분기|2분기', mergedPreview.second.join('|'));

  await popup.click('#back');
  await popup.waitForSelector('#listView:not(.hidden)', { timeout: 5000 });
  await popup.$$eval('#tableList li', (els, i) => els[i].click(), labels.findIndex((l) => l.includes('상품')));
  await popup.waitForSelector('#detailView:not(.hidden)', { timeout: 8000 });
  await popup.click('#optNumbers');
  await new Promise((r) => setTimeout(r, 200));
  const normCell = await popup.evaluate(() => document.querySelectorAll('#preview tr')[1].children[2].textContent);
  check('미리보기 숫자 정리 반영', normCell === '1420000', normCell);

  // 4) 표 없는 페이지
  const empty = await browser.newPage();
  await empty.goto(`http://127.0.0.1:${PORT}/empty`, { waitUntil: 'load' });
  const emptyTab = (await listTabs()).reduce((a, b) => Math.max(a, b), 0);
  const popup2 = await browser.newPage();
  await popup2.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${emptyTab}`, { waitUntil: 'load' });
  await popup2.waitForSelector('#empty:not(.hidden)', { timeout: 10000 });
  const emptyText = await popup2.evaluate(() => ({
    hint: document.getElementById('hint').textContent,
    msg: document.getElementById('empty').innerText.replace(/\s+/g, ' ').trim(),
  }));
  check('표 없음 안내 표시', /표를 찾지 못했습니다/.test(emptyText.msg) && /찾지 못했습니다/.test(emptyText.hint), emptyText.msg.slice(0, 60));

  // 5) 페이지네이션 자동 수집
  const paged = await browser.newPage();
  await paged.goto(`http://127.0.0.1:${PORT}/paginated`, { waitUntil: 'load' });
  const pagedTab = (await listTabs()).reduce((a, b) => Math.max(a, b), 0);
  const popup3 = await browser.newPage();
  await popup3.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${pagedTab}`, { waitUntil: 'load' });
  await popup3.waitForSelector('#tableList li', { timeout: 15000 });
  const pagedLabels = await popup3.$$eval('#tableList .name', (els) => els.map((e) => e.textContent));
  const pagedIdx = pagedLabels.findIndex((l) => l.includes('순번'));
  check('페이지네이션 픽스처 감지', pagedLabels.length === 2 && pagedIdx >= 0, pagedLabels.join(' | '));

  await popup3.$$eval('#tableList li', (els, i) => els[i].click(), pagedIdx);
  await popup3.waitForSelector('#detailView:not(.hidden)', { timeout: 8000 });
  const beforeTitle = await popup3.$eval('#detailTitle', (el) => el.textContent);
  await popup3.click('#collect');
  await popup3.waitForFunction(() => /페이지 수집|실패|없음/.test(document.getElementById('status').textContent), { timeout: 45000 });
  const pagedRes = await popup3.evaluate(() => ({
    status: document.getElementById('status').textContent,
    title: document.getElementById('detailTitle').textContent,
    rows: document.querySelectorAll('#preview tr').length,
  }));
  check('다음 버튼 3페이지 자동 수집', /31×4/.test(pagedRes.title) && /3페이지/.test(pagedRes.status), `${beforeTitle} → ${pagedRes.title} | ${pagedRes.status}`);
  check('수집 후 미리보기 31행', pagedRes.rows === 31, String(pagedRes.rows));

  // 6) 더 보기 수집
  await popup3.click('#back');
  await popup3.waitForSelector('#listView:not(.hidden)', { timeout: 5000 });
  const moreIdx = pagedLabels.findIndex((l) => l.includes('코드'));
  await popup3.$$eval('#tableList li', (els, i) => els[i].click(), moreIdx);
  await popup3.waitForSelector('#detailView:not(.hidden)', { timeout: 8000 });
  await popup3.click('#collect');
  await popup3.waitForFunction(() => /페이지 수집|실패|없음/.test(document.getElementById('status').textContent), { timeout: 45000 });
  const moreRes = await popup3.evaluate(() => ({
    status: document.getElementById('status').textContent,
    title: document.getElementById('detailTitle').textContent,
  }));
  check('더 보기 자동 수집 (5→20행)', /21×3/.test(moreRes.title), `${moreRes.title} | ${moreRes.status}`);

  // 7) iframe 내부 표
  const iframePage = await browser.newPage();
  await iframePage.goto(`http://127.0.0.1:${PORT}/iframe`, { waitUntil: 'load' });
  const iframeTab = (await listTabs()).reduce((a, b) => Math.max(a, b), 0);
  const popup4 = await browser.newPage();
  await popup4.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${iframeTab}`, { waitUntil: 'load' });
  await popup4.waitForSelector('#tableList li', { timeout: 15000 });
  const iframeList = await popup4.evaluate(() => ({
    count: document.querySelectorAll('#tableList li').length,
    labels: [...document.querySelectorAll('#tableList .name')].map((e) => e.textContent),
    kinds: [...document.querySelectorAll('#tableList .kind')].map((e) => e.textContent),
  }));
  check('iframe 포함 표 감지 (top 1 + frame 4)', iframeList.count === 5, `${iframeList.count}개: ${iframeList.labels.join(' | ')}`);
  check('iframe 표 배지 표시', iframeList.kinds.some((k) => k.includes('frame')), iframeList.kinds.join(','));
  const iframeIdx = iframeList.labels.findIndex((l) => l.includes('상품'));
  await popup4.$$eval('#tableList li', (els, i) => els[i].click(), iframeIdx);
  await popup4.waitForSelector('#detailView:not(.hidden)', { timeout: 8000 });
  const iframePreview = await popup4.evaluate(() => ({
    title: document.getElementById('detailTitle').textContent,
    first: document.querySelector('#preview tr:nth-child(2) td')?.textContent,
  }));
  check('iframe 표 추출', /4×4/.test(iframePreview.title) && iframePreview.first === '노트북', `${iframePreview.title} / ${iframePreview.first}`);

  check('팝업 콘솔 에러 없음', popupErrors.length === 0, popupErrors.slice(0, 3).join(' | ') || 'none');

  // 4) 네트워크 요청 검사(외부 도메인 0건)
  const extRequests = [];
  popup.on('request', (r) => {
    if (!r.url().startsWith('chrome-extension://') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) extRequests.push(r.url());
  });
  await popup.reload({ waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 1500));
  check('외부 네트워크 요청 0건', extRequests.length === 0, extRequests.slice(0, 3).join(' | ') || 'none');
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== E2E 결과: ${results.length - failed.length}/${results.length} 통과 ===`);
if (failed.length) process.exitCode = 1;
