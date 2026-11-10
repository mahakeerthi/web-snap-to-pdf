import { applyTheme, normalizeTheme, reveal } from '../lib/theme.js';
import { loadSettings, saveSettings, normalizeSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { buildFilename } from '../lib/print-params.js';
import { SUPPORTED_LANGUAGES, resolveLanguage, getMessages, t, applyTranslations } from '../lib/i18n.js';

const $ = (id) => document.getElementById(id);
let settings = await loadSettings();
let messages = await getMessages(settings.language);
let savedTimer = null;
let lastSaved = null; // JSON of our own last write, to ignore our own storage.onChanged echo

for (const l of SUPPORTED_LANGUAGES) {
  const o = document.createElement('option');
  o.value = l.code;
  o.textContent = l.label;
  $('language').appendChild(o);
}

function localize() {
  document.documentElement.lang = resolveLanguage(settings.language).replace('_', '-');
  document.title = t(messages, 'options_pageTitle');
  applyTranslations(document, messages);
  for (const o of $('language').options) {
    if (o.value === 'auto' && messages.lang_auto) o.textContent = messages.lang_auto;
  }
  $('version').textContent = t(messages, 'footer_version', [chrome.runtime.getManifest().version]);
}

function render() {
  applyTheme(settings.theme);
  $('theme').value = normalizeTheme(settings.theme);
  $('language').value = SUPPORTED_LANGUAGES.some((l) => l.code === settings.language)
    ? settings.language
    : 'auto';
  $('filenameTemplate').value = settings.filenameTemplate;
  $('saveAs').checked = !!settings.saveAs;
  $('expandScroll').checked = settings.expandScroll !== false;
  $('imageScale').value = String(
    [1, 2, 3].includes(Number(settings.imageScale)) ? Number(settings.imageScale) : 2,
  );
  $('preferCssPageSize').checked = !!settings.preferCssPageSize;
  $('markdownEnabled').checked = !!settings.markdownEnabled;
  $('filename-preview').textContent = buildFilename(settings.filenameTemplate, {
    title: 'Example Page',
    domain: 'example.com',
  });
}

function flash(key) {
  $('saved').textContent = t(messages, key);
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('saved').textContent = ''), 1500);
}

async function persist() {
  lastSaved = JSON.stringify(normalizeSettings(settings));
  await saveSettings(settings);
}

async function update(patch, { rerender = true } = {}) {
  Object.assign(settings, patch);
  await persist();
  if (rerender) render();
  flash('options_saved');
}

async function setLanguage(language) {
  messages = await getMessages(language);
  await update({ language });
  localize();
}

// --- experimental: Markdown export needs an explicit confirmation to turn on -------------------
function showMarkdownConfirm(show) {
  $('markdown-confirm').classList.toggle('hidden', !show);
  if (show) $('markdown-cancel').focus();
}

$('markdownEnabled').addEventListener('change', (e) => {
  if (e.target.checked && !settings.markdownEnabled) {
    e.target.checked = false; // not enabled until confirmed
    showMarkdownConfirm(true);
    return;
  }
  showMarkdownConfirm(false);
  update({ markdownEnabled: e.target.checked });
});
$('markdown-enable').addEventListener('click', async () => {
  showMarkdownConfirm(false);
  await update({ markdownEnabled: true });
  $('markdownEnabled').focus();
});
$('markdown-cancel').addEventListener('click', () => {
  showMarkdownConfirm(false);
  $('markdownEnabled').focus();
});
$('markdown-confirm').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    showMarkdownConfirm(false);
    $('markdownEnabled').focus();
  }
});

// --- other fields --------------------------------------------------------------------------------
$('theme').addEventListener('change', (e) => update({ theme: e.target.value }));
$('language').addEventListener('change', (e) => setLanguage(e.target.value).catch(console.warn));
$('filenameTemplate').addEventListener('input', (e) =>
  update({ filenameTemplate: e.target.value || '{title}' }, { rerender: false }).then(() => {
    $('filename-preview').textContent = buildFilename(settings.filenameTemplate, {
      title: 'Example Page',
      domain: 'example.com',
    });
  }),
);
$('saveAs').addEventListener('change', (e) => update({ saveAs: e.target.checked }));
$('expandScroll').addEventListener('change', (e) => update({ expandScroll: e.target.checked }));
$('imageScale').addEventListener('change', (e) => update({ imageScale: Number(e.target.value) }));
$('preferCssPageSize').addEventListener('change', (e) => update({ preferCssPageSize: e.target.checked }));
$('open-shortcuts').addEventListener('click', () =>
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
);
$('reset').addEventListener('click', async () => {
  settings = { ...DEFAULT_SETTINGS };
  await persist();
  messages = await getMessages(settings.language);
  showMarkdownConfirm(false);
  localize();
  render();
  flash('options_resetDone');
});

// Keep in sync with changes made in the popup (theme toggle, language) while this page is open.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !changes.settings || !changes.settings.newValue) return;
  const next = normalizeSettings(changes.settings.newValue);
  if (JSON.stringify(next) === lastSaved) return;
  const languageChanged = next.language !== settings.language;
  settings = next;
  if (languageChanged) {
    messages = await getMessages(settings.language);
    localize();
  }
  render();
});

localize();
render();
reveal();
