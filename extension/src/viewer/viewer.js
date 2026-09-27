import { initTheme, reveal } from '../lib/theme.js';
import { loadSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const jobId = new URLSearchParams(location.search).get('job');

initTheme().finally(reveal);

$('btn-close').addEventListener('click', () => window.close());

async function main() {
  if (!jobId) return fail('No preview job specified.');
  const res = await chrome.runtime
    .sendMessage({ type: 'ps:get-job', id: jobId })
    .catch((e) => ({ ok: false, error: String(e) }));
  if (!res || !res.ok) return fail((res && res.error) || 'Preview unavailable.');
  const { base64, filename, autoDownload } = res.job;
  const settings = await loadSettings();
  const bytes = decode(base64);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  document.title = `${filename} – PageSnap PDF`;
  $('filename').textContent = filename;
  $('size').textContent = formatBytes(bytes.length);
  $('frame').src = url;

  const download = () =>
    chrome.downloads
      .download({ url, filename, saveAs: !!settings.saveAs, conflictAction: 'uniquify' })
      .catch((e) => fail('Download failed: ' + e.message));
  $('btn-download').disabled = false;
  $('btn-download').addEventListener('click', download);
  if (autoDownload) download();

  // The worker no longer needs to hold the bytes.
  chrome.runtime.sendMessage({ type: 'ps:discard-job', id: jobId }).catch(() => {});
}

function decode(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fail(text) {
  $('filename').textContent = 'Preview unavailable';
  const m = $('message');
  m.textContent = text;
  m.classList.remove('hidden');
  $('frame').classList.add('hidden');
}

main();
