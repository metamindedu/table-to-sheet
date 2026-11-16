/**
 * content.js — page <-> extension glue
 *  - 팝업의 TS_DETECT / TS_EXTRACT 요청 처리
 *  - 컨텍스트 메뉴(이 표를 클립보드로) 처리
 */
(() => {
  'use strict';
  if (globalThis.__TS_GLUE__) return;
  globalThis.__TS_GLUE__ = true;

  let lastContextTarget = null;
  document.addEventListener(
    'contextmenu',
    (e) => {
      lastContextTarget = e.target;
    },
    true,
  );

  function toast(message) {
    const id = 'table-to-sheet-toast';
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = id;
    el.textContent = message;
    el.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:24px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'padding:10px 16px',
      'border-radius:10px',
      'background:rgba(18,21,28,.95)',
      'color:#fff',
      'font:600 13px/1.4 "Malgun Gothic",system-ui,sans-serif',
      'box-shadow:0 10px 28px rgba(0,0,0,.35)',
      'pointer-events:none',
      'transition:opacity .2s',
    ].join(';');
    document.documentElement.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 1800);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      /* fallback */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function findContextTable() {
    const el = TableCore.nearestTableElement(lastContextTarget);
    if (!el) return null;
    const list = TableCore.detect(document);
    return list.find((t) => t.element === el || t.element.contains(el) || el.contains(t.element)) || null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    try {
      if (msg.type === 'TS_DETECT') {
        const tables = TableCore.detect(document).map(({ element, ...rest }) => rest);
        sendResponse({ ok: true, tables });
        return;
      }
      if (msg.type === 'TS_EXTRACT') {
        sendResponse({ ok: true, data: TableCore.extract(msg.id) });
        return;
      }
      if (msg.type === 'TS_CONTEXT_COPY') {
        const hit = findContextTable();
        if (!hit) {
          sendResponse({ ok: false, error: '이 위치에서 표를 찾지 못했습니다.' });
          return;
        }
        const data = TableCore.extract(hit.id);
        const text = TableCore.serialize.tsv(data, { fillSpans: true });
        copyText(text).then((ok) => {
          toast(ok ? `표를 클립보드에 복사했습니다 (${data.height}×${data.width})` : '클립보드 복사에 실패했습니다');
          sendResponse({ ok, rows: data.height, cols: data.width });
        });
        return true; // async
      }
      if (msg.type === 'TS_COLLECT') {
        TableCore.collectPages(msg.id, { maxPages: msg.maxPages, waitMs: msg.waitMs })
          .then((res) => sendResponse({ ok: true, ...res }))
          .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
        return true; // async
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  });
})();
