'use strict';

const DEFAULTS = { defaultHeader: true, defaultFill: true, defaultNumbers: false };
const $ = (id) => document.getElementById(id);
let timer = null;

function flash() {
  const el = $('saved');
  el.classList.add('on');
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('on'), 1500);
}

function apply(settings) {
  $('defaultHeader').checked = settings.defaultHeader !== false;
  $('defaultFill').checked = settings.defaultFill !== false;
  $('defaultNumbers').checked = settings.defaultNumbers === true;
}

function read() {
  return {
    defaultHeader: $('defaultHeader').checked,
    defaultFill: $('defaultFill').checked,
    defaultNumbers: $('defaultNumbers').checked,
  };
}

async function load() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  apply(settings);
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set(read());
  flash();
});

$('reset').addEventListener('click', async () => {
  await chrome.storage.local.set(DEFAULTS);
  apply(DEFAULTS);
  flash();
});

load();
