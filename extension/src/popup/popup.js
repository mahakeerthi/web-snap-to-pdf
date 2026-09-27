import { applyTheme, nextTheme, normalizeTheme, reveal } from '../lib/theme.js';
import { PAPER_SIZES } from '../lib/paper-sizes.js';
import { loadSettings, saveSettings, LAYOUT_WIDTHS, clamp } from '../lib/settings.js';
import { buildPrintParams } from '../lib/print-params.js';
import { SUPPORTED_LANGUAGES, resolveLanguage, getMessages, t, applyTranslations } from '../lib/i18n.js';

const $ = (id) => document.getElementById(id);
const ADVANCED_OPEN_KEY = 'popupExportSettingsOpen'; // chrome.storage.local
const MM_PER_INCH = 25.4;

let settings = null;
let messages = {};
let tab = null;
let busy = false;
let removedCount = 0;
let saveTimer = null;

init().catch((err) => {
  reveal();
  setStatus(String((err && err.message) || err), 'error');
});

async function init() {
  const [loaded, local] = await Promise.all([
    loadSettings(),
    chrome.storage.local.get(ADVANCED_OPEN_KEY).catch(() => ({})),
  ]);
  settings = loaded;
  applyTheme(settings.theme);
  messages = await getMessages(settings.language);

  populateSelects();
  localize();
  setAdvancedOpen(!!local[ADVANCED_OPEN_KEY], false);
  bindInputs();
  bindChrome();
  render();
  reveal();

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const pageTitle = $('page-title');
  pageTitle.removeAttribute('data-i18n'); // the tab title must not be re-translated
  pageTitle.textContent = tab.title || tab.url || '';
  pageTitle.title = tab.url || '';

  const state = await send({ type: 'ps:page-state', tabId: tab.id });
  if (!state || !state.ok || !state.printable) {
    $('blocked').classList.remove('hidden');
    $('actions').classList.add('disabled');
    $('actions').inert = true; // keep keyboard focus out of actions that cannot work here
    document.body.dataset.state = 'blocked';
    return;
  }
  document.body.dataset.state = 'ready';
  updateRemoved(state.removed || 0);
  if (state.busy) setBusy(true, tr('status_generating'));

  $('act-page').addEventListener('click', () => run('none', 'download'));
  $('act-page-preview').addEventListener('click', () => run('none', 'open'));
  $('act-article').addEventListener('click', () => run('article', 'download'));
  $('act-article-preview').addEventListener('click', () => run('article', 'open'));
  $('act-select').addEventListener('click', () => startPicker('print'));
  $('act-remove').addEventListener('click', () => startPicker('remove'));
  $('act-reset').addEventListener('click', async () => {
    const res = await send({ type: 'ps:reset-page', tabId: tab.id });
    if (res && res.ok === false) setStatus(res.error || tr('status_error'), 'error');
    else updateRemoved(0);
  });
  $('md-page').addEventListener('click', () => exportMarkdown('none'));
  $('md-article').addEventListener('click', () => exportMarkdown('article'));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ps:progress' && msg.tabId === tab.id) {
      if (msg.stage === 'done') return;
      setBusy(true, msg.message);
    }
  });
}

// --- i18n ------------------------------------------------------------------------------------

/** Translate with an explicit English fallback (for keys built from ids). */
function tr(key, subs, fallback) {
  if (fallback !== undefined && !(key in messages)) return fallback;
  return t(messages, key, subs);
}

function localize() {
  document.documentElement.lang = resolveLanguage(settings.language).replace('_', '-');
  applyTranslations(document, messages);
  for (const o of $('format').options) {
    const p = PAPER_SIZES.find((x) => x.id === o.value);
    o.textContent = tr(`paper_${o.value}`, [], p ? p.label : o.value);
  }
  for (const o of $('layoutWidth').options) {
    const w = LAYOUT_WIDTHS.find((x) => x.id === o.value);
    o.textContent = tr(`layoutWidth_${o.value}`, [], w ? w.label : o.value);
  }
  for (const o of $('language').options) {
    const l = SUPPORTED_LANGUAGES.find((x) => x.code === o.value);
    o.textContent = o.value === 'auto' ? tr('lang_autoShort', [], 'Auto') : l.label; // compact footer
  }
  $('version').textContent = tr('footer_version', [chrome.runtime.getManifest().version]);
}

async function setLanguage(language) {
  update({ language });
  messages = await getMessages(language);
  localize();
  render();
}

// --- settings <-> UI -------------------------------------------------------------------------

function populateSelects() {
  const fill = (select, items) => {
    for (const [value, label] of items) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      select.appendChild(o);
    }
  };
  fill(
    $('format'),
    PAPER_SIZES.map((p) => [p.id, p.label]),
  );
  fill(
    $('layoutWidth'),
    LAYOUT_WIDTHS.map((w) => [w.id, w.label]),
  );
  fill(
    $('language'),
    SUPPORTED_LANGUAGES.map((l) => [l.code, l.label]),
  );
}

const CHECKBOXES = [
  'printBackground',
  'hideFixed',
  'loadLazy',
  'outline',
  'headerFooter',
  'hfTitle',
  'hfDate',
  'hfUrl',
  'hfPageNumbers',
];

function bindInputs() {
  for (const seg of document.querySelectorAll('.seg')) {
    const key = seg.dataset.key;
    seg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-value]');
      if (btn) update({ [key]: btn.dataset.value });
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
  $('scale').addEventListener('input', (e) => update({ scale: Number(e.target.value) / 100 }, false));
  $('mediaScreen').addEventListener('change', (e) =>
    update({ mediaView: e.target.checked ? 'screen' : 'print' }),
  );
  $('pageRanges').addEventListener('input', (e) => update({ pageRanges: e.target.value }, false));
  for (const id of CHECKBOXES) $(id).addEventListener('change', (e) => update({ [id]: e.target.checked }));
}

/** Header, disclosure and footer controls: usable even on pages that cannot be converted. */
function bindChrome() {
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('theme-toggle').addEventListener('click', () => {
    const theme = nextTheme(settings.theme);
    applyTheme(theme);
    update({ theme });
  });
  $('toggle-advanced').addEventListener('click', () => {
    setAdvancedOpen($('toggle-advanced').getAttribute('aria-expanded') !== 'true', true);
  });
  $('language').addEventListener('change', (e) => setLanguage(e.target.value).catch(console.warn));
  const openShortcuts = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  $('btn-shortcuts').addEventListener('click', openShortcuts);
  $('help-shortcuts').addEventListener('click', openShortcuts);
  $('btn-help').addEventListener('click', () => $('help').showModal());
  $('help-close').addEventListener('click', () => $('help').close());
  // Settings changed elsewhere (options page) while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.settings || !changes.settings.newValue || saveTimer) return;
    const next = changes.settings.newValue;
    if (next.markdownEnabled !== settings.markdownEnabled || next.theme !== settings.theme) {
      settings.markdownEnabled = !!next.markdownEnabled;
      settings.theme = next.theme;
      render();
    }
  });
}

function setAdvancedOpen(open, persist) {
  $('toggle-advanced').setAttribute('aria-expanded', String(open));
  $('advanced').hidden = !open;
  if (persist) chrome.storage.local.set({ [ADVANCED_OPEN_KEY]: open }).catch(() => {});
}

function update(patch, rerender = true) {
  Object.assign(settings, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSettings(settings).catch(console.warn);
  }, 150);
  if (rerender) render();
  else renderSummary(); // the summary line must always reflect the current values
}

function render() {
  for (const seg of document.querySelectorAll('.seg')) {
    const value = settings[seg.dataset.key];
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
  $('scale-value').textContent = `${pct}%`;
  $('scale-row').classList.toggle('hidden', settings.layoutWidth !== 'auto');
  $('mediaScreen').checked = settings.mediaView === 'screen';
  $('pageRanges').value = settings.pageRanges || '';
  for (const id of CHECKBOXES) $(id).checked = !!settings[id];
  $('hf-options').classList.toggle('hidden', !settings.headerFooter);
  $('ranges-row').classList.toggle('hidden', settings.layout === 'single');
  $('md-row').classList.toggle('hidden', !settings.markdownEnabled);
  $('language').value = SUPPORTED_LANGUAGES.some((l) => l.code === settings.language)
    ? settings.language
    : 'auto';

  const theme = normalizeTheme(settings.theme);
  const toggle = $('theme-toggle');
  toggle.dataset.mode = theme;
  const themeLabel = tr('theme_toggle', [tr(`theme_${theme}`)]);
  toggle.setAttribute('aria-label', themeLabel);
  toggle.title = themeLabel;

  $('reset-label').textContent = tr('action_reset', [removedCount]);
  renderSummary();
}

/** "A4 · Portrait · 10 mm margins · Backgrounds on" — the effective values, incl. derived ones. */
function summaryText(s) {
  const parts = [s.format, tr(s.orientation === 'landscape' ? 'summary_landscape' : 'summary_portrait')];
  const { margins } = buildPrintParams(s); // includes the header/footer minimum margin
  const mm = ['top', 'right', 'bottom', 'left'].map((k) => Math.round(margins[k] * MM_PER_INCH));
  if (mm.every((v) => v === 0)) parts.push(tr('summary_noMargins'));
  else if (mm.every((v) => v === mm[0])) parts.push(tr('summary_margins', [mm[0]]));
  else parts.push(tr('summary_customMargins', [mm.join('/')]));
  if (s.layoutWidth && s.layoutWidth !== 'auto') parts.push(tr('summary_width', [s.layoutWidth]));
  else if (Math.round(s.scale * 100) !== 100) parts.push(tr('summary_scale', [Math.round(s.scale * 100)]));
  parts.push(tr(s.printBackground ? 'summary_backgroundsOn' : 'summary_backgroundsOff'));
  if (s.mediaView === 'screen') parts.push(tr('summary_screenStyles'));
  if (s.headerFooter) parts.push(tr('summary_headerFooter'));
  const ranges = String(s.pageRanges || '').trim();
  if (ranges && s.layout !== 'single') parts.push(tr('summary_pages', [ranges]));
  return parts.join(' · ');
}

function renderSummary() {
  $('summary').textContent = summaryText(settings);
  $('scale-value').textContent = `${Math.round(settings.scale * 100)}%`;
}

function updateRemoved(n) {
  removedCount = n;
  $('reset-label').textContent = tr('action_reset', [n]);
  $('act-reset').classList.toggle('hidden', !n);
}

// --- actions -----------------------------------------------------------------------------------

async function flushSettings() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveSettings(settings);
}

async function run(prep, output) {
  if (busy || !tab) return;
  setBusy(true, tr('status_preparing')); // synchronously, so a second click/Enter is ignored
  try {
    await flushSettings();
    const res = await send({ type: 'ps:generate', tabId: tab.id, prep, output, settings });
    showResult(res, output === 'open' ? tr('status_previewOpened') : null);
  } catch (err) {
    setStatus(String((err && err.message) || err), 'error');
  } finally {
    if (busy) setBusy(false);
  }
}

/** Status line for a ps:generate / ps:export-markdown response ({ok, filename, warning} | {ok:false, error}). */
function showResult(res, doneText) {
  setBusy(false);
  if (!res || !res.ok) {
    setStatus((res && res.error) || tr('status_error'), 'error');
    return;
  }
  const done = doneText || tr('status_saved', [res.filename]);
  setStatus(res.warning ? `${done} ${res.warning}` : done, 'ok');
}

async function exportMarkdown(prep) {
  if (busy || !tab || !settings.markdownEnabled) return;
  setBusy(true, tr('status_exportingMarkdown'));
  try {
    await flushSettings();
    showResult(await send({ type: 'ps:export-markdown', tabId: tab.id, prep }), null);
  } catch (err) {
    setStatus(String((err && err.message) || err), 'error');
  } finally {
    if (busy) setBusy(false);
  }
}

async function startPicker(mode) {
  if (busy || !tab) return;
  try {
    await flushSettings();
    const res = await send({ type: 'ps:start-picker', tabId: tab.id, mode });
    if (res && res.ok) {
      window.close();
      return;
    }
    setStatus((res && res.error) || tr('status_pickerError'), 'error');
  } catch (err) {
    setStatus(String((err && err.message) || err), 'error');
  }
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: String(err.message || err) }));
}

function setBusy(on, message) {
  busy = on;
  for (const id of [
    'act-page',
    'act-page-preview',
    'act-article',
    'act-article-preview',
    'act-select',
    'act-remove',
    'act-reset',
    'md-page',
    'md-article',
  ]) {
    $(id).disabled = on;
  }
  if (on) setStatus(message || tr('status_working'), 'busy');
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.className = 'status' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
  el.textContent = '';
  if (kind === 'busy') {
    const s = document.createElement('span');
    s.className = 'spinner';
    s.setAttribute('aria-hidden', 'true');
    el.appendChild(s);
  }
  const span = document.createElement('span');
  span.textContent = text || '';
  el.appendChild(span);
}
