import { PAPER_SIZES } from '../lib/paper-sizes.js';
import { loadSettings, saveSettings, LAYOUT_WIDTHS, clamp } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let tab = null;
let contentMode = 'page'; // page | article
let busy = false;
let saveTimer = null;

init().catch((err) => setStatus(String(err.message || err), 'error'));

async function init() {
  populateSelects();
  settings = await loadSettings();
  bindInputs();
  render();

  // Settings must stay reachable even on pages that cannot be converted.
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  $('page-title').textContent = tab.title || tab.url || '';
  $('page-title').title = tab.url || '';

  const state = await send({ type: 'ps:page-state', tabId: tab.id });
  if (!state || !state.ok || !state.printable) {
    $('blocked').classList.remove('hidden');
    $('main').classList.add('disabled');
    $('main').inert = true; // also keep keyboard focus out of the unusable form
    $('btn-download').disabled = true;
    $('btn-open').disabled = true;
    return;
  }
  updateRemoved(state.removed || 0);
  if (state.busy) setBusy(true, 'Generating PDF…');

  $('btn-download').addEventListener('click', () => run('download'));
  $('btn-open').addEventListener('click', () => run('open'));
  $('tool-select').addEventListener('click', () => startPicker('print'));
  $('tool-remove').addEventListener('click', () => startPicker('remove'));
  $('tool-reset').addEventListener('click', async () => {
    await send({ type: 'ps:reset-page', tabId: tab.id });
    updateRemoved(0);
  });
  document.addEventListener('keydown', (ev) => {
    // Enter on a focused control activates that control; only a bare Enter means "download".
    if (ev.key === 'Enter' && !busy && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement.tagName)) run('download');
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ps:progress' && msg.tabId === tab.id) {
      if (msg.stage === 'done') return;
      setBusy(true, msg.message);
    }
  });
}

function populateSelects() {
  const format = $('format');
  for (const p of PAPER_SIZES) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    format.appendChild(o);
  }
  const lw = $('layoutWidth');
  for (const w of LAYOUT_WIDTHS) {
    const o = document.createElement('option');
    o.value = w.id;
    o.textContent = w.label;
    lw.appendChild(o);
  }
}

// --- settings <-> UI --------------------------------------------------------------------

const CHECKBOXES = ['printBackground', 'hideFixed', 'loadLazy', 'outline', 'headerFooter', 'hfTitle', 'hfDate', 'hfUrl', 'hfPageNumbers'];

function bindInputs() {
  for (const seg of document.querySelectorAll('.seg')) {
    const key = seg.dataset.key;
    seg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-value]');
      if (!btn) return;
      if (key === 'contentMode') contentMode = btn.dataset.value;
      else update({ [key]: btn.dataset.value });
      render();
    });
  }
  $('format').addEventListener('change', (e) => update({ format: e.target.value }));
  $('marginPreset').addEventListener('change', (e) => update({ marginPreset: e.target.value }));
  $('layoutWidth').addEventListener('change', (e) => update({ layoutWidth: e.target.value }));
  for (const side of ['top', 'right', 'bottom', 'left']) {
    $('m-' + side).addEventListener('input', (e) => {
      update({ margins: { ...settings.margins, [side]: clamp(Number(e.target.value) || 0, 0, 100) } }, false);
    });
  }
  $('scale').addEventListener('input', (e) => {
    update({ scale: Number(e.target.value) / 100 }, false);
    $('scale-value').textContent = `${e.target.value}%`;
  });
  $('mediaScreen').addEventListener('change', (e) => update({ mediaView: e.target.checked ? 'screen' : 'print' }));
  $('pageRanges').addEventListener('input', (e) => update({ pageRanges: e.target.value }, false));
  for (const id of CHECKBOXES) {
    $(id).addEventListener('change', (e) => update({ [id]: e.target.checked }));
  }
}

function update(patch, rerender = true) {
  Object.assign(settings, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(settings).catch(console.error), 150);
  if (rerender) render();
}

function render() {
  for (const seg of document.querySelectorAll('.seg')) {
    const key = seg.dataset.key;
    const value = key === 'contentMode' ? contentMode : settings[key];
    for (const b of seg.querySelectorAll('button')) {
      const on = b.dataset.value === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  $('format').value = settings.format;
  $('marginPreset').value = settings.marginPreset;
  $('layoutWidth').value = settings.layoutWidth;
  $('custom-margins').classList.toggle('hidden', settings.marginPreset !== 'custom');
  for (const side of ['top', 'right', 'bottom', 'left']) $('m-' + side).value = settings.margins[side];
  const pct = Math.round(settings.scale * 100);
  $('scale').value = pct;
  $('scale-value').textContent = settings.layoutWidth === 'auto' ? `${pct}%` : 'auto (fit width)';
  $('scale').disabled = settings.layoutWidth !== 'auto';
  $('scale-row').classList.toggle('disabled', settings.layoutWidth !== 'auto');
  $('mediaScreen').checked = settings.mediaView === 'screen';
  $('pageRanges').value = settings.pageRanges || '';
  for (const id of CHECKBOXES) $(id).checked = !!settings[id];
  $('hf-options').classList.toggle('hidden', !settings.headerFooter);
  $('ranges-row').classList.toggle('hidden', settings.layout === 'single');
  $('btn-download').textContent = contentMode === 'article' ? 'Download article PDF' : 'Download PDF';
}

function updateRemoved(n) {
  $('removed-count').textContent = String(n);
  $('tool-reset').classList.toggle('hidden', !n);
}

// --- actions ----------------------------------------------------------------------------

async function run(output) {
  if (busy) return;
  clearTimeout(saveTimer);
  await saveSettings(settings);
  setBusy(true, 'Preparing page…');
  const res = await send({
    type: 'ps:generate',
    tabId: tab.id,
    prep: contentMode === 'article' ? 'article' : 'none',
    output,
    settings,
  });
  setBusy(false);
  if (!res || !res.ok) {
    setStatus((res && res.error) || 'Something went wrong.', 'error');
    return;
  }
  const done = output === 'open' ? 'Preview opened in a new tab.' : `Saved ${res.filename}`;
  setStatus(res.warning ? `${done} ${res.warning}` : done, 'ok');
}

async function startPicker(mode) {
  clearTimeout(saveTimer);
  await saveSettings(settings);
  const res = await send({ type: 'ps:start-picker', tabId: tab.id, mode });
  if (!res || !res.ok) {
    setStatus((res && res.error) || 'Could not start the picker.', 'error');
    return;
  }
  window.close();
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: String(err.message || err) }));
}

function setBusy(on, message) {
  busy = on;
  $('btn-download').disabled = on;
  $('btn-open').disabled = on;
  $('tool-select').disabled = on;
  $('tool-remove').disabled = on;
  if (on) setStatus(message || 'Working…', 'busy');
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.className = 'status' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
  el.textContent = '';
  if (kind === 'busy') {
    const s = document.createElement('span');
    s.className = 'spinner';
    el.appendChild(s);
  }
  el.appendChild(document.createTextNode(text || ''));
}
