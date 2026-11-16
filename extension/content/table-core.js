/**
 * TableCore — 표 감지·추출·직렬화 (순수 로직, chrome 의존 없음)
 *
 * 브라우저 페이지와 테스트(Puppeteer addScriptTag) 양쪽에서 동일하게 동작하도록
 * globalThis.TableCore 로 API를 노출한다.
 *
 * API
 *   detect(root?)                  → [{id, rows, cols, label, preview, element}]
 *   extract(id)                    → {rows: [[{v,h}]], merges, width, height, label}
 *   nearestTableElement(el)        → 감지 대상 요소(컨텍스트 메뉴용)
 *   serialize.tsv(data, opts)      → string
 *   serialize.csv(data, opts)      → string
 *   serialize.json(data, opts)     → string
 *   serialize.markdown(data, opts) → string
 *   serialize.normalizeValue(text, opts) → string
 */
(() => {
  'use strict';

  const REGISTRY = new Map(); // id → element
  let seq = 0;
  const MAX_TABLES = 20;
  const MAX_CELLS = 200000;

  /* ------------------------------------------------------------ 텍스트 */

  const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g;

  function cleanText(input) {
    return String(input == null ? '' : input)
      .replace(ZERO_WIDTH, '')
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t\r\n]+/g, ' ')
      .trim();
  }

  /** 셀 텍스트: 자식 표의 텍스트는 제외해 중복을 막는다. */
  function cellText(cell) {
    if (!cell) return '';
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('table, [role="table"], [role="grid"]').forEach((el) => el.remove());
    clone.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());
    // 이미지 alt 텍스트는 값으로 유용하다
    clone.querySelectorAll('img[alt]').forEach((img) => img.replaceWith(img.getAttribute('alt')));
    const brs = clone.querySelectorAll('br');
    brs.forEach((br) => br.replaceWith('\n'));
    return cleanText(clone.textContent);
  }

  /* ------------------------------------------------------------ 숫자/날짜 */

  // 통화/단위가 붙어도 되고, 천단위 쉼표는 '3자리 그룹'일 때만 인정한다.
  // (경쟁 확장의 '1,420 → 1,42' 같은 오변환을 막기 위해 1,42 는 숫자로 보지 않는다)
  const NUMBER_RE =
    /^[-+]?\s*(?:[₩$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:원|KRW|USD|EUR|%|개|건)?$/;

  function parseNumber(text) {
    const t = cleanText(text);
    if (!t) return null;
    if (!NUMBER_RE.test(t)) return null;
    const percent = /%$/.test(t);
    const digits = t
      .replace(/[₩$€£¥원개건]/g, '')
      .replace(/KRW|USD|EUR/gi, '')
      .replace(/[,\s]/g, '')
      .replace(/%$/, '');
    const n = Number(digits);
    if (!Number.isFinite(n)) return null;
    return percent ? n / 100 : n;
  }

  const DATE_RE = /^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?\.?$/;

  function parseDate(text) {
    const m = cleanText(text).match(DATE_RE);
    if (!m) return null;
    const [, y, mo, d] = m;
    const mm = String(Number(mo)).padStart(2, '0');
    const dd = String(Number(d)).padStart(2, '0');
    if (Number(mo) > 12 || Number(d) > 31) return null;
    return `${y}-${mm}-${dd}`;
  }

  /** opts.normalizeNumbers / opts.normalizeDates */
  function normalizeValue(text, opts = {}) {
    const t = cleanText(text);
    if (!t) return '';
    if (opts.normalizeDates) {
      const d = parseDate(t);
      if (d) return d;
    }
    if (opts.normalizeNumbers) {
      const n = parseNumber(t);
      if (n !== null) return String(n);
    }
    return t;
  }

  /* ------------------------------------------------------------ 그리드 */

  function isHidden(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    // display:none 조상이면 client rect가 아예 없다.
    // (높이 0은 가상화/지연 렌더 표에서 흔하므로 숨김으로 보지 않는다)
    if (el.getClientRects && el.getClientRects().length === 0) return true;
    return false;
  }

  /**
   * tr 목록 + 셀 추출기 → 논리 그리드로 정규화
   * @returns {{matrix: Array<Array<{v:string,h:boolean,rs:number,cs:number,a:boolean}>>, width:number, height:number, merges:Array}}
   */
  function buildGrid(trs, getCells) {
    const matrix = [];
    const ensure = (r) => {
      if (!matrix[r]) matrix[r] = [];
      return matrix[r];
    };
    for (let r = 0; r < trs.length; r++) {
      const cells = getCells(trs[r]);
      if (!cells.length) continue;
      ensure(r);
      let c = 0;
      for (const cell of cells) {
        while (matrix[r][c]) c += 1;
        const rs = Math.max(1, Number(cell.getAttribute && cell.getAttribute('rowspan')) || cell.rowSpan || 1);
        const cs = Math.max(1, Number(cell.getAttribute && cell.getAttribute('colspan')) || cell.colSpan || 1);
        const text = cellText(cell);
        const tag = (cell.tagName || '').toUpperCase();
        const role = (cell.getAttribute && cell.getAttribute('role')) || '';
        const isHeader = tag === 'TH' || role === 'columnheader' || role === 'rowheader';
        for (let dr = 0; dr < rs; dr++) {
          const row = ensure(r + dr);
          for (let dc = 0; dc < cs; dc++) {
            row[c + dc] =
              dr === 0 && dc === 0
                ? { v: text, h: isHeader, rs, cs, a: true }
                : { v: '', h: isHeader, rs: 0, cs: 0, a: false };
          }
        }
        c += cs;
      }
    }
    // 빈 행 정리 + 폭 통일
    const rows = matrix.filter((row) => row && row.some((c) => c));
    const width = rows.reduce((w, row) => Math.max(w, row.length), 0);
    for (const row of rows) {
      for (let c = 0; c < width; c += 1) {
        if (!row[c]) row[c] = { v: '', h: false, rs: 1, cs: 1, a: true };
      }
      row.length = width;
    }
    const merges = [];
    rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        if (cell.a && (cell.rs > 1 || cell.cs > 1)) merges.push({ r, c, rs: cell.rs, cs: cell.cs });
      }),
    );
    return { matrix: rows, width, height: rows.length, merges };
  }

  /* ------------------------------------------------------------ 감지 */

  function simpleGridOf(table) {
    const trs = [...table.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tfoot > tr, :scope > tr')];
    return trs.filter((tr) => !tr.closest('table') || tr.closest('table') === table);
  }

  function isLayoutTable(table) {
    const trs = simpleGridOf(table);
    if (!trs.length) return true;
    const cells = table.querySelectorAll(':scope > tbody > tr > td, :scope > tr > td, :scope > tbody > tr > th, :scope > tr > th');
    if (cells.length <= 2 && trs.length <= 2) return true;
    if (table.querySelector('table')) {
      // 중첩 표: 하위 표만 별도 후보로 남기고 상위는 제외
      const inner = table.querySelectorAll('table').length;
      if (inner > 0 && cells.length < 8) return true;
    }
    return isHidden(table);
  }

  function detectTableElement(table) {
    const trs = simpleGridOf(table);
    if (trs.length < 2) return null;
    const { matrix, width, height, merges } = buildGrid(trs, (tr) =>
      [...tr.children].filter((c) => /^(TD|TH)$/.test(c.tagName)),
    );
    if (height < 2 || width < 2 || height * width > MAX_CELLS) return null;
    if (!matrix.some((row) => row.some((c) => c.v))) return null;
    const rect = table.getBoundingClientRect();
    return {
      element: table,
      kind: 'table',
      rows: height,
      cols: width,
      cells: height * width,
      area: Math.max(0, rect.width) * Math.max(0, rect.height),
      matrix,
      merges,
      label: labelFor(matrix, height, width),
    };
  }

  function detectRoleTable(el) {
    const rowEls = [...el.querySelectorAll('[role="row"]')];
    if (rowEls.length < 2) return null;
    const { matrix, width, height, merges } = buildGrid(rowEls, (row) => {
      const cells = [...row.querySelectorAll('[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]')];
      if (!cells.length) {
        return [...row.children].filter((c) => c.getAttribute('role') !== 'row');
      }
      return cells;
    });
    if (height < 2 || width < 2) return null;
    const rect = el.getBoundingClientRect();
    return {
      element: el,
      kind: 'role',
      rows: height,
      cols: width,
      cells: height * width,
      area: Math.max(0, rect.width) * Math.max(0, rect.height),
      matrix,
      merges,
      label: labelFor(matrix, height, width),
    };
  }

  /** 단일 요소가 div 표인지 보수적으로 판정 */
  function detectDivGrid(el) {
    const kids = [...el.children];
    if (kids.length < 3 || kids.length > 60) return null;
    const rows = kids
      .map((k) => [...k.children].filter((c) => cleanText(c.textContent).length > 0))
      .filter((cells) => cells.length >= 2);
    if (rows.length < 3) return null;
    const widths = rows.map((r) => r.length);
    const min = Math.min(...widths);
    const max = Math.max(...widths);
    if (min < 2 || max - min > 1) return null;
    // 열 정렬: 같은 열의 x좌표 편차가 작아야 표답다
    const rects = kids.map((k) => [...k.children].map((c) => c.getBoundingClientRect()));
    const firstRowCols = rects[0].length;
    for (let c = 0; c < Math.min(firstRowCols, 6); c += 1) {
      const xs = rects.map((r) => (r[c] ? Math.round(r[c].left) : null)).filter((v) => v != null);
      if (!xs.length) continue;
      if (Math.max(...xs) - Math.min(...xs) > 6) return null;
    }
    const textLens = rows.map((r) => r.map((c) => cleanText(c.textContent).length));
    if (textLens.some((r) => r.some((n) => n > 300))) return null;
    const { matrix, width, height, merges } = buildGrid(kids, (row) => [...row.children].filter((c) => cleanText(c.textContent).length > 0));
    if (height < 3 || width < 2) return null;
    const rect = el.getBoundingClientRect();
    return {
      element: el,
      kind: 'div',
      rows: height,
      cols: width,
      cells: height * width,
      area: Math.max(0, rect.width) * Math.max(0, rect.height),
      matrix,
      merges,
      label: labelFor(matrix, height, width),
    };
  }

  /** div 기반 표(카드형 그리드) 후보 탐색 */
  function detectDivGrids(root) {
    const out = [];
    const seen = new Set();
    for (const el of root.querySelectorAll('div, ul, ol, section, article')) {
      if (out.length > 40) break;
      if (seen.has(el)) continue;
      const item = detectDivGrid(el);
      if (!item) continue;
      out.push(item);
      // 부모 후보 중복 방지
      [...(el.parentElement?.children || [])].forEach((s) => seen.add(s));
    }
    return out;
  }

  function labelFor(matrix, height, width) {
    const first = matrix[0] || [];
    const caption = first.map((c) => c.v).filter(Boolean).slice(0, 3).join(' · ');
    const base = caption ? caption.slice(0, 60) : `표 ${height}×${width}`;
    return `${base} (${height}×${width})`;
  }

  function detect(root = document) {
    REGISTRY.clear();
    seq = 0;
    const found = [];

    for (const table of root.querySelectorAll('table')) {
      if (isLayoutTable(table)) continue;
      const item = detectTableElement(table);
      if (item) found.push(item);
    }
    for (const el of root.querySelectorAll('[role="table"], [role="grid"]')) {
      if (el.closest('table')) continue; // table로 이미 처리
      const item = detectRoleTable(el);
      if (item) found.push(item);
    }
    found.push(...detectDivGrids(root));

    // 같은 요소 중복 제거
    const uniq = [];
    const seenEl = new Set();
    for (const item of found) {
      if (seenEl.has(item.element)) continue;
      seenEl.add(item.element);
      uniq.push(item);
    }
    uniq.sort((a, b) => b.cells - a.cells || b.area - a.area);
    return uniq.slice(0, MAX_TABLES).map((item) => {
      const id = `t${(seq += 1)}`;
      REGISTRY.set(id, item);
      return {
        id,
        kind: item.kind,
        rows: item.rows,
        cols: item.cols,
        label: item.label,
        preview: previewOf(item.matrix),
        element: item.element,
      };
    });
  }

  function previewOf(matrix) {
    return matrix.slice(0, 3).map((row) => row.slice(0, 6).map((c) => (c.a ? c.v : '')));
  }

  function extract(id) {
    const item = REGISTRY.get(id);
    if (!item) throw new Error('표를 찾을 수 없습니다. 다시 감지해 주세요.');
    return {
      id,
      label: item.label,
      width: item.rows ? item.matrix[0]?.length || item.cols : item.cols,
      height: item.matrix.length,
      merges: item.merges,
      // 직렬화하기 쉬운 형태로 변환
      rows: item.matrix.map((row) =>
        row.map((cell) => ({ v: cell.v, h: !!cell.h, rs: cell.rs, cs: cell.cs, a: cell.a })),
      ),
    };
  }

  /** 컨텍스트 메뉴에서 쓰는 요소→표 역추적 */
  function nearestTableElement(el) {
    if (!el || !el.closest) return null;
    const direct = el.closest('table, [role="table"], [role="grid"]');
    if (direct) return direct;
    let node = el;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      const table = node.closest && node.closest('table');
      if (table) return table;
      node = node.parentElement;
    }
    return null;
  }

  /* ------------------------------------------------------------ 직렬화 */

  function padMatrix(rows) {
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    return rows.map((r) => {
      const out = r.slice();
      while (out.length < width) out.push({ v: '', h: false, a: true });
      return out;
    });
  }

  /** 병합셀 값을 펼칠지 여부 */
  function toTextMatrix(data, opts = {}) {
    const rows = padMatrix(data.rows || []);
    const filled = rows.map((row) => row.map((cell) => normalizeValue(cell.v, opts)));
    if (opts.fillSpans === false) return filled;
    for (const m of data.merges || []) {
      for (let dr = 0; dr < m.rs; dr += 1) {
        for (let dc = 0; dc < m.cs; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const r = m.r + dr;
          const c = m.c + dc;
          if (filled[r] && filled[r][c] === '') filled[r][c] = filled[m.r][m.c];
        }
      }
    }
    return filled;
  }

  function tsv(data, opts) {
    return toTextMatrix(data, opts)
      .map((row) => row.map((v) => v.replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'))
      .join('\n');
  }

  function csv(data, opts) {
    const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const body = toTextMatrix(data, opts)
      .map((row) => row.map(q).join(','))
      .join('\r\n');
    return opts && opts.bom ? `\uFEFF${body}` : body;
  }

  function json(data, opts) {
    const rows = toTextMatrix(data, opts);
    const header = rows[0] || [];
    return JSON.stringify(
      rows.slice(rows.length > 1 ? 1 : 0).map((row) => Object.fromEntries(row.map((v, i) => [header[i] || `col${i + 1}`, v]))),
      null,
      2,
    );
  }

  function markdown(data, opts) {
    const rows = toTextMatrix(data, opts);
    if (!rows.length) return '';
    const esc = (v) => v.replace(/\|/g, '\\|');
    const head = `| ${rows[0].map(esc).join(' | ')} |`;
    const sep = `| ${rows[0].map(() => '---').join(' | ')} |`;
    const body = rows.slice(1).map((r) => `| ${r.map(esc).join(' | ')} |`);
    return [head, sep, ...body].join('\n');
  }

  /* ------------------------------------------------ 페이지네이션 수집 */

  const NEXT_RE =
    /^(next|next\s?page|다음|다음\s?페이지|다음페이지|더\s?보기|load\s?more|show\s?more|more\s?results|›|»|>|→|weiter|suivant|次へ|次のページ|下一页|下一頁)$/i;

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.hidden) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** 한 스코프 안에서 '다음' 후보 수집 (텍스트 검사 → 가시성 검사 순) */
  function collectNextInScope(scope, tableEl, tableRect, isBody, container) {
    const found = [];
    for (const el of scope.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]')) {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      const text = (el.textContent || '').trim();
      let score = 0;
      if (rel.split(/\s+/).includes('next')) score = 4;
      else if (NEXT_RE.test(text) || NEXT_RE.test(aria) || NEXT_RE.test(title)) score = 3;
      else if (/next page/i.test(aria)) score = 2;
      if (!score) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (/\bdisabled\b/i.test(String(el.className || ''))) continue;
      // 다른 표 내부의 컨트롤은 제외
      const owner = el.closest('table');
      if (owner && owner !== tableEl) continue;
      // body/document 까지 내려간 경우: 표와 같은 컨테이너 안의 컨트롤만 인정
      if (isBody && container && !container.contains(el)) continue;
      const r0 = el.getBoundingClientRect();
      const distance = Math.abs(r0.top - tableRect.bottom) + Math.abs(r0.left - tableRect.left);
      if (!isVisible(el)) continue;
      found.push({ el, score, distance });
    }
    return found;
  }

  /**
   * 표 주변에서 '다음 페이지' 컨트롤 찾기.
   * 가까운 스코프(부모 → 조상)부터 검사해 첫 후보군에서 결정한다.
   * (다른 표의 '더 보기' 버튼을 잘못 누르는 것을 막는다)
   */
  function findNextControl(tableEl) {
    const tableRect = tableEl.getBoundingClientRect();
    const container =
      tableEl.closest('section, article, [role="region"], .card, .panel, .table-wrap, .table-container') ||
      tableEl.parentElement;
    const scopes = [];
    let node = tableEl.parentElement;
    for (let i = 0; i < 5 && node; i += 1) {
      scopes.push(node);
      node = node.parentElement;
    }
    for (const scope of scopes) {
      const isBody = scope === document.body || scope === document.documentElement;
      const found = collectNextInScope(scope, tableEl, tableRect, isBody, container);
      if (found.length) {
        found.sort((a, b) => b.score - a.score || a.distance - b.distance);
        return found[0].el;
      }
    }
    return null;
  }

  const rowKey = (row) => row.map((c) => (c && typeof c === 'object' ? c.v : c)).join('\u0001');

  function reextract(el) {
    if (!el) return null;
    if (el.tagName === 'TABLE') return detectTableElement(el);
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'table' || role === 'grid') return detectRoleTable(el);
    return detectDivGrid(el);
  }

  function findReplacement(headerSig, kind) {
    const selector =
      kind === 'table'
        ? 'table'
        : kind === 'role'
          ? '[role="table"], [role="grid"]'
          : 'div, ul, ol, section, article';
    let scanned = 0;
    for (const el of document.querySelectorAll(selector)) {
      scanned += 1;
      if (scanned > 400) break;
      const item = reextract(el);
      if (!item) continue;
      if (!item.matrix.length) continue;
      if (rowKey(item.matrix[0]) === headerSig) return el;
    }
    return null;
  }

  /** 표 내용이 바뀔 때까지 대기 (요소 교체도 변경으로 간주) */
  function waitForChange(tableEl, before, intervalMs = 150, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (!tableEl.isConnected) return resolve('detached');
        if (tableEl.textContent !== before) return resolve('changed');
        if (Date.now() - started > timeoutMs) return resolve('timeout');
        return setTimeout(tick, intervalMs);
      };
      setTimeout(tick, intervalMs);
    });
  }

  /**
   * '다음' 버튼을 눌러 여러 페이지를 하나로 합친다.
   * 안전장치: 최대 페이지 수, URL 변경 감지, 변화 없음 감지, 행 수 상한, 중복 행 제거
   */
  async function collectPages(id, options = {}) {
    const maxPages = Math.max(1, Math.min(50, Number(options.maxPages) || 10));
    const waitMs = Math.max(600, Math.min(8000, Number(options.waitMs) || 2500));
    const item = REGISTRY.get(id);
    if (!item) throw new Error('표를 다시 감지해 주세요.');
    let tableEl = item.element;
    if (!tableEl || !tableEl.isConnected) throw new Error('표가 사라졌습니다. 다시 감지해 주세요.');

    const headerSig = item.matrix.length ? rowKey(item.matrix[0]) : '';
    const rowsOut = [];
    const mergesOut = [];
    const seenRows = new Set();
    const startUrl = location.href;
    let pages = 1;
    let reason = 'max';
    let current = item;

    const appendPage = (data) => {
      const first = pages === 1;
      const skipHeader = !first && data.matrix.length && rowKey(data.matrix[0]) === headerSig ? 1 : 0;
      const base = rowsOut.length;
      for (let r = skipHeader; r < data.matrix.length; r += 1) {
        const row = data.matrix[r];
        const key = rowKey(row);
        if (seenRows.has(key)) continue;
        seenRows.add(key);
        rowsOut.push(row.map((c) => ({ v: c.v, h: !!c.h, rs: 1, cs: 1, a: true })));
      }
      // 병합은 페이지 1 기준으로만 유지(이후 페이지는 행 오프셋 보정, 중복 제거로 어긋날 수 있음)
      for (const m of data.merges || []) {
        if (m.r < skipHeader) continue;
        mergesOut.push({ ...m, r: m.r - skipHeader + base });
      }
      return rowsOut.length - base;
    };

    for (;;) {
      appendPage(current);
      if (pages >= maxPages) {
        reason = 'max';
        break;
      }
      const next = findNextControl(tableEl);
      if (!next) {
        reason = 'no-next';
        break;
      }
      const before = tableEl.textContent;
      try {
        next.click();
      } catch (err) {
        reason = 'click-error';
        break;
      }
      const change = await waitForChange(tableEl, before, 150, waitMs);
      if (change === 'timeout') {
        reason = 'no-change';
        break;
      }
      if (location.href !== startUrl) {
        reason = 'navigated';
        break;
      }
      if (!tableEl.isConnected) {
        const replacement = findReplacement(headerSig, item.kind);
        if (!replacement) {
          reason = 'detached';
          break;
        }
        tableEl = replacement;
      }
      const fresh = reextract(tableEl);
      if (!fresh || !fresh.matrix.length) {
        reason = 'empty';
        break;
      }
      current = fresh;
      pages += 1;
      if (rowsOut.length > 50000) {
        reason = 'too-many';
        break;
      }
    }

    const width = rowsOut.reduce((w, r) => Math.max(w, r.length), 0);
    const firstText = (rowsOut[0] || [])
      .map((c) => c.v)
      .filter(Boolean)
      .slice(0, 3)
      .join(' · ')
      .slice(0, 60);
    if (pages > 1 && rowsOut.length) {
      rowsOut[0] = rowsOut[0].map((c) => ({ ...c, h: true }));
    }
    return {
      data: {
        id,
        label: `${firstText || '표'} (${rowsOut.length}×${width})`,
        rows: rowsOut,
        merges: mergesOut,
        width,
        height: rowsOut.length,
      },
      pages,
      reason,
      url: location.href,
    };
  }

  globalThis.TableCore = {
    detect,
    extract,
    collectPages,
    nearestTableElement,
    cleanText,
    normalizeValue,
    parseNumber,
    parseDate,
    serialize: { tsv, csv, json, markdown },
    __internal: { buildGrid, toTextMatrix, findNextControl, reextract, rowKey },
  };
})();
