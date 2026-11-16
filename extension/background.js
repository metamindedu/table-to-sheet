/**
 * background.js — 컨텍스트 메뉴 등록/처리
 * 표 우클릭 → "이 표를 클립보드로 복사"
 */
'use strict';

const MENU_ID = 'table-to-sheet-copy';
const CONTENT_FILES = ['content/table-core.js', 'content/content.js'];

function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '표 따오기 — 이 표를 클립보드로 복사',
      contexts: ['all'],
    });
  });
}

chrome.runtime.onInstalled.addListener(registerMenus);
chrome.runtime.onStartup.addListener(registerMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [info.frameId || 0] }, files: CONTENT_FILES });
    await chrome.tabs.sendMessage(tab.id, { type: 'TS_CONTEXT_COPY' }, { frameId: info.frameId || 0 });
  } catch (err) {
    console.warn('[Table to Sheet] 컨텍스트 메뉴 처리 실패:', err);
  }
});
