// Web Snap PDF - background service worker.
// Runs the export pipelines on the active tab and routes the ps:* messages from the popup, the
// viewer and the content script (plus context menus and keyboard shortcuts):
//   generate()        ps:prepare -> debugger attach -> Page.printToPDF -> download
//   captureElement()  debugger attach -> ps:prepare -> Page.captureScreenshot per part (preview, PNG, JPEG)
//   exportMarkdown()  ps:to-markdown in the content script (no debugger)
// Every page change made by ps:prepare is undone with ps:restore, whatever the outcome.
import { loadSettings, saveSettings, normalizeSettings } from './lib/settings.js';
import { buildPrintParams, layoutWidthPx, buildFilename } from './lib/print-params.js';
import { MAX_PAGE_INCHES, CSS_PX_PER_INCH } from './lib/paper-sizes.js';
import { getMessages, t } from './lib/i18n.js';

const CDP_VERSION = '1.3'; // chrome.debugger protocol version
const CONTENT_SCRIPT = 'src/content.js';
const VIEWER_PAGE = 'src/viewer/viewer.html';
const PREVIEW_TTL_MS = 15 * 60 * 1000;

// Largest bitmap edge Page.captureScreenshot renders correctly: past 16384 device pixels (the GPU
// texture limit) the output wraps around and repeats the top of the capture.
const MAX_CAPTURE_PX = 16384;
const JPEG_QUALITY = 92;
// The preview is captured at screen resolution; keep its data URL (sent to the page) reasonably small.
const PREVIEW_MAX_PIXELS = 32e6;
const LAST_FORMAT_KEY = 'previewFormat'; // chrome.storage.local: last format chosen in the preview overlay
const PREVIEW_FORMATS = ['pdf', 'png', 'jpeg', 'markdown'];
// Tall elements are captured (and shown / saved) as parts of at most this many CSS pixels each, so
// every image stays readable and far below the capture limit.
export const SEGMENT_PX = 1600;

const activeJobs = new Set(); // tabIds currently generating
const previewJobs = new Map(); // jobId -> { base64, filename, title, autoDownload, createdAt } (viewer fallback)

class UserError extends Error {}

// English fallbacks for the in-page UI (picker toolbar + element preview overlay). Translations from
// _locales/<lang>/messages.json override them key by key (see uiStrings()).
export const PICKER_STRINGS_EN = {
  picker_titleSelect: 'Select an element',
  picker_hintSelect: 'Hover to highlight, click to select. ↑/↓ widen or narrow. Esc to cancel.',
  picker_titleRemove: 'Remove elements',
  picker_hintRemove: 'Click anything to remove it. ↑/↓ widen or narrow. Press Done when finished.',
  picker_removedCount: '$1 removed',
  picker_undo: 'Undo',
  picker_savePdf: 'Save PDF',
  picker_done: 'Done',
  picker_cancel: 'Cancel',
  picker_errorNoElement: 'Nothing selected. Click an element on the page first.',
  preview_title: 'Export this element',
  preview_caption: '$1 · $2×$3 px',
  preview_format: 'Format',
  preview_formatPdf: 'PDF',
  preview_formatPng: 'PNG',
  preview_formatJpeg: 'JPEG',
  preview_formatMarkdown: 'Markdown',
  preview_download: 'Download',
  preview_copyImage: 'Copy image',
  preview_copied: 'Image copied to the clipboard',
  preview_reselect: 'Reselect',
  preview_close: 'Close',
  preview_loading: 'Rendering preview…',
  preview_saving: 'Saving…',
  preview_saved: 'Saved $1',
  preview_imageAlt: 'Preview of the selected element',
  preview_warningScaled:
    'This element is very large, so the image is reduced to $1× to stay within Chrome’s 16,384 px limit.',
  preview_errorCapture: 'Could not capture this element.',
  preview_errorCopy: 'Could not copy the image. Download it instead.',
  preview_errorGeneric: 'Something went wrong. Try again or reselect the element.',
  preview_downloadAll: 'Download all parts',
  preview_part: 'Part $1 of $2',
  preview_copyPart: 'Copy',
  preview_downloadPart: 'Download',
  preview_splitNote: 'Split into $1 parts for easier viewing',
  preview_themeToggle: 'Toggle light / dark',
  error_markdownDisabled: 'Markdown export is an experimental feature. Enable it in the extension settings.',
};
const UI_STRING_PREFIX = /^(picker|preview)_/;

/** English fallbacks merged with the user's language; only the in-page UI keys. */
async function uiStrings(settings) {
  let messages = {};
  try {
    messages = await getMessages(settings && settings.language);
  } catch (err) {
    console.warn('Web Snap: could not load translations', err);
  }
  const out = { ...PICKER_STRINGS_EN };
  for (const [k, v] of Object.entries(messages || {})) {
    if (v && (UI_STRING_PREFIX.test(k) || k in PICKER_STRINGS_EN)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

/**
 * Generate a PDF for a tab.
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {object} [opts.settings]  Overrides; defaults to saved settings.
 * @param {'none'|'article'|'element'} [opts.prep]
 * @param {'download'|'return'} [opts.output]  Missing (or anything else) means download; 'return'
 *   hands the base64 PDF back to the caller (tests).
 */
export async function generate({ tabId, settings, prep = 'none', output }) {
  settings = normalizeSettings(settings || (await loadSettings()));
  claimTab(tabId, 'A PDF is already being generated for this tab.');
  try {
    progress(tabId, 'prepare', 'Preparing page…');
    const tab = await readyTab(tabId);
    const prepMsg = { prep, loadLazy: settings.loadLazy, ...scanOptions(settings) };
    const { data, title, warning } = await withPreparedPage(tabId, prepMsg, (prepResult) =>
      withDebugger(tabId, async (target) => ({
        ...(await printPage(target, tabId, settings)),
        title: pageTitle(prepResult, tab),
      })),
    );
    const filename = buildFilename(settings.filenameTemplate, { title, domain: hostnameOf(tab.url) });
    if (output === 'return') return { ok: true, base64: data, filename, warning };

    progress(tabId, 'save', 'Saving…');
    await savePdf(data, filename, tab.title, settings.saveAs);
    succeeded(tabId);
    return { ok: true, filename, bytes: base64ByteLength(data), warning };
  } catch (err) {
    throw failed(tabId, err);
  } finally {
    activeJobs.delete(tabId);
    progress(tabId, 'done', '');
  }
}

/** Page.printToPDF with the settings' media and layout emulation; returns { data, warning }. */
async function printPage(target, tabId, settings) {
  const { params, paper, margins, scale } = buildPrintParams(settings);
  const single = settings.layout === 'single';
  const media = settings.mediaView === 'screen' ? 'screen' : single ? 'print' : null;
  const cleanup = []; // emulation overrides to clear, in reverse order
  let warning = null;
  try {
    if (media) {
      await cdp(target, 'Emulation.setEmulatedMedia', { media });
      cleanup.push(() => cdp(target, 'Emulation.setEmulatedMedia', { media: '' }));
    }
    if (single) {
      progress(tabId, 'measure', 'Measuring page…');
      await cdp(target, 'Emulation.setDeviceMetricsOverride', {
        width: layoutWidthPx(paper, margins, scale),
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      cleanup.push(() => cdp(target, 'Emulation.clearDeviceMetricsOverride'));
      await sleep(200);
      warning = fitSinglePage(params, await measureContentHeight(target, tabId), { paper, margins, scale });
    }
    progress(tabId, 'render', 'Rendering PDF…');
    const { data } = await printToPdf(target, params);
    return { data, warning };
  } finally {
    while (cleanup.length)
      await cleanup
        .pop()()
        .catch(() => {});
  }
}

/** Sizes `params` to one page as tall as the content; returns a warning if it had to be split. */
function fitSinglePage(params, contentHeightPx, { paper, margins, scale }) {
  const heightIn = (contentHeightPx * scale) / CSS_PX_PER_INCH + margins.top + margins.bottom + 0.1;
  params.paperWidth = paper.width;
  params.paperHeight = Math.min(MAX_PAGE_INCHES, Math.max(1, heightIn));
  delete params.pageRanges;
  params.preferCSSPageSize = false;
  if (heightIn <= MAX_PAGE_INCHES) return null;
  return `The page is longer than PDF viewers allow for a single page (${MAX_PAGE_INCHES} in), so it was split into ${Math.ceil(heightIn / MAX_PAGE_INCHES)} tall pages.`;
}

/** Downloads the PDF; if the data: URL download throws, the viewer page downloads it instead. */
async function savePdf(base64, filename, title, saveAs) {
  try {
    await download(base64, filename, saveAs);
  } catch (err) {
    // Fallback: let the viewer page create a Blob URL and download from there.
    console.warn('Direct download failed, falling back to viewer', err);
    await openFallbackDownload({ base64, filename, title, autoDownload: true });
  }
}

// ---------------------------------------------------------------------------
// Element preview & image / Markdown export
// ---------------------------------------------------------------------------

/**
 * Splits a document-relative rect into vertical parts of at most `segment` CSS pixels each (the
 * last part is shorter). An element no taller than `segment` is a single part.
 */
export function splitRect(rect, segment = SEGMENT_PX) {
  const parts = [];
  for (let top = 0; top < rect.height; top += segment) {
    parts.push({
      x: rect.x,
      y: rect.y + top,
      width: rect.width,
      height: Math.min(segment, rect.height - top),
    });
  }
  return parts;
}

/**
 * Capture the element picked in the page (content script `state.picked`) as one image per part
 * (see splitRect). Uses the same isolation as the element PDF, so the preview matches the export.
 * `scale` is output pixels per CSS pixel; `null` means "screen resolution" (device pixels).
 * `part` (1-based) captures only that part; omitted, every part is captured. The debugger is
 * attached, and the page prepared, once for all parts.
 */
async function captureElement(
  tabId,
  { settings, format = 'png', scale = null, quality, maxPixels = Infinity, part = null },
) {
  claimTab(tabId, 'An export is already running for this tab.');
  try {
    const tab = await readyTab(tabId);
    // Unlike generate(), attach before preparing: attaching shows Chrome's "started debugging this
    // browser" bar, which shrinks the viewport with a short animation. A captureBeyondViewport
    // screenshot taken while the viewport is still changing size repeats the first viewport-height
    // of the clip instead of rendering the rest.
    return await withDebugger(tabId, async (target) => {
      await waitForStableViewport(target);
      const prepMsg = { prep: 'element', loadLazy: false, ...scanOptions(settings) };
      return withPreparedPage(tabId, prepMsg, async (prepResult) => {
        const rect = requireOk(
          await sendContent(tabId, { type: 'ps:picked-rect' }),
          'The selected element is gone. Select it again.',
        );
        if (rect.width < 1 || rect.height < 1)
          throw new UserError('The selected element has no visible size.');
        const clips = splitRect(rect);
        if (part != null && !clips[part - 1]) throw new UserError('This part of the image no longer exists.');
        // Output pixels per clip.scale unit: devicePixelRatio (incl. page zoom) on real displays,
        // but not under DevTools device emulation, so measure it instead of trusting
        // window.devicePixelRatio. One scale for every part, so the parts line up.
        const ratio = await captureRatio(target);
        const wanted = Math.min(
          scale == null ? ratio : scale,
          Math.sqrt(maxPixels / (rect.width * rect.height)),
        );
        const outScale = capScale(rect, wanted);
        const indexes = part == null ? clips.map((_, i) => i) : [part - 1];
        const parts = [];
        for (const i of indexes) {
          const data = await screenshotClip(target, clips[i], { format, scale: outScale, ratio, quality });
          parts.push({
            part: i + 1,
            data,
            cssHeight: clips[i].height,
            imageWidth: Math.round(clips[i].width * outScale),
            imageHeight: Math.round(clips[i].height * outScale),
          });
        }
        return {
          parts,
          count: clips.length,
          scale: outScale,
          scaledDown: outScale < wanted,
          rect,
          title: pageTitle(prepResult, tab),
          tab,
        };
      });
    });
  } finally {
    activeJobs.delete(tabId);
  }
}

/** Page.captureScreenshot of a document-relative clip at output `scale`; returns base64 data. */
async function screenshotClip(target, clip, { format, scale, ratio, quality }) {
  const params = {
    format,
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: scale / ratio },
    // Clip coordinates are document-relative with captureBeyondViewport (verified by the tests).
    captureBeyondViewport: true,
  };
  if (format === 'jpeg') params.quality = quality ?? JPEG_QUALITY;
  const { data } = await cdp(target, 'Page.captureScreenshot', params);
  return data;
}

/**
 * Largest output scale for an element that keeps every part within the capture limit. Parts are
 * at most SEGMENT_PX tall, so in practice only very wide elements are reduced.
 */
function capScale(rect, scale) {
  const limit = MAX_CAPTURE_PX / Math.max(rect.width, Math.min(rect.height, SEGMENT_PX));
  return scale > limit ? Math.floor(limit * 1000) / 1000 : scale;
}

function clampImageScale(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : 2;
}

function scaledWarning(strings, scale) {
  return t(strings, 'preview_warningScaled', [String(Math.floor(scale * 100) / 100)]);
}

/** `name.png` -> `name-2.png` (files of a split element). */
export function partFilename(filename, part) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)}-${part}${filename.slice(dot)}` : `${filename}-${part}`;
}

/**
 * Show the in-page preview overlay for the element picked with the "select element" picker.
 * ps:show-preview carries one PNG data URL per part (screen resolution, whole element within
 * PREVIEW_MAX_PIXELS). Returns { ok, width, height, parts, warning } (CSS pixels of the element).
 */
export async function previewElement(tabId) {
  const settings = await loadSettings();
  const strings = await uiStrings(settings);
  let cap;
  try {
    cap = await captureElement(tabId, {
      settings,
      format: 'png',
      scale: null,
      maxPixels: PREVIEW_MAX_PIXELS,
    });
  } catch (err) {
    throw failed(tabId, err);
  }
  // What an image export at the configured scale would be reduced to (shown in the caption).
  const imageScale = clampImageScale(settings.imageScale);
  const exportScale = capScale(cap.rect, imageScale);
  const imageWarning = exportScale < imageScale ? scaledWarning(strings, exportScale) : null;
  const markdownEnabled = !!settings.markdownEnabled;
  let format = await lastPreviewFormat();
  if (format === 'markdown' && !markdownEnabled) format = 'pdf';
  const res = await sendContent(tabId, {
    type: 'ps:show-preview',
    parts: cap.parts.map((p) => ({
      dataUrl: 'data:image/png;base64,' + p.data,
      width: cap.rect.width,
      height: p.cssHeight,
    })),
    width: cap.rect.width,
    height: cap.rect.height,
    description: cap.rect.description || '',
    format,
    imageWarning,
    markdownEnabled,
    strings,
    theme: settings.theme || 'system',
  });
  requireOk(res, 'Could not show the preview.');
  return {
    ok: true,
    width: cap.rect.width,
    height: cap.rect.height,
    parts: cap.count,
    warning: imageWarning,
  };
}

/**
 * Export the picked element as PNG or JPEG at settings.imageScale and download it (filename
 * template + .png / .jpg). A split element is saved as one file per part, `<name>-1.png`,
 * `<name>-2.png`, … (one chrome.downloads call each; with settings.saveAs Chrome asks for every
 * file, the downloads API cannot reuse a chosen directory). `part` (1-based) saves only that part.
 * `output: 'return'` returns the base64 data of each part instead (tests).
 */
export async function exportElementImage(tabId, format = 'png', { output, part = null } = {}) {
  format = format === 'jpeg' || format === 'jpg' ? 'jpeg' : 'png';
  const settings = await loadSettings();
  const strings = await uiStrings(settings);
  const scale = clampImageScale(settings.imageScale);
  const mime = 'image/' + format;
  try {
    const cap = await captureElement(tabId, { settings, format, scale, quality: JPEG_QUALITY, part });
    const filename = buildFilename(
      settings.filenameTemplate,
      { title: cap.title, domain: hostnameOf(cap.tab.url) },
      format === 'jpeg' ? 'jpg' : 'png',
    );
    const parts = cap.parts.map((p) => ({
      part: p.part,
      filename: cap.count > 1 ? partFilename(filename, p.part) : filename,
      width: p.imageWidth,
      height: p.imageHeight,
      data: p.data,
    }));
    const result = {
      ok: true,
      filename: parts[0].filename,
      filenames: parts.map((p) => p.filename),
      count: cap.count,
      width: Math.round(cap.rect.width * cap.scale),
      height: Math.round(cap.rect.height * cap.scale),
      scale: cap.scale,
      warning: cap.scaledDown ? scaledWarning(strings, cap.scale) : null,
    };
    if (output === 'return') {
      return { ...result, mime, parts: parts.map(({ data, ...p }) => ({ ...p, base64: data })) };
    }
    let bytes = 0;
    for (const p of parts) {
      await download(p.data, p.filename, settings.saveAs, mime);
      bytes += base64ByteLength(p.data);
    }
    succeeded(tabId);
    const saved = parts.map((p) => ({
      part: p.part,
      filename: p.filename,
      width: p.width,
      height: p.height,
    }));
    return { ...result, parts: saved, bytes };
  } catch (err) {
    throw failed(tabId, err);
  }
}

/**
 * Experimental: convert the page, its article or the picked element to Markdown and download it
 * as <filename>.md. Gated by settings.markdownEnabled here, so no caller can bypass the opt-in.
 */
export async function exportMarkdown(tabId, prep = 'none', { output } = {}) {
  const settings = await loadSettings();
  if (!settings.markdownEnabled) {
    const strings = await uiStrings(settings);
    throw new UserError(t(strings, 'error_markdownDisabled'));
  }
  prep = prep === 'article' || prep === 'element' ? prep : 'none';
  try {
    const tab = await readyTab(tabId);
    const res = requireOk(
      await sendContent(tabId, { type: 'ps:to-markdown', prep }),
      'Could not convert the page to Markdown.',
    );
    const filename = buildFilename(
      settings.filenameTemplate,
      { title: pageTitle(res, tab), domain: hostnameOf(tab.url) },
      'md',
    );
    if (output === 'return') return { ok: true, filename, markdown: res.markdown };
    const base64 = utf8ToBase64(res.markdown);
    await download(base64, filename, settings.saveAs, 'text/markdown;charset=utf-8');
    succeeded(tabId);
    return { ok: true, filename, bytes: new TextEncoder().encode(res.markdown).length };
  } catch (err) {
    throw failed(tabId, err);
  }
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function lastPreviewFormat() {
  try {
    const stored = await chrome.storage.local.get(LAST_FORMAT_KEY);
    const f = stored[LAST_FORMAT_KEY];
    return PREVIEW_FORMATS.includes(f) ? f : 'pdf';
  } catch {
    return 'pdf';
  }
}

function rememberPreviewFormat(format) {
  if (!PREVIEW_FORMATS.includes(format)) return;
  chrome.storage.local.set({ [LAST_FORMAT_KEY]: format }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Debugger helpers
// ---------------------------------------------------------------------------

function cdp(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params || {});
}

async function attach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (err) {
    const msg = errorMessage(err);
    if (/already attached/i.test(msg)) {
      throw new UserError('Another tool (usually DevTools) is attached to this tab. Close it and try again.');
    }
    if (/cannot access|cannot attach|not allowed|restricted/i.test(msg)) {
      throw new UserError('Chrome does not allow extensions to convert this page.');
    }
    throw err;
  }
}

/** Runs `fn(target)` with the debugger attached to the tab, detaching afterwards. */
async function withDebugger(tabId, fn) {
  await attach(tabId);
  const target = { tabId };
  try {
    return await fn(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// Poll the viewport height until it has stopped changing (the debugger info bar has finished
// sliding in). Returns quickly when nothing moves; gives up after `maxMs`.
async function waitForStableViewport(target, { stableMs = 250, maxMs = 2500 } = {}) {
  const start = Date.now();
  let last = null;
  let since = start;
  while (Date.now() - start < maxMs) {
    let h = null;
    try {
      const r = await cdp(target, 'Runtime.evaluate', { expression: 'innerHeight', returnByValue: true });
      h = r && r.result ? r.result.value : null;
    } catch {
      return;
    }
    const now = Date.now();
    if (h !== last) {
      last = h;
      since = now;
    } else if (now - since >= stableMs) {
      return;
    }
    await sleep(40);
  }
}

// Output pixels per CSS pixel of a clip.scale = 1 screenshot, read from a tiny capture's PNG header.
async function captureRatio(target) {
  try {
    const { data } = await cdp(target, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
    });
    const bin = atob(data.slice(0, 32)); // signature (8) + IHDR length/type (8) + width (4)
    const w =
      ((bin.charCodeAt(16) << 24) |
        (bin.charCodeAt(17) << 16) |
        (bin.charCodeAt(18) << 8) |
        bin.charCodeAt(19)) >>>
      0;
    return w > 0 ? w / 100 : 1;
  } catch (err) {
    console.warn('Web Snap: could not measure the capture scale', err);
    return 1;
  }
}

async function printToPdf(target, params) {
  try {
    return await cdp(target, 'Page.printToPDF', params);
  } catch (err) {
    const msg = errorMessage(err);
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
    const msg = errorMessage(err);
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

/** Checks that Chrome lets extensions script the tab and injects the content script if needed. */
async function readyTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  assertPrintable(tab);
  await ensureContentScript(tabId);
  return tab;
}

/** Page-wide preparation switches shared by every pipeline. */
function scanOptions(settings) {
  return { hideFixed: settings.hideFixed, expandScroll: settings.expandScroll !== false };
}

/**
 * Prepares the page (ps:prepare: lazy content, isolation, fixed bars, scroll panes), runs
 * `fn(prepResult)` and always restores the page afterwards (ps:restore).
 */
async function withPreparedPage(tabId, prepMsg, fn) {
  try {
    const prepResult = requireOk(
      await sendContent(tabId, { type: 'ps:prepare', ...prepMsg }),
      'Could not prepare the page.',
    );
    return await fn(prepResult);
  } finally {
    await sendContent(tabId, { type: 'ps:restore' }).catch(() => {});
  }
}

/** Returns a content-script response, or throws its error (or `fallback`) as a UserError. */
function requireOk(res, fallback) {
  if (!res || !res.ok) throw new UserError((res && res.error) || fallback);
  return res;
}

function pageTitle(result, tab) {
  return (result.title || tab.title || '').trim();
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

async function download(base64, filename, saveAs, mime = 'application/pdf') {
  const url = `data:${mime};base64,` + base64;
  const id = await chrome.downloads.download({
    url,
    filename,
    saveAs: !!saveAs,
    conflictAction: 'uniquify',
  });
  if (typeof id !== 'number') throw new Error(chrome.runtime.lastError?.message || 'Download did not start');
  return id;
}

// Hands a PDF to the viewer page, which downloads it from a Blob URL (fallback for downloads of
// data: URLs that Chrome refuses, e.g. very large ones).
async function openFallbackDownload(job) {
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

// Browser pages, other extensions and the Web Store, where Chrome blocks extension scripts.
const RESTRICTED_URLS = [
  /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source|chrome-search|chrome-devtools):/i,
  /^https?:\/\/chromewebstore\.google\.com/i,
  /^https?:\/\/chrome\.google\.com\/webstore/i,
];

export function isPrintableUrl(url) {
  return !!url && !RESTRICTED_URLS.some((re) => re.test(url));
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'page';
  }
}

function errorMessage(err) {
  return String((err && err.message) || err);
}

function toUserFacing(err) {
  if (err instanceof UserError) return err;
  const e = new UserError(errorMessage(err));
  e.internal = true;
  return e;
}

/** One export per tab at a time; release with activeJobs.delete(tabId). */
function claimTab(tabId, busyMessage) {
  if (activeJobs.has(tabId)) throw new UserError(busyMessage);
  activeJobs.add(tabId);
}

function succeeded(tabId) {
  flashBadge(tabId, '✓', '#1b873f');
}

/** Flags the failure on the toolbar badge and returns the error to throw. */
function failed(tabId, err) {
  flashBadge(tabId, '!', '#d0342c');
  return toUserFacing(err);
}

function base64ByteLength(base64) {
  return Math.floor((base64.length * 3) / 4);
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

/** The tab a popup / test message names, else the active tab. */
async function targetTabId(msg) {
  if (msg.tabId != null) return msg.tabId;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new UserError('No active tab.');
  return tab.id;
}

async function startPicker(tabId, mode) {
  await readyTab(tabId);
  const settings = await loadSettings();
  const strings = await uiStrings(settings);
  return sendContent(tabId, { type: 'ps:start-picker', mode, strings, theme: settings.theme || 'system' });
}

function senderTabId(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) throw new UserError('No tab for this request.');
  return tabId;
}

// ---------------------------------------------------------------------------
// Messaging (popup, viewer, content script)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ps:')) return false;
  handleMessage(msg, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
  return true; // keep the channel open for the async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'ps:generate': {
      const tabId = await targetTabId(msg);
      return generate({ tabId, settings: msg.settings, prep: msg.prep || 'none', output: msg.output });
    }
    case 'ps:generate-from-content': {
      // Sent by the in-page picker toolbar / preview overlay; uses saved settings.
      const tabId = senderTabId(sender);
      if (msg.format) rememberPreviewFormat(msg.format);
      return generate({ tabId, prep: msg.prep || 'none', output: msg.output });
    }
    case 'ps:preview-element':
      // Sent by the picker after a click in "select element" mode.
      return previewElement(msg.tabId ?? senderTabId(sender));
    case 'ps:export-element': {
      // Sent by the preview overlay: PNG / JPEG download of the picked element, every part or
      // only `part` (1-based) of a split element.
      const tabId = msg.tabId ?? senderTabId(sender);
      const format = msg.format === 'jpeg' ? 'jpeg' : 'png';
      const part = Number.isInteger(msg.part) && msg.part >= 1 ? msg.part : null;
      rememberPreviewFormat(format);
      return exportElementImage(tabId, format, { part });
    }
    case 'ps:set-theme': {
      // Sent by the preview overlay's light / dark toggle; the popup and options read it on open.
      if (!['light', 'dark', 'system'].includes(msg.theme)) throw new UserError('Unknown theme.');
      const settings = await loadSettings();
      await saveSettings({ ...settings, theme: msg.theme });
      return { ok: true, theme: msg.theme };
    }
    case 'ps:export-markdown': {
      const tabId = await targetTabId(msg);
      return exportMarkdown(tabId, msg.prep || 'none');
    }
    case 'ps:export-markdown-from-content': {
      const tabId = senderTabId(sender);
      rememberPreviewFormat('markdown');
      return exportMarkdown(tabId, msg.prep || 'element');
    }
    case 'ps:start-picker': {
      const tabId = await targetTabId(msg);
      return startPicker(tabId, msg.mode);
    }
    case 'ps:page-state': {
      const tabId = await targetTabId(msg);
      const tab = await chrome.tabs.get(tabId);
      const printable = isPrintableUrl(tab.url || tab.pendingUrl || '');
      let state = { removed: 0, hasPicked: false };
      if (printable && (await ping(tabId))) {
        state = (await sendContent(tabId, { type: 'ps:state' })) || state;
      }
      return { ok: true, printable, busy: activeJobs.has(tabId), title: tab.title, url: tab.url, ...state };
    }
    case 'ps:reset-page': {
      const tabId = await targetTabId(msg);
      if (activeJobs.has(tabId))
        throw new UserError('Wait for the current PDF to finish before resetting the page.');
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

const MENU_CONTEXTS = ['page', 'frame', 'action'];
const MENU = {
  page: 'Save page as PDF',
  article: 'Save article only as PDF',
  selectElement: 'Select an element to preview and save',
  removeElements: 'Remove elements before saving',
  reset: 'Restore all removed elements',
};

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title] of Object.entries(MENU)) {
      chrome.contextMenus.create({ id, title, contexts: MENU_CONTEXTS });
    }
  });
}

/** Menu and shortcut actions have no caller to report to: log failures instead. */
function runLogged(promise) {
  return promise.catch((err) => console.warn('Web Snap:', err.message));
}

chrome.runtime.onInstalled.addListener(installMenus);
chrome.runtime.onStartup.addListener(installMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  switch (info.menuItemId) {
    case 'page':
      return runLogged(generate({ tabId: tab.id }));
    case 'article':
      return runLogged(generate({ tabId: tab.id, prep: 'article' }));
    case 'selectElement':
      return runLogged(startPicker(tab.id, 'print'));
    case 'removeElements':
      return runLogged(startPicker(tab.id, 'remove'));
    case 'reset':
      return runLogged(handleMessage({ type: 'ps:reset-page', tabId: tab.id }, {}));
    default:
      return undefined;
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  const tabId = tab && tab.id;
  if (tabId == null) return;
  if (command === 'save-pdf') runLogged(generate({ tabId }));
  if (command === 'save-article') runLogged(generate({ tabId, prep: 'article' }));
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (reason === 'canceled_by_user') console.info('Web Snap: debugger detached by user on tab', source.tabId);
});

// Test hook (used by test/e2e.mjs). Harmless in production.
globalThis.__websnap = {
  generate,
  previewElement,
  exportElementImage,
  exportMarkdown,
  PICKER_STRINGS_EN,
  previewJobs,
  isPrintableUrl,
  // Same code paths as the runtime messages the popup / context menu use (a worker can't message itself).
  startPicker: (tabId, mode) => handleMessage({ type: 'ps:start-picker', tabId, mode }, {}),
  pageState: (tabId) => handleMessage({ type: 'ps:page-state', tabId }, {}),
  resetPage: (tabId) => handleMessage({ type: 'ps:reset-page', tabId }, {}),
  setTheme: (theme) => handleMessage({ type: 'ps:set-theme', theme }, {}),
  splitRect,
};
