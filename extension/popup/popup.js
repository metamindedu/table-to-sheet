'use strict';

const CONTENT_FILES = ['content/table-core.js', 'content/content.js'];
const PREVIEW_ROWS = 40;
const PREVIEW_COLS = 15;

const state = {
  tabId: null,
  tables: [],
  data: null,
  selectedId: null,
  selectedFrameId: 0,
  frames: [],
  hiddenCols: new Set(),
};
const $ = (id) => document.getElementById(id);

/**
 * 미배포(개발) 빌드에서만 ?tabId= 로 대상 탭을 지정할 수 있다.
 * 스토어 배포본(update_url 존재)에서는 무시된다.
 */
const DEBUG_TAB_ID = (() => {
  try {
    if (chrome.runtime.getManifest().update_url) return null;
    const raw = new URLSearchParams(location.search).get('tabId');
    const id = Number(raw);
    return raw && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
})();

/* ------------------------------------------------------------- helpers */

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (isError ? ' err' : '');
}

function showList() {
  $('listView').classList.remove('hidden');
  $('detailView').classList.add('hidden');
  state.data = null;
  state.selectedId = null;
}

function showDetail() {
  $('listView').classList.add('hidden');
  $('detailView').classList.remove('hidden');
}

function showEmpty(title, detail) {
  $('hint').textContent = title;
  $('empty').classList.remove('hidden');
  if (detail) $('empty').querySelector('.muted').innerHTML = detail;
  $('tableList').innerHTML = '';
  $('countBadge').classList.add('hidden');
}

function errText(err) {
  const msg = String((err && err.message) || err || '');
  if (/Cannot access contents|chrome:\/\/|webstore/i.test(msg)) {
    return 'Chrome 내부 페이지·웹스토어에서는 동작하지 않습니다.<br />일반 웹페이지에서 다시 시도해 주세요.';
  }
  return msg.replace(/</g, '&lt;');
}

/* -------------------------------------------------------------- detect */

async function detect() {
  $('hint').textContent = '표를 찾는 중…';
  $('empty').classList.add('hidden');
  setStatus('');
  try {
    // 모든 프레임(top + iframe)에 코어 주입
    let injections;
    try {
      injections = await chrome.scripting.executeScript({ target: { tabId: state.tabId, allFrames: true }, files: CONTENT_FILES });
    } catch (e) {
      injections = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: CONTENT_FILES });
    }
    state.frames = injections.map((r) => r.frameId);

    const results = await chrome.scripting.executeScript({
      target: { tabId: state.tabId, frameIds: state.frames.length ? state.frames : undefined },
      func: () =>
        globalThis.TableCore
          ? TableCore.detect(document).map((t) => ({
              id: t.id,
              kind: t.kind,
              rows: t.rows,
              cols: t.cols,
              label: t.label,
              preview: t.preview,
            }))
          : [],
    });

    const tables = [];
    for (const r of results) {
      for (const t of r.result || []) tables.push({ ...t, frameId: r.frameId });
    }
    tables.sort((a, b) => {
      if (a.frameId === 0 !== (b.frameId === 0)) return a.frameId === 0 ? -1 : 1;
      return b.rows * b.cols - a.rows * a.cols;
    });
    state.tables = tables;
    renderList();
  } catch (err) {
    showEmpty('페이지에 접근할 수 없습니다.', errText(err));
  }
}

function renderList() {
  const list = $('tableList');
  list.innerHTML = '';
  const badge = $('countBadge');
  if (!state.tables.length) {
    badge.classList.add('hidden');
    $('hint').textContent = '표를 찾지 못했습니다.';
    showEmpty('이 페이지에서 표를 찾지 못했습니다.', null);
    return;
  }
  badge.textContent = String(state.tables.length);
  badge.classList.remove('hidden');
  $('hint').textContent = `표 ${state.tables.length}개를 찾았습니다. 하나를 선택하세요.`;

  for (const t of state.tables) {
    const li = document.createElement('li');
    li.dataset.id = t.id;
    const preview = (t.preview || [])
      .slice(0, 2)
      .map((row) => row.filter(Boolean).slice(0, 4).join(' · '))
      .filter(Boolean)
      .join(' / ');
    li.innerHTML = `
      <div class="row1">
        <span class="name"></span>
        <span class="kind">${t.kind === 'div' ? '그리드' : t.kind === 'role' ? 'ARIA' : 'TABLE'}${t.frameId !== 0 ? ' · frame' : ''}</span>
        <span class="size">${t.rows} × ${t.cols}</span>
      </div>
      <div class="prev"></div>`;
    li.querySelector('.name').textContent = t.label || `표 ${t.rows}×${t.cols}`;
    li.querySelector('.prev').textContent = preview || '(미리보기 없음)';
    li.addEventListener('click', () => selectTable(t));
    list.appendChild(li);
  }
}

/* ------------------------------------------------------------- extract */

async function selectTable(table) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: state.tabId, frameIds: [table.frameId] },
      func: (id) => TableCore.extract(id),
      args: [table.id],
    });
    if (!res || !res.result) throw new Error('표를 읽지 못했습니다. 다시 감지해 주세요.');
    state.data = res.result;
    state.selectedId = table.id;
    state.selectedFrameId = table.frameId;
    state.hiddenCols = new Set();
    renderDetail();
  } catch (err) {
    setStatus(String((err && err.message) || err), true);
  }
}

/** 숨긴 열을 제거한 사본 (병합이 숨긴 열을 건너면 해제) */
function applyColumnFilter(data, hidden) {
  const width = data.width || (data.rows[0] ? data.rows[0].length : 0);
  const keep = [];
  for (let c = 0; c < width; c += 1) if (!hidden.has(c)) keep.push(c);
  const rows = data.rows.map((row) => keep.map((c) => row[c] || { v: '', h: false, rs: 1, cs: 1, a: true }));
  const index = new Map(keep.map((c, i) => [c, i]));
  const merges = [];
  for (const m of data.merges || []) {
    const cols = [];
    for (let dc = 0; dc < m.cs; dc += 1) cols.push(m.c + dc);
    if (!cols.every((c) => index.has(c))) continue;
    const start = index.get(cols[0]);
    if (index.get(cols[cols.length - 1]) - start !== m.cs - 1) continue;
    merges.push({ ...m, c: start });
  }
  return { rows, merges, width: keep.length, height: rows.length, label: data.label, colMap: keep };
}

function viewData() {
  const data = state.data;
  if (!data) return null;
  if (!state.hiddenCols.size) {
    return { ...data, colMap: Array.from({ length: data.width }, (_, i) => i) };
  }
  return applyColumnFilter(data, state.hiddenCols);
}

function renderColChips() {
  const bar = $('colChips');
  bar.innerHTML = '';
  const data = state.data;
  if (!data) return;
  const header = data.rows[0] || [];
  for (let c = 0; c < data.width; c += 1) {
    const chip = document.createElement('button');
    const label = (header[c] && header[c].v ? header[c].v : `열 ${c + 1}`).slice(0, 10) || `열 ${c + 1}`;
    const off = state.hiddenCols.has(c);
    chip.className = 'chip' + (off ? ' off' : '');
    chip.textContent = label;
    chip.title = `${c + 1}열 — 클릭해서 ${off ? '표시' : '숨김'}`;
    chip.addEventListener('click', () => {
      if (state.hiddenCols.has(c)) {
        state.hiddenCols.delete(c);
      } else if (data.width - state.hiddenCols.size <= 1) {
        setStatus('최소 한 개의 열은 남겨야 합니다.', true);
        return;
      } else {
        state.hiddenCols.add(c);
      }
      renderDetail();
      setStatus(`열 ${state.hiddenCols.size}개 숨김 — 내보내기에 반영됩니다`);
    });
    bar.appendChild(chip);
  }
  $('colReset').classList.toggle('hidden', state.hiddenCols.size === 0);
}

function renderDetail() {
  const data = state.data;
  if (!data) return;
  showDetail();
  setStatus('');
  $('detailTitle').textContent = data.label || `표 ${data.height}×${data.width}`;
  renderColChips();

  const view = viewData();
  const table = $('preview');
  table.innerHTML = '';
  const useHeader = $('optHeader').checked;

  // 병합 정보 맵
  const spans = new Map();
  for (const m of view.merges || []) spans.set(`${m.r},${m.c}`, m);
  const covered = new Set();
  for (const m of view.merges || []) {
    for (let dr = 0; dr < m.rs; dr += 1) {
      for (let dc = 0; dc < m.cs; dc += 1) {
        if (dr || dc) covered.add(`${m.r + dr},${m.c + dc}`);
      }
    }
  }

  const maxR = Math.min(view.height, PREVIEW_ROWS);
  const maxC = Math.min(view.width, PREVIEW_COLS);
  const normalize = $('optNumbers').checked;
  const normOpts = { normalizeNumbers: normalize, normalizeDates: normalize };
  for (let r = 0; r < maxR; r += 1) {
    const tr = document.createElement('tr');
    for (let c = 0; c < maxC; c += 1) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = view.rows[r][c];
      const headCell = (cell && cell.h) || (r === 0 && useHeader);
      const cellEl = document.createElement(headCell ? 'th' : 'td');
      const span = spans.get(`${r},${c}`);
      if (span) {
        if (span.cs > 1) cellEl.colSpan = Math.min(span.cs, maxC - c);
        if (span.rs > 1) cellEl.rowSpan = Math.min(span.rs, maxR - r);
      }
      const raw = cell ? cell.v : '';
      const shown = normalize ? TableCore.normalizeValue(raw, normOpts) : raw;
      cellEl.textContent = shown;
      cellEl.dataset.r = String(r);
      cellEl.dataset.c = String(view.colMap[c]);
      if (!headCell && shown && /^-?[\d.]+$/.test(shown)) cellEl.classList.add('num');
      tr.appendChild(cellEl);
    }
    table.appendChild(tr);
  }
  if (view.height > maxR || view.width > maxC) {
    const note = document.createElement('caption');
    note.style.captionSide = 'bottom';
    note.style.color = '#93a3ba';
    note.style.padding = '4px';
    note.style.fontSize = '11px';
    note.textContent = `미리보기 ${maxR}×${maxC} — 전체 ${view.height}×${view.width}`;
    table.appendChild(note);
  }
}

/* ------------------------------------------------------------- exports */

function options() {
  const normalize = $('optNumbers').checked;
  return {
    normalizeNumbers: normalize,
    normalizeDates: normalize,
    fillSpans: $('optFill').checked,
  };
}

function withHeader(data) {
  if ($('optHeader').checked) return data;
  const width = data.width || (data.rows[0] ? data.rows[0].length : 0);
  const header = Array.from({ length: width }, (_, i) => ({ v: `col${i + 1}`, h: true, rs: 1, cs: 1, a: true }));
  return { ...data, rows: [header, ...data.rows], merges: [] };
}

async function copyTSV() {
  if (!state.data) return;
  try {
    const view = viewData();
    const text = TableCore.serialize.tsv(view, options());
    await navigator.clipboard.writeText(text);
    setStatus(`복사했습니다 (${view.height}행 × ${view.width}열) — Excel에 Ctrl+V`);
  } catch (err) {
    setStatus('복사 실패: ' + String((err && err.message) || err), true);
  }
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
    if (chrome.runtime.lastError) {
      setStatus('다운로드 실패: ' + chrome.runtime.lastError.message, true);
      URL.revokeObjectURL(url);
      return;
    }
    setStatus('다운로드 시작: ' + filename);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
    if (chrome.runtime.lastError) {
      setStatus('다운로드 실패: ' + chrome.runtime.lastError.message, true);
      URL.revokeObjectURL(url);
      return;
    }
    setStatus('다운로드 시작: ' + filename);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

/* -------------------------------------------------------------- excel */

async function exportExcel() {
  if (!state.data) return;
  try {
    setStatus('Excel 파일 만드는 중…');
    const opts = options();
    const data = viewData();
    const fillSpans = $('optFill').checked;
    // 병합셀 채우기 ON → 값 반복(병합 없음), OFF → 실제 병합 유지
    const textRows = TableCore.__internal.toTextMatrix(data, { ...opts, fillSpans: true });
    const rows = textRows.map((row) =>
      row.map((v) => {
        if (!opts.normalizeNumbers) return v;
        const n = TableCore.parseNumber(v);
        return n === null ? v : n;
      }),
    );
    const bytes = await XlsxWriter.build([
      {
        name: (data.label || '표').replace(/\s*\(\d+×\d+\)\s*$/, '').slice(0, 28) || '표',
        rows,
        merges: fillSpans ? [] : data.merges || [],
        headerRows: $('optHeader').checked ? 1 : 0,
      },
    ]);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    downloadBlob(fileBase() + '.xlsx', blob);
  } catch (err) {
    setStatus('Excel 생성 실패: ' + String((err && err.message) || err), true);
  }
}

function fileBase() {
  const label = (state.data && state.data.label) || 'table';
  return label.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'table';
}

/* ---------------------------------------------------------- 페이지 수집 */

const REASON_TEXT = {
  max: '최대 페이지 수 도달',
  'no-next': '다음 페이지 버튼 없음',
  'no-change': '다음 버튼을 눌러도 내용이 바뀌지 않음',
  navigated: '페이지 이동 감지로 중단',
  detached: '표가 다시 그려져 추적 중단',
  empty: '다음 페이지에 데이터 없음',
  'click-error': '다음 버튼 클릭 실패',
  'too-many': '행이 너무 많아 중단',
};

async function collectPages() {
  if (!state.data || !state.selectedId) return;
  const btn = $('collect');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '수집 중…';
  setStatus('');
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: state.tabId, frameIds: [state.selectedFrameId ?? 0] },
      func: (id, maxPages) => TableCore.collectPages(id, { maxPages }),
      args: [state.selectedId, 10],
    });
    const res = injected && injected.result;
    if (!res) throw new Error('수집에 실패했습니다. 다시 감지해 주세요.');
    const before = state.data.height;
    state.data = res.data;
    renderDetail();
    const added = res.data.height - before;
    const why = REASON_TEXT[res.reason] || res.reason;
    const parts = [`${res.pages}페이지 수집`, `${res.data.height}행`, added > 0 ? `+${added}행` : '추가 없음'];
    if (res.reason !== 'max') parts.push(why);
    setStatus(parts.join(' · '), res.reason === 'no-next' && added <= 0);
  } catch (err) {
    setStatus(String((err && err.message) || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* --------------------------------------------------------------- wiring */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  if (DEBUG_TAB_ID) {
    state.tabId = DEBUG_TAB_ID;
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) {
      showEmpty('탭을 찾을 수 없습니다.', '페이지를 새로고침한 뒤 다시 시도해 주세요.');
      return;
    }
    state.tabId = tab.id;
    if (/^(chrome|about|edge|devtools):/i.test(tab.url || '')) {
      showEmpty('이 페이지에서는 사용할 수 없습니다.', 'Chrome 내부 페이지·웹스토어에서는 동작하지 않습니다.');
      return;
    }
  }
  // 옵션 페이지의 기본값 반영
  try {
    const s = await chrome.storage.local.get({ defaultHeader: true, defaultFill: true, defaultNumbers: false });
    $('optHeader').checked = s.defaultHeader !== false;
    $('optFill').checked = s.defaultFill !== false;
    $('optNumbers').checked = s.defaultNumbers === true;
  } catch {
    /* 기본값 유지 */
  }
  await detect();
}

$('rescan').addEventListener('click', () => {
  showList();
  setStatus('');
  detect();
});
$('back').addEventListener('click', () => {
  showList();
  renderList();
});
$('copy').addEventListener('click', copyTSV);
$('excel').addEventListener('click', exportExcel);
$('collect').addEventListener('click', collectPages);
$('csv').addEventListener('click', () => {
  if (!state.data) return;
  const view = viewData();
  download(fileBase() + '.csv', TableCore.serialize.csv(view, { ...options(), bom: true }), 'text/csv;charset=utf-8');
});
$('json').addEventListener('click', () => {
  if (!state.data) return;
  const view = viewData();
  download(fileBase() + '.json', TableCore.serialize.json(withHeader(view), options()), 'application/json');
});
$('md').addEventListener('click', () => {
  if (!state.data) return;
  const view = viewData();
  download(fileBase() + '.md', TableCore.serialize.markdown(withHeader(view), options()), 'text/markdown;charset=utf-8');
});
$('optHeader').addEventListener('change', renderDetail);
$('optNumbers').addEventListener('change', renderDetail);
$('colReset').addEventListener('click', () => {
  state.hiddenCols.clear();
  renderDetail();
  setStatus('모든 열을 표시합니다');
});

// 셀 편집: 클릭 → 입력, Enter/블러 저장, Esc 취소
$('preview').addEventListener('click', (e) => {
  const cellEl = e.target.closest('td, th');
  if (!cellEl || !state.data || cellEl.querySelector('input')) return;
  const r = Number(cellEl.dataset.r);
  const c = Number(cellEl.dataset.c);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return;
  const row = state.data.rows[r];
  if (!row || !row[c]) return;
  const original = row[c].v;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cell-edit';
  input.value = original;
  input.setAttribute('aria-label', `${r + 1}행 ${c + 1}열 값`);
  cellEl.textContent = '';
  cellEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const changed = save && input.value !== original;
    if (changed) row[c].v = input.value;
    renderDetail();
    if (changed) setStatus(`수정됨: ${r + 1}행 ${c + 1}열 — 내보내기에 반영됩니다`);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation(); // 팝업 닫기 단축키로 전파되지 않게
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});
