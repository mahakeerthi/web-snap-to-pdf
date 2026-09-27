// PageSnap PDF - background service worker.
// Orchestrates: content-script preparation -> chrome.debugger Page.printToPDF -> download / preview.
import { loadSettings, normalizeSettings } from './lib/settings.js';
import { buildPrintParams, layoutWidthPx, buildFilename } from './lib/print-params.js';
import { MAX_PAGE_INCHES, CSS_PX_PER_INCH } from './lib/paper-sizes.js';

const PROTOCOL_VERSION = '1.3';
const CONTENT_SCRIPT = 'src/content.js';
const VIEWER_PAGE = 'src/viewer/viewer.html';
const PREVIEW_TTL_MS = 15 * 60 * 1000;

const activeJobs = new Set(); // tabIds currently generating
const previewJobs = new Map(); // jobId -> { base64, filename, title, autoDownload, createdAt }

class UserError extends Error {}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate a PDF for a tab.
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {object} [opts.settings]  Overrides; defaults to saved settings.
 * @param {'none'|'article'|'element'} [opts.prep]
 * @param {'download'|'open'|'return'} [opts.output]
 */
export async function generate({ tabId, settings, prep = 'none', output }) {
  settings = normalizeSettings(settings || (await loadSettings()));
  output = output || settings.output || 'download';
  if (activeJobs.has(tabId)) throw new UserError('A PDF is already being generated for this tab.');
  activeJobs.add(tabId);

  const target = { tabId };
  let attached = false;
  let prepared = false;
  let mediaEmulated = false;
  let metricsOverridden = false;
  let warning = null;

  try {
    const tab = await chrome.tabs.get(tabId);
    assertPrintable(tab);

    progress(tabId, 'prepare', 'Preparing page…');
    await ensureContentScript(tabId);
    const prepResult = await sendContent(tabId, {
      type: 'ps:prepare',
      prep,
      hideFixed: settings.hideFixed,
      loadLazy: settings.loadLazy,
      expandScroll: settings.expandScroll !== false,
    });
    prepared = true;
    if (!prepResult || !prepResult.ok) {
      throw new UserError((prepResult && prepResult.error) || 'Could not prepare the page.');
    }

    await attach(tabId);
    attached = true;

    const { params, paper, margins, scale } = buildPrintParams(settings);
    const media = settings.mediaView === 'screen' ? 'screen' : 'print';

    if (media === 'screen') {
      await cdp(target, 'Emulation.setEmulatedMedia', { media: 'screen' });
      mediaEmulated = true;
    }

    if (settings.layout === 'single') {
      progress(tabId, 'measure', 'Measuring page…');
      if (!mediaEmulated) {
        await cdp(target, 'Emulation.setEmulatedMedia', { media: 'print' });
        mediaEmulated = true;
      }
      const widthPx = layoutWidthPx(paper, margins, scale);
      await cdp(target, 'Emulation.setDeviceMetricsOverride', {
        width: widthPx,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      metricsOverridden = true;
      await sleep(200);
      const contentHeightPx = await measureContentHeight(target, tabId);
      const heightIn = (contentHeightPx * scale) / CSS_PX_PER_INCH + margins.top + margins.bottom + 0.1;
      params.paperWidth = paper.width;
      params.paperHeight = Math.min(MAX_PAGE_INCHES, Math.max(1, heightIn));
      if (heightIn > MAX_PAGE_INCHES) {
        warning = `The page is longer than PDF viewers allow for a single page (${MAX_PAGE_INCHES} in), so it was split into ${Math.ceil(heightIn / MAX_PAGE_INCHES)} tall pages.`;
      }
      delete params.pageRanges;
      params.preferCSSPageSize = false;
    }

    progress(tabId, 'render', 'Rendering PDF…');
    const { data } = await printToPdf(target, params);

    const filename = buildFilename(settings.filenameTemplate, {
      title: (prepResult.title || tab.title || '').trim(),
      domain: hostnameOf(tab.url),
    });

    if (output === 'return') {
      return { ok: true, base64: data, filename, warning };
    }
    progress(tabId, 'save', output === 'open' ? 'Opening preview…' : 'Saving…');
    if (output === 'open') {
      await openPreview({ base64: data, filename, title: tab.title, autoDownload: false });
    } else {
      try {
        await download(data, filename, settings.saveAs);
      } catch (err) {
        // Fallback: let the viewer page create a Blob URL and download from there.
        console.warn('Direct download failed, falling back to viewer', err);
        await openPreview({ base64: data, filename, title: tab.title, autoDownload: true });
      }
    }
    flashBadge(tabId, '✓', '#1b873f');
    return { ok: true, filename, bytes: Math.floor((data.length * 3) / 4), warning };
  } catch (err) {
    flashBadge(tabId, '!', '#d0342c');
    throw toUserFacing(err);
  } finally {
    if (metricsOverridden) await cdp(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    if (mediaEmulated) await cdp(target, 'Emulation.setEmulatedMedia', { media: '' }).catch(() => {});
    if (attached) await chrome.debugger.detach(target).catch(() => {});
    if (prepared) sendContent(tabId, { type: 'ps:restore' }).catch(() => {});
    activeJobs.delete(tabId);
    progress(tabId, 'done', '');
  }
}

// ---------------------------------------------------------------------------
// Debugger helpers
// ---------------------------------------------------------------------------

function cdp(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params || {});
}

async function attach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/already attached/i.test(msg)) {
      throw new UserError('Another tool (usually DevTools) is attached to this tab. Close it and try again.');
    }
    if (/cannot access|cannot attach|not allowed|restricted/i.test(msg)) {
      throw new UserError('Chrome does not allow extensions to convert this page.');
    }
    throw err;
  }
}

async function printToPdf(target, params) {
  try {
    return await cdp(target, 'Page.printToPDF', params);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (params.generateDocumentOutline && /generateDocumentOutline|Invalid parameters/i.test(msg)) {
      const { generateDocumentOutline, ...rest } = params;
      return cdp(target, 'Page.printToPDF', rest);
    }
    if (/Detached while handling command|canceled/i.test(msg)) {
      throw new UserError('PDF generation was cancelled.');
    }
    throw err;
  }
}

async function measureContentHeight(target, tabId) {
  try {
    const m = await cdp(target, 'Page.getLayoutMetrics');
    const size = m.cssContentSize || m.contentSize;
    if (size && size.height > 0) return Math.ceil(size.height);
  } catch (err) {
    console.warn('getLayoutMetrics failed', err);
  }
  const r = await sendContent(tabId, { type: 'ps:measure' }).catch(() => null);
  return (r && r.height) || 1000;
}

// ---------------------------------------------------------------------------
// Content script helpers
// ---------------------------------------------------------------------------

async function ping(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ps:ping' });
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (await ping(tabId)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(msg)) {
      throw new UserError('Chrome does not allow extensions to access this page.');
    }
    throw err;
  }
  if (!(await ping(tabId))) {
    throw new UserError('Could not reach the page content. Reload the page and try again.');
  }
}

function sendContent(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

async function download(base64, filename, saveAs) {
  const url = 'data:application/pdf;base64,' + base64;
  const id = await chrome.downloads.download({
    url,
    filename,
    saveAs: !!saveAs,
    conflictAction: 'uniquify',
  });
  if (typeof id !== 'number') throw new Error(chrome.runtime.lastError?.message || 'Download did not start');
  return id;
}

async function openPreview(job) {
  const id = crypto.randomUUID();
  const record = { ...job, createdAt: Date.now() };
  previewJobs.set(id, record);
  // Best effort persistence in case the worker is shut down before the viewer asks for the job.
  try {
    await chrome.storage.session.set({ ['job:' + id]: record });
  } catch (err) {
    console.warn('session storage unavailable for preview job', err);
  }
  setTimeout(() => discardJob(id), PREVIEW_TTL_MS);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`${VIEWER_PAGE}?job=${id}`) });
  return id;
}

async function takeJob(id) {
  let job = previewJobs.get(id);
  if (!job) {
    try {
      const stored = await chrome.storage.session.get('job:' + id);
      job = stored['job:' + id];
    } catch {
      /* ignore */
    }
  }
  return job || null;
}

function discardJob(id) {
  previewJobs.delete(id);
  chrome.storage.session.remove('job:' + id).catch(() => {});
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function assertPrintable(tab) {
  const url = tab.url || tab.pendingUrl || '';
  if (!isPrintableUrl(url)) {
    throw new UserError(
      'This page cannot be converted. Chrome blocks extensions on browser pages, the Web Store and other extensions.',
    );
  }
}

export function isPrintableUrl(url) {
  if (!url) return false;
  if (/^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source|chrome-search|chrome-devtools):/i.test(url)) return false;
  if (/^https?:\/\/chromewebstore\.google\.com/i.test(url)) return false;
  if (/^https?:\/\/chrome\.google\.com\/webstore/i.test(url)) return false;
  return true;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'page';
  }
}

function toUserFacing(err) {
  if (err instanceof UserError) return err;
  const msg = String((err && err.message) || err);
  const e = new UserError(msg);
  e.internal = true;
  return e;
}

function progress(tabId, stage, message) {
  chrome.runtime.sendMessage({ type: 'ps:progress', tabId, stage, message }).catch(() => {});
}

const badgeTimers = new Map();
function flashBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(
    tabId,
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000),
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new UserError('No active tab.');
  return tab.id;
}

async function startPicker(tabId, mode) {
  const tab = await chrome.tabs.get(tabId);
  assertPrintable(tab);
  await ensureContentScript(tabId);
  return sendContent(tabId, { type: 'ps:start-picker', mode });
}

// ---------------------------------------------------------------------------
// Messaging (popup, viewer, content script)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ps:')) return false;
  handleMessage(msg, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the channel open for the async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'ps:generate': {
      const tabId = msg.tabId ?? (await activeTabId());
      return generate({ tabId, settings: msg.settings, prep: msg.prep || 'none', output: msg.output });
    }
    case 'ps:generate-from-content': {
      // Sent by the in-page picker / toolbar; uses saved settings.
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) throw new UserError('No tab for this request.');
      return generate({ tabId, prep: msg.prep || 'none', output: msg.output });
    }
    case 'ps:start-picker': {
      const tabId = msg.tabId ?? (await activeTabId());
      return startPicker(tabId, msg.mode);
    }
    case 'ps:page-state': {
      const tabId = msg.tabId ?? (await activeTabId());
      const tab = await chrome.tabs.get(tabId);
      const printable = isPrintableUrl(tab.url || tab.pendingUrl || '');
      let state = { removed: 0, hasPicked: false };
      if (printable && (await ping(tabId))) {
        state = (await sendContent(tabId, { type: 'ps:state' })) || state;
      }
      return { ok: true, printable, busy: activeJobs.has(tabId), title: tab.title, url: tab.url, ...state };
    }
    case 'ps:reset-page': {
      const tabId = msg.tabId ?? (await activeTabId());
      if (activeJobs.has(tabId)) throw new UserError('Wait for the current PDF to finish before resetting the page.');
      if (await ping(tabId)) await sendContent(tabId, { type: 'ps:reset-page' });
      return { ok: true };
    }
    case 'ps:get-job': {
      const job = await takeJob(msg.id);
      if (!job) return { ok: false, error: 'This preview has expired. Generate the PDF again.' };
      return { ok: true, job };
    }
    case 'ps:discard-job':
      discardJob(msg.id);
      return { ok: true };
    default:
      throw new UserError('Unknown message: ' + msg.type);
  }
}

// ---------------------------------------------------------------------------
// Context menus & keyboard commands
// ---------------------------------------------------------------------------

const MENU = {
  page: { title: 'Save page as PDF', contexts: ['page', 'frame', 'action'] },
  article: { title: 'Save article only as PDF', contexts: ['page', 'frame', 'action'] },
  selectElement: { title: 'Select an element to save as PDF', contexts: ['page', 'frame', 'action'] },
  removeElements: { title: 'Remove elements before saving', contexts: ['page', 'frame', 'action'] },
  reset: { title: 'Restore all removed elements', contexts: ['page', 'frame', 'action'] },
};

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const [id, def] of Object.entries(MENU)) {
      chrome.contextMenus.create({ id, title: def.title, contexts: def.contexts });
    }
  });
}

chrome.runtime.onInstalled.addListener(installMenus);
chrome.runtime.onStartup.addListener(installMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  const run = (p) => p.catch((err) => console.warn('PageSnap:', err.message));
  switch (info.menuItemId) {
    case 'page':
      return run(generate({ tabId: tab.id }));
    case 'article':
      return run(generate({ tabId: tab.id, prep: 'article' }));
    case 'selectElement':
      return run(startPicker(tab.id, 'print'));
    case 'removeElements':
      return run(startPicker(tab.id, 'remove'));
    case 'reset':
      return run(handleMessage({ type: 'ps:reset-page', tabId: tab.id }, {}));
    default:
      return undefined;
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  const tabId = tab && tab.id;
  if (tabId == null) return;
  const run = (p) => p.catch((err) => console.warn('PageSnap:', err.message));
  if (command === 'save-pdf') run(generate({ tabId }));
  if (command === 'save-article') run(generate({ tabId, prep: 'article' }));
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (reason === 'canceled_by_user') console.info('PageSnap: debugger detached by user on tab', source.tabId);
});

// Test hook (used by test/e2e.mjs). Harmless in production.
globalThis.__pagesnap = {
  generate,
  previewJobs,
  isPrintableUrl,
  // Same code paths as the runtime messages the popup / context menu use (a worker can't message itself).
  startPicker: (tabId, mode) => handleMessage({ type: 'ps:start-picker', tabId, mode }, {}),
  pageState: (tabId) => handleMessage({ type: 'ps:page-state', tabId }, {}),
  resetPage: (tabId) => handleMessage({ type: 'ps:reset-page', tabId }, {}),
};
