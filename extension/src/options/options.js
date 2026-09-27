import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { buildFilename } from '../lib/print-params.js';

const $ = (id) => document.getElementById(id);
let settings = await loadSettings();

function render() {
  $('filenameTemplate').value = settings.filenameTemplate;
  $('saveAs').checked = !!settings.saveAs;
  $('output').value = settings.output;
  $('expandScroll').checked = settings.expandScroll !== false;
  $('preferCssPageSize').checked = !!settings.preferCssPageSize;
  $('filename-preview').textContent = buildFilename(settings.filenameTemplate, { title: 'Example Page', domain: 'example.com' });
}

async function update(patch) {
  Object.assign(settings, patch);
  await saveSettings(settings);
  render();
  $('saved').textContent = 'Saved';
  setTimeout(() => ($('saved').textContent = ''), 1500);
}

$('filenameTemplate').addEventListener('input', (e) => update({ filenameTemplate: e.target.value || '{title}' }));
$('saveAs').addEventListener('change', (e) => update({ saveAs: e.target.checked }));
$('output').addEventListener('change', (e) => update({ output: e.target.value }));
$('expandScroll').addEventListener('change', (e) => update({ expandScroll: e.target.checked }));
$('preferCssPageSize').addEventListener('change', (e) => update({ preferCssPageSize: e.target.checked }));
$('open-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('reset').addEventListener('click', async () => {
  settings = { ...DEFAULT_SETTINGS };
  await saveSettings(settings);
  render();
  $('saved').textContent = 'Settings reset to defaults';
});

render();
