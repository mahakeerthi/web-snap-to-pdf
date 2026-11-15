// Content-script hardening tests: drives extension/src/content.js directly (executeScript +
// tabs.sendMessage from the service worker) against fixture pages and asserts DOM state after
// ps:prepare and after ps:restore, the article element chosen, picker behaviour, the element
// preview overlay (PNG / JPEG / PDF / Markdown export, split parts, theme) and the Markdown converter.
// Run with: npm run test:content   (or: node test/content.e2e.mjs)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchExtension, createReporter, tabIdForUrl } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test/out');
fs.mkdirSync(outDir, { recursive: true });
const { context, sw, extensionId, base, downloadDir, close } = await launchExtension({
  // EXT_DIR lets you run the suite against another build (e.g. an older content.js) for comparison.
  extDir: process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : undefined,
  viewport: { width: 1200, height: 800 },
});
sw.on('console', (m) => {
  if (m.type() === 'error') console.log('  [sw]', m.text());
});

// --- helpers ----------------------------------------------------------------------------
const { check, test, summary } = createReporter();
async function openTab(file) {
  const url = `${base}/${file}`;
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e)));
  await page.goto(url, { waitUntil: 'load' });
  const tabId = await tabIdForUrl(sw, url);
  await page.bringToFront();
  return { page, tabId };
}
// Inject the content script (a no-op when already present) and send it one message.
async function send(tabId, msg) {
  return sw.evaluate(
    async ({ tabId, msg }) => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
      const t0 = performance.now();
      const res = await chrome.tabs.sendMessage(tabId, msg);
      return { ...res, ms: performance.now() - t0 };
    },
    { tabId, msg },
  );
}
// The content script shares its isolated world with executeScript({ func }), so a test can stub
// chrome.runtime.sendMessage there to capture the picker's ps:preview-element request.
async function stubSendMessage(tabId) {
  return sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.__psSent = [];
        chrome.runtime.sendMessage = (m) => {
          window.__psSent.push(m);
          return Promise.resolve({ ok: true });
        };
      },
    });
  }, tabId);
}
async function readSentMessages(tabId) {
  return sw.evaluate(async (tabId) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__psSent || null,
    });
    return r && r.result;
  }, tabId);
}
const PREP_ALL = { type: 'ps:prepare', prep: 'none', hideFixed: true, loadLazy: false, expandScroll: true };

// Snapshot of everything prepare/restore may touch: inline declarations (normalised, not the raw
// attribute string), style-attribute presence, loading attributes, marker attributes, scroll offsets.
function snapshotDom() {
  const els = [];
  const walk = (scope) => {
    for (const el of scope.querySelectorAll('*')) {
      if (el.hasAttribute('data-websnap-ui')) continue;
      const style = {};
      for (let i = 0; i < el.style.length; i++) {
        const p = el.style[i];
        style[p] = el.style.getPropertyValue(p) + (el.style.getPropertyPriority(p) ? ' !' : '');
      }
      els.push({
        key: el.tagName + (el.id ? '#' + el.id : ''),
        style: JSON.stringify(style),
        hasStyle: el.hasAttribute('style'),
        loading: el.getAttribute('loading'),
        marker: el.hasAttribute('data-websnap-root'),
        scrollTop: el.scrollTop,
      });
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return { els, x: window.scrollX, y: window.scrollY };
}
function diffSnapshots(a, b) {
  const diffs = [];
  if (a.els.length !== b.els.length) diffs.push(`element count ${a.els.length} -> ${b.els.length}`);
  for (let i = 0; i < Math.min(a.els.length, b.els.length); i++) {
    const x = a.els[i];
    const y = b.els[i];
    for (const k of Object.keys(x)) {
      if (x[k] !== y[k]) diffs.push(`${x.key} ${k}: ${JSON.stringify(x[k])} -> ${JSON.stringify(y[k])}`);
    }
  }
  if (a.x !== b.x || a.y !== b.y) diffs.push(`window scroll (${a.x},${a.y}) -> (${b.x},${b.y})`);
  return diffs;
}
async function snapshot(page) {
  return page.evaluate(snapshotDom);
}
async function expectRestored(page, before, label = 'restore returns the page to its exact previous state') {
  const after = await snapshot(page);
  const diffs = diffSnapshots(before, after);
  check(
    diffs.length === 0,
    label,
    diffs.slice(0, 6).join('; ') + (diffs.length > 6 ? ` (+${diffs.length - 6} more)` : ''),
  );
}
function pdfText(buf, name) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, buf);
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
}
async function pickerRect(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-websnap-ui]');
    if (!host) return null;
    const hl = host.shadowRoot.querySelector('.hl');
    const bar = host.shadowRoot.querySelector('.bar');
    const r = hl.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      display: getComputedStyle(hl).display,
      barTop: b.top,
      barText: bar.textContent,
    };
  });
}
async function rectOf(page, selector) {
  return page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, selector);
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const sameRect = (a, b) =>
  a && b && near(a.left, b.left) && near(a.top, b.top) && near(a.width, b.width) && near(a.height, b.height);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function pageState(tabId) {
  return send(tabId, { type: 'ps:state' });
}
// Start the picker the way the popup does (through the background, which sends the UI strings).
async function startPicker(tabId, mode) {
  return sw.evaluate(({ tabId, mode }) => globalThis.__websnap.startPicker(tabId, mode), { tabId, mode });
}
async function setSettings(partial) {
  await sw.evaluate((p) => chrome.storage.sync.set({ settings: p }), partial);
}
async function waitFor(fn, { timeout = 15000, interval = 100, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await wait(interval);
  }
  throw new Error(`timed out waiting for ${label}`);
}
// State of the preview overlay, read from its (open) shadow root.
async function previewInfo(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-websnap-ui="preview"]');
    if (!host) return null;
    const sr = host.shadowRoot;
    const q = (s) => sr.querySelector(s);
    const shown = (el) => !!el && el.getClientRects().length > 0;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const canvases = [...sr.querySelectorAll('.stage canvas')];
    const select = q('select.format');
    const options = select ? [...select.options] : [];
    return {
      hostDisplay: getComputedStyle(host).display,
      title: q('h2').textContent,
      theme: q('.overlay').dataset.theme,
      dark: q('.overlay').dataset.theme === 'dark',
      dialogCard: !!q('.dialog'),
      viewport: { width: innerWidth, height: innerHeight },
      overlay: box(q('.overlay')),
      toolbar: { ...box(q('.toolbar')), scrollWidth: q('.toolbar').scrollWidth },
      stage: box(q('.stage')),
      caption: q('.caption').textContent,
      splitNote: q('.split-note').hidden ? '' : q('.split-note').textContent,
      warning: q('.warning').hidden ? '' : q('.warning').textContent,
      status: q('.status').textContent,
      loading: !!q('.placeholder') && !q('.placeholder.error'),
      error: q('.placeholder.error') ? q('.placeholder.error').textContent : '',
      ready: canvases.length > 0 && canvases.every((c) => c.dataset.ready),
      canvas: canvases[0]
        ? { width: canvases[0].width, height: canvases[0].height, cssWidth: canvases[0].style.width }
        : null,
      canvases: canvases.map((c) => ({ width: c.width, height: c.height, cssWidth: c.style.width })),
      partHeads: [...sr.querySelectorAll('.part-head')].map(shown),
      partsGap: q('.parts') ? getComputedStyle(q('.parts')).rowGap : null,
      parts: [...sr.querySelectorAll('.part')].map((p) => ({
        label: p.querySelector('.part-label') ? p.querySelector('.part-label').textContent : '',
        copy: shown(p.querySelector('.part-copy')),
        download: shown(p.querySelector('.part-download')),
      })),
      formats: options.map((o) => o.value),
      labels: options.map((o) => o.textContent),
      checked: select && options.length ? select.value : null,
      formatLabel: select && select.labels[0] ? select.labels[0].textContent : '',
      formatShown: shown(select),
      copyVisible: shown(q('.copy')),
      copyTitle: q('.copy').title,
      downloadLabel: q('.download').textContent,
      downloadDisabled: q('.download').disabled,
      // Visible toolbar actions, left to right (icon buttons by their accessible name).
      buttons: [...sr.querySelectorAll('.toolbar .actions .btn')]
        .filter(shown)
        .map((b) => b.getAttribute('aria-label') || b.textContent),
      actionsRight: Math.max(
        ...[...sr.querySelectorAll('.toolbar .btn, .format-box')]
          .filter(shown)
          .map((b) => b.getBoundingClientRect().right),
      ),
      focused: sr.activeElement ? sr.activeElement.className : null,
    };
  });
}
// Pixel of preview canvas `index` at a fraction of its size.
async function previewPixel(page, fx, fy, index = 0) {
  return page.evaluate(
    ({ fx, fy, index }) => {
      const c = document
        .querySelector('[data-websnap-ui="preview"]')
        .shadowRoot.querySelectorAll('.stage canvas')[index];
      const d = c
        .getContext('2d')
        .getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { fx, fy, index },
  );
}
// Click a control of the overlay like a user would (scrolling the preview to it if needed).
async function clickPreview(page, selector) {
  const r = await page.evaluate((s) => {
    const sr = document.querySelector('[data-websnap-ui="preview"]').shadowRoot;
    const el = sr.querySelector(s);
    const stage = sr.querySelector('.stage');
    if (stage.contains(el)) {
      stage.scrollTop += el.getBoundingClientRect().top - stage.getBoundingClientRect().top - 40;
    }
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, selector);
  await page.mouse.move(r.x, r.y);
  await page.mouse.click(r.x, r.y);
}
// Pick a format in the overlay's Format dropdown.
async function chooseFormat(page, format) {
  await page.locator('[data-websnap-ui="preview"] select.format').selectOption(format);
}
async function closePreviewOverlay(page) {
  await clickPreview(page, '.close');
  await waitFor(async () => !(await previewInfo(page)), { label: 'preview overlay closed' });
}
async function waitForPreview(page, timeout = 15000) {
  return waitFor(
    async () => {
      const info = await previewInfo(page);
      return info && (info.ready || info.error) ? info : null;
    },
    { label: 'preview overlay', timeout },
  );
}
// Start the select-element picker, hover `selector` (scrolled into view unless `scroll: false`),
// widen the highlight with ArrowUp until it names `widenTo` (e.g. 'table' when the pointer is over
// a cell) and click: the real user flow up to the preview overlay.
async function pickElement(page, tabId, selector, { scroll = true, widenTo = null, timeout = 15000 } = {}) {
  if (scroll) {
    await page.evaluate(
      (s) => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }),
      selector,
    );
  }
  await startPicker(tabId, 'print');
  const r = await rectOf(page, selector);
  const x = r.left + Math.min(20, r.width / 2);
  const y = Math.min(Math.max(r.top + 20, 120), r.top + r.height - 5, 600);
  await page.mouse.move(x, y);
  await wait(50);
  const tag = () =>
    page.evaluate(
      () => document.querySelector('[data-websnap-ui]').shadowRoot.querySelector('.tag').textContent,
    );
  for (let i = 0; widenTo && i < 8 && !(await tag()).startsWith(widenTo); i++)
    await page.keyboard.press('ArrowUp');
  await page.mouse.down();
  await page.mouse.up();
  return waitForPreview(page, timeout);
}
// The `n` most recent completed downloads matching `pred` (oldest first).
async function waitForDownloads(pred, n, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = await sw.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 30 }));
    const hits = items.filter((i) => i.state === 'complete' && pred(i));
    if (hits.length >= n) return hits.slice(0, n).reverse();
    await wait(200);
  }
  throw new Error(`${n} downloads did not complete`);
}
async function waitForDownload(pred, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = await sw.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 10 }));
    const hit = items.find((i) => i.state === 'complete' && pred(i));
    if (hit) return hit;
    await wait(200);
  }
  throw new Error('download did not complete');
}
// --- page and article preview helpers ----------------------------------------------------
const LAZY_LONG = 'lazy/loader.html?loader=io,lodash,native&n=100&gap=2000&t=100&fixedbar=1';
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const badge = (tabId) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
const workerState = (tabId) => sw.evaluate((id) => globalThis.__websnap.pageState(id), tabId);
const command = (name, tabId) =>
  sw.evaluate(({ name, tabId }) => globalThis.__websnap.command(name, tabId), { name, tabId });
const menu = (item, tabId) =>
  sw.evaluate(({ item, tabId }) => globalThis.__websnap.menu(item, tabId), { item, tabId });
const hostCount = (page) => page.evaluate(() => document.querySelectorAll('[data-websnap-ui]').length);
const overlayOpen = (page) => page.evaluate(() => !!document.querySelector('[data-websnap-ui="preview"]'));
const downloadCount = () => sw.evaluate(async () => (await chrome.downloads.search({})).length);
// Records every message the worker sends to a tab and every screenshot it asks Chrome for, and can
// hold ps:prepare or one CDP method back. Installed once; tests reset it with resetWorkerLog().
async function instrumentWorker() {
  await sw.evaluate(() => {
    if (globalThis.__instrumented) return;
    globalThis.__instrumented = true;
    globalThis.__tabMsgs = [];
    globalThis.__holdPrepareMs = 0;
    globalThis.__cdp = { shots: 0, hold: null, onShot: null };
    globalThis.__rt = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m && typeof m.type === 'string') globalThis.__rt.push({ type: m.type, requestId: m.requestId });
    });
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (tabId, msg, ...rest) => {
      const rec = { type: msg.type, requestId: msg.requestId, t: Date.now() };
      if (msg.type === 'ps:show-preview') {
        rec.prefixes = msg.parts.map((p) => p.dataUrl.slice(0, 23));
        rec.bytes = JSON.stringify(msg).length;
      }
      globalThis.__tabMsgs.push(rec);
      if (msg.type === 'ps:prepare' && globalThis.__holdPrepareMs)
        await new Promise((r) => setTimeout(r, globalThis.__holdPrepareMs));
      rec.sentAt = Date.now();
      const res = await send(tabId, msg, ...rest);
      rec.repliedAt = Date.now();
      if (res) {
        rec.reused = res.reused;
        rec.aborted = res.aborted;
        rec.lazy = res.lazy;
        rec.ok = res.ok;
      }
      return res;
    };
    const cdp = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Page.captureScreenshot' && params && params.captureBeyondViewport) {
        globalThis.__cdp.shots++;
        if (globalThis.__cdp.onShot) await globalThis.__cdp.onShot(globalThis.__cdp.shots, target);
      }
      const hold = globalThis.__cdp.hold;
      if (hold && hold.method === method) {
        hold.hit = true;
        await new Promise((r) => setTimeout(r, hold.ms));
      }
      return cdp(target, method, params);
    };
  });
}
async function resetWorkerLog() {
  await instrumentWorker();
  await sw.evaluate(() => {
    globalThis.__tabMsgs.length = 0;
    globalThis.__rt.length = 0;
    globalThis.__holdPrepareMs = 0;
    globalThis.__cdp.shots = 0;
    globalThis.__cdp.hold = null;
    globalThis.__cdp.onShot = null;
  });
}
const received = (type) => sw.evaluate((type) => globalThis.__rt.filter((m) => m.type === type), type);
const workerMsgs = (type) =>
  sw.evaluate((type) => globalThis.__tabMsgs.filter((m) => !type || m.type === type), type);
// Records scrollY (and the overlay host's display) on every scroll event of the page.
async function recordScrolls(page) {
  await page.evaluate(() => {
    window.__sc = [];
    addEventListener('scroll', () => {
      const h = document.querySelector('[data-websnap-ui="preview"]');
      window.__sc.push({ t: performance.now(), y: scrollY, d: h ? getComputedStyle(h).display : null });
    });
  });
}
const scrollLog = (page) => page.evaluate(() => ({ now: performance.now(), sc: window.__sc }));
// popup.html as a background tab of the fixture's window (as the real popup resolves its tab), with
// window.close recorded because a script-opened tab is not the toolbar popup.
async function openPopupFor(tabId, page) {
  const tab = await sw.evaluate((id) => chrome.tabs.get(id), tabId);
  await page.bringToFront();
  const url = `chrome-extension://${extensionId}/src/popup/popup.html`;
  const [popup] = await Promise.all([
    context.waitForEvent('page', { predicate: (p) => p.url() === url, timeout: 10000 }),
    sw.evaluate(({ url, windowId }) => chrome.tabs.create({ url, windowId, active: false }), {
      url,
      windowId: tab.windowId,
    }),
  ]);
  await popup.waitForSelector('body[data-state]');
  await popup.waitForFunction(() => !document.documentElement.hasAttribute('data-boot'));
  await popup.evaluate(() => {
    window.__closed = 0;
    window.close = () => window.__closed++;
  });
  return popup;
}
const popupSend = (popup, msg) => popup.evaluate((m) => chrome.runtime.sendMessage(m), msg);
async function waitForOverlay(page, label = 'preview overlay') {
  return waitFor(async () => ((await overlayOpen(page)) ? true : null), { label });
}
// The preview's canvas pixel at a document position (CSS px), over the parts it is split into.
const canvasPixelAt = (page, x, y) =>
  page.evaluate(
    ({ x, y }) => {
      const sr = document.querySelector('[data-websnap-ui="preview"]').shadowRoot;
      let top = 0;
      for (const c of sr.querySelectorAll('.stage canvas')) {
        const cssH = c.height / (c.width / parseFloat(c.style.width));
        if (y < top + cssH + 0.5) {
          const k = c.width / parseFloat(c.style.width);
          const d = c
            .getContext('2d')
            .getImageData(Math.round(x * k), Math.min(c.height - 1, Math.round((y - top) * k)), 1, 1).data;
          return [d[0], d[1], d[2]];
        }
        top += cssH;
      }
      return null;
    },
    { x, y },
  );
const bigText = (n) => '<p>filler</p>'.repeat(n);
// Minimal PNG decoder (8-bit RGB/RGBA, all filter types) for pixel checks.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || !bpp) return { width, height, pixel: null };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y ? px[dst - stride + x] : 0;
      const c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + x] = v & 255;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const i = y * stride + x * bpp;
      return [px[i], px[i + 1], px[i + 2]];
    },
  };
}
const isColor = (c, rgb, tol = 3) => !!c && c.every((v, i) => Math.abs(v - rgb[i]) <= tol);
// Stripe i of the striped fixture elements is rgb(k*10, 100, 255-k*10) with k = i % 25. Checks the
// `n` bands of an image whose first band is stripe `first`; returns the bad stripes.
function badStripes(png, n, first = 0) {
  const bad = [];
  const band = png.height / n;
  for (let j = 0; j < n; j++) {
    const k = (first + j) % 25;
    const c = png.pixel(Math.floor(png.width / 2), Math.floor(j * band + band / 2));
    if (!isColor(c, [k * 10, 100, 255 - k * 10])) bad.push(`${first + j}:${c.join('/')}`);
  }
  return bad;
}

// --- 1. restore correctness ---------------------------------------------------------------

await test('restore: fixed/sticky, scroll panes, lazy images, inline !important, scroll position', async () => {
  const { page, tabId } = await openTab('restore.html');
  await page.evaluate(() => {
    window.scrollTo({ top: 900, behavior: 'instant' });
    document.getElementById('inner').scrollTop = 150;
  });
  const before = await snapshot(page);
  check(before.y === 900, `fixture scrolled to 900 (${before.y})`);
  const res = await send(tabId, { ...PREP_ALL, loadLazy: true });
  check(res.ok, 'prepare ok', JSON.stringify(res));
  const during = await page.evaluate(() => ({
    fixed: getComputedStyle(document.getElementById('fixedbar')).display,
    sticky: getComputedStyle(document.getElementById('sticky')).position,
    innerOverflow: getComputedStyle(document.getElementById('inner')).overflowY,
    innerClipped:
      document.getElementById('inner').scrollHeight > document.getElementById('inner').clientHeight + 4,
    loading: [...document.querySelectorAll('img')].map((i) => i.getAttribute('loading')),
    lazy2: document.getElementById('lazy2').getAttribute('src'),
  }));
  check(during.fixed === 'none', 'small fixed bar hidden during prepare');
  check(during.sticky === 'static', 'sticky element made static');
  check(during.innerOverflow === 'visible' && !during.innerClipped, 'inner scroll pane expanded');
  check(
    during.loading.every((l) => l === 'eager'),
    `lazy images switched to eager (${during.loading})`,
  );
  check(!!during.lazy2, 'data-src image got a src');

  await send(tabId, { type: 'ps:restore' });
  const y = await page.evaluate(() => window.scrollY);
  check(y === 900, `window scroll position restored immediately, even with scroll-behavior:smooth (${y})`);
  const inner = await page.evaluate(() => document.getElementById('inner').scrollTop);
  check(inner === 150, `inner pane scrollTop restored (${inner})`);
  const imgs = await page.evaluate(() =>
    [...document.querySelectorAll('img')].map((i) => i.getAttribute('loading')),
  );
  check(
    imgs.every((l) => l === 'lazy'),
    `loading="lazy" restored (${imgs})`,
  );
  await wait(400); // let any smooth scrolling settle before the full comparison
  await expectRestored(page, before);

  // A second prepare/restore cycle must be just as clean (no state leaks between runs).
  await send(tabId, { ...PREP_ALL, prep: 'article' });
  await send(tabId, { type: 'ps:restore' });
  await wait(400);
  await expectRestored(page, before, 'article prepare + restore cycle is also exact');
  await page.close();
});

// --- 2. scroll containers ---------------------------------------------------------------

await test('scroll containers: app shell, code blocks, line-clamp and image crops', async () => {
  const { page, tabId } = await openTab('scroll.html');
  const before = await snapshot(page);
  const orig = await page.evaluate(() => ({
    clamp: document.getElementById('clamp').clientHeight,
    crop: document.getElementById('crop').clientHeight,
  }));
  const res = await send(tabId, PREP_ALL);
  check(res.ok, 'prepare ok');
  const s = await page.evaluate(() => {
    const last = document.getElementById('last');
    const lr = last.getBoundingClientRect();
    const clippers = [];
    for (let a = last.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
      if (a === document.documentElement) continue;
      const r = a.getBoundingClientRect();
      if (r.bottom < lr.bottom - 1) clippers.push(a.id || a.tagName);
    }
    const pre = document.getElementById('code');
    const pcs = getComputedStyle(pre);
    const d = document.documentElement;
    return {
      clippers,
      docHeight: Math.max(d.scrollHeight, document.body.scrollHeight),
      lastBottom: lr.bottom + window.scrollY,
      preClipped: pre.scrollHeight > pre.clientHeight + 4,
      preOverflowX: pcs.overflowX,
      preScrollsX: pre.scrollWidth > pre.clientWidth,
      spill: d.scrollWidth - d.clientWidth,
      clamp: document.getElementById('clamp').clientHeight,
      clampOverflow: getComputedStyle(document.getElementById('clamp')).overflowY,
      crop: document.getElementById('crop').clientHeight,
    };
  });
  check(
    s.clippers.length === 0,
    'no ancestor clips the last message (app shell released)',
    `clipped by ${s.clippers.join(', ')}`,
  );
  check(
    s.docHeight >= s.lastBottom - 2,
    `document is tall enough for all messages (${s.docHeight} >= ${Math.round(s.lastBottom)})`,
  );
  check(!s.preClipped, 'code block shows every line');
  check(s.spill <= 1, `long code lines do not spill past the page width (spill ${s.spill}px)`);
  check(
    s.preOverflowX !== 'visible',
    `code block keeps its own horizontal overflow handling (${s.preOverflowX})`,
  );
  check(
    s.clamp === orig.clamp && s.clampOverflow === 'hidden',
    `line-clamped teaser left alone (${orig.clamp} -> ${s.clamp}px)`,
  );
  check(s.crop === orig.crop, `small image crop box left alone (${orig.crop} -> ${s.crop}px)`);

  // End to end: the PDF contains the last message of the inner pane.
  await send(tabId, { type: 'ps:restore' });
  const r = await sw.evaluate(
    (o) => globalThis.__websnap.generate(o).catch((e) => ({ error: String(e && e.message) })),
    { tabId, output: 'return', settings: { loadLazy: false } },
  );
  if (r && r.base64) {
    const text = pdfText(Buffer.from(r.base64, 'base64'), 'content-scroll.pdf');
    check(text.includes('LAST-MESSAGE-MARK'), 'PDF includes the last message of the inner scroll pane');
  } else {
    check(false, 'PDF generated', JSON.stringify(r));
  }
  await wait(300);
  await expectRestored(page, before);
  await page.close();
});

await test('scroll-locked page: body { position: fixed; overflow: auto } prints in full', async () => {
  const { page, tabId } = await openTab('body-fixed.html');
  const before = await snapshot(page);
  const res = await send(tabId, PREP_ALL);
  check(res.ok, 'prepare ok');
  const st = await page.evaluate(() => ({
    pos: getComputedStyle(document.body).position,
    docHeight: document.documentElement.scrollHeight,
    vh: window.innerHeight,
  }));
  check(st.pos === 'static', `body put back into normal flow (${st.pos})`);
  check(
    st.docHeight > st.vh * 3,
    `document height covers all content (${st.docHeight}px, viewport ${st.vh}px)`,
  );
  await send(tabId, { type: 'ps:restore' });
  const r = await sw.evaluate(
    (o) => globalThis.__websnap.generate(o).catch((e) => ({ error: String(e && e.message) })),
    { tabId, output: 'return', settings: { loadLazy: false } },
  );
  if (r && r.base64) {
    const text = pdfText(Buffer.from(r.base64, 'base64'), 'content-body-fixed.pdf');
    check(text.includes('BODY-END-MARK'), 'PDF includes the end of the page');
  } else {
    check(false, 'PDF generated', JSON.stringify(r));
  }
  await wait(300);
  await expectRestored(page, before);
  await page.close();
});

// --- 3. lazy loading --------------------------------------------------------------------

const LAZY_STEP = (innerHeight) => Math.max(200, Math.floor(innerHeight * 0.85));
const lazyWarning = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'extension/_locales/en/messages.json'), 'utf8'))
    .status_lazyIncomplete.message;

async function generateLazy(tabId, prep = 'none') {
  return sw.evaluate(
    async ({ tabId, prep }) => {
      const t0 = performance.now();
      const r = await globalThis.__websnap
        .generate({ tabId, prep, output: 'return', settings: { loadLazy: true } })
        .catch((e) => ({ error: String(e && e.message) }));
      return { ...r, ms: performance.now() - t0 };
    },
    { tabId, prep },
  );
}

// The 300 x 120 lazy images in a generated PDF, and its text.
function lazyPdf(r, name) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(r.base64, 'base64'));
  const rows = execFileSync('pdfimages', ['-list', file], { encoding: 'utf8' }).trim().split('\n').slice(2);
  const images = rows.map((l) => l.trim().split(/\s+/)).filter((c) => c[3] === '300' && c[4] === '120');
  return { images: images.length, text: execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }) };
}

// Records, from the page's own JavaScript, how long the window stays at each scroll position.
async function recordScrollPositions(page) {
  await page.evaluate(() => {
    window.__positions = [];
    let y = scrollY;
    let since = performance.now();
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      if (scrollY !== y) {
        const now = performance.now();
        window.__positions.push({ y, ms: now - since });
        y = scrollY;
        since = now;
      }
      if (!window.__stopRecording) ch.port2.postMessage(0);
    };
    ch.port2.postMessage(0);
  });
}
async function recordedPositions(page) {
  return page.evaluate(() => {
    window.__stopRecording = true;
    return {
      positions: window.__positions,
      innerHeight,
      maxScroll: document.documentElement.scrollHeight - innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
}
// The positions the pass held, in order (the first record is the time before it started).
const passPositions = ({ positions }) => positions.slice(1);
// The furthest position the scroll loop held on a page that does not grow, leaving out the jump to
// the bottom that follows it (the one position at the page's last scroll offset).
const loopFurthest = ({ positions, maxScroll }) =>
  Math.max(...positions.map((p) => p.y).filter((y) => y < maxScroll));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
// Whether every hold looks like a 50 ms dwell. The page notices each new position up to a few ms
// late when the machine is busy, which shortens one recorded hold by as much as it lengthens the
// previous one, so a single hold may read a little under 50 ms.
const heldDwell = (holds) => holds.length > 3 && median(holds) >= 49 && Math.min(...holds) >= 45;
const holdsNote = (holds) =>
  `${holds.length}, median ${median(holds).toFixed(1)} ms, shortest ${Math.min(...holds).toFixed(1)} ms`;

// Runs ps:prepare with loadLazy on an open tab and returns its reply with the recorded positions.
async function lazyPass(page, tabId) {
  await recordScrollPositions(page);
  const res = await send(tabId, { type: 'ps:prepare', prep: 'none', loadLazy: true });
  const rec = await recordedPositions(page);
  await send(tabId, { type: 'ps:restore' });
  return { res, rec };
}

await test('lazy pass: every page holds each 85 %-viewport position 50 ms, with or without images', async () => {
  const PAGES = [
    ['a page with images and a throttled loader', 'lazy/loader.html?loader=lodash&t=50&n=20'],
    ['a page of text only', 'lazy/text.html?paras=150'],
  ];
  for (const [name, file] of PAGES) {
    const { page, tabId } = await openTab(file);
    const { res, rec } = await lazyPass(page, tabId);
    check(
      res.ok && res.lazy && res.lazy.complete,
      `${name}: pass reports complete`,
      JSON.stringify(res.lazy),
    );
    const step = LAZY_STEP(rec.innerHeight);
    const expected = [];
    for (let y = step; y < rec.scrollHeight && y < rec.maxScroll; y += step) expected.push(y);
    const seen = passPositions(rec);
    const ys = seen.map((p) => p.y).slice(0, expected.length);
    check(
      JSON.stringify(ys) === JSON.stringify(expected),
      `${name}: scroll positions are ${step} px steps from the top (${expected.length} positions)`,
      `got ${ys.slice(0, 6).join(',')}..., expected ${expected.slice(0, 6).join(',')}...`,
    );
    const dwell = seen.slice(0, expected.length).map((p) => p.ms);
    check(heldDwell(dwell), `${name}: every position held 50 ms (${holdsNote(dwell)})`);
    if (file.startsWith('lazy/loader.html')) {
      const [filled, total] = await page.evaluate(() => [window.__filled(), window.__total]);
      check(filled === total, `a scroll handler throttled to 50 ms filled every image (${filled}/${total})`);
    }
    await page.close();
  }
});

await test('lazy images past 170,000 px reach the PDF, without a warning', async () => {
  const { page, tabId } = await openTab('lazy/loader.html?loader=io&n=100&gap=2000');
  const before = await snapshot(page);
  const r = await generateLazy(tabId);
  if (!r.base64) {
    check(false, 'PDF generated', JSON.stringify({ error: r.error }));
    return page.close();
  }
  const { images, text } = lazyPdf(r, 'content-lazy-long.pdf');
  check(images === 100, `all 100 lazy images are in the PDF (${images}, ${Math.round(r.ms)} ms)`);
  check(text.includes('BLOCK-99-MARK'), 'PDF reaches the last block, at 198,000 px');
  check(!r.warning, 'no warning when the scroll reached the bottom', String(r.warning));
  await wait(300);
  await expectRestored(page, before);
  await page.close();
});

await test('endless feed: past 250 positions the pass stops once the page grows, and the export warns', async () => {
  const { page, tabId } = await openTab('lazy/loader.html?n=0&feed=1');
  await recordScrollPositions(page);
  const r = await generateLazy(tabId);
  const rec = await recordedPositions(page);
  check(!!r.base64, 'PDF generated', JSON.stringify({ error: r.error }));
  check(r.warning === lazyWarning(), `export carries the lazy-load warning (${r.warning})`);
  const step = LAZY_STEP(rec.innerHeight);
  // The feed appends 10 items of 1,000 px each time its end comes into view.
  const batch = 10000;
  const furthest = Math.max(...rec.positions.map((p) => p.y));
  check(
    furthest >= 250 * step && furthest <= 250 * step + 3 * batch,
    `the pass covered 250 positions and stopped within the next batches (furthest ${furthest} px, 250 positions ${250 * step} px, ${Math.round(r.ms)} ms)`,
  );
  const y = await page.evaluate(() => window.scrollY);
  check(y === 0, `scroll position restored (${y})`);
  await page.close();
});

await test('image feed that stops growing before position 250 on a page longer than 250 positions: complete, no warning, every image', async () => {
  const { page, tabId } = await openTab('lazy/scroll.html?mode=feed&img=1&init=25&batches=15&lat=0');
  await recordScrollPositions(page);
  await page.evaluate(() => {
    window.__lastGrowthY = 0;
    new MutationObserver(() => {
      window.__lastGrowthY = scrollY;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const r = await generateLazy(tabId);
  const rec = await recordedPositions(page);
  const step = LAZY_STEP(rec.innerHeight);
  const lastGrowthY = await page.evaluate(() => window.__lastGrowthY);
  check(
    lastGrowthY > 0 && lastGrowthY <= 249 * step,
    `premise: the last batch arrived before position 250 (at ${lastGrowthY} px, position 250 at ${249 * step} px)`,
  );
  check(
    rec.scrollHeight > 250 * step,
    `premise: the page is longer than 250 positions (${rec.scrollHeight} px, 250 positions ${250 * step} px)`,
  );
  if (!r.base64) {
    check(false, 'PDF generated', JSON.stringify({ error: r.error }));
    return page.close();
  }
  check(!r.warning, `no warning (${Math.round(r.ms)} ms)`, String(r.warning));
  const reached = loopFurthest(rec);
  check(
    reached >= rec.maxScroll - step,
    `the scroll loop reached the end of the page (last position ${reached} px, end ${rec.maxScroll} px)`,
  );
  const { images } = lazyPdf(r, 'content-lazy-feed-finite.pdf');
  const loaded = await page.evaluate(() => window.__filled());
  check(
    images === loaded && loaded === 175,
    `every image the page loaded is in the PDF (${images} of ${loaded}, 175 expected)`,
  );
  await page.close();
});

await test('image feed that keeps growing past position 250: the pass stops there, warns, and every image the page loaded is in the PDF', async () => {
  const { page, tabId } = await openTab('lazy/scroll.html?mode=feed&img=1&batches=30&lat=0');
  await recordScrollPositions(page);
  const r = await generateLazy(tabId);
  const rec = await recordedPositions(page);
  if (!r.base64) {
    check(false, 'PDF generated', JSON.stringify({ error: r.error }));
    return page.close();
  }
  check(r.warning === lazyWarning(), `export carries the lazy-load warning (${r.warning})`);
  const step = LAZY_STEP(rec.innerHeight);
  const batch = 10000;
  const furthest = Math.max(...rec.positions.map((p) => p.y));
  check(
    furthest >= 250 * step && furthest <= 250 * step + 3 * batch,
    `the pass covered 250 positions and stopped within the next batches (furthest ${furthest} px, 250 positions ${250 * step} px, ${Math.round(r.ms)} ms)`,
  );
  const { images } = lazyPdf(r, 'content-lazy-feed-growing.pdf');
  const loaded = await page.evaluate(() => window.__filled());
  check(
    images === loaded && loaded > (250 * step) / 1000,
    `every image the page loaded is in the PDF (${images} of ${loaded})`,
  );
  await page.close();
});

await test('a 500,000 px text page that does not grow: the pass goes past 250 positions, stops at the 30 s cap and warns', async () => {
  const { page, tabId } = await openTab('lazy/text.html?paras=7000');
  await recordScrollPositions(page);
  const r = await generateLazy(tabId);
  const rec = await recordedPositions(page);
  check(!!r.base64, 'PDF generated', JSON.stringify({ error: r.error }));
  check(r.warning === lazyWarning(), `export carries the lazy-load warning (${r.warning})`);
  const step = LAZY_STEP(rec.innerHeight);
  const reached = loopFurthest(rec);
  check(
    reached > 250 * step && reached < rec.maxScroll - step,
    `the pass went past 250 positions and stopped short of the end (last position ${reached} px, 250 positions ${250 * step} px, end ${rec.maxScroll} px)`,
  );
  check(r.ms >= 30000, `the cap ended the export (${Math.round(r.ms)} ms, cap 30000 ms)`);
  await page.close();
});

await test('article export of a page with images: every image loads and the pass covers the whole page', async () => {
  const { page, tabId } = await openTab('lazy/loader.html?root=article&top=3000&loader=io&n=20');
  await recordScrollPositions(page);
  const r = await generateLazy(tabId, 'article');
  const rec = await recordedPositions(page);
  if (!r.base64) {
    check(false, 'PDF generated', JSON.stringify({ error: r.error }));
    return page.close();
  }
  const { images, text } = lazyPdf(r, 'content-lazy-article.pdf');
  check(images === 20, `all 20 article images are in the PDF (${images}, ${Math.round(r.ms)} ms)`);
  check(text.includes('BLOCK-19-MARK') && text.includes('ARTICLE-END-MARK'), 'PDF holds the whole article');
  check(!r.warning, 'no warning', String(r.warning));
  const step = LAZY_STEP(rec.innerHeight);
  const reached = loopFurthest(rec);
  check(
    reached >= rec.maxScroll - step,
    `the scroll loop reached the end of the page, past the 3,000 px footer (last position ${reached} px, end ${rec.maxScroll} px)`,
  );
  await page.close();
});

await test('article export above an endless feed scrolls the whole page like main and warns, because the scroll stopped before the end of the page', async () => {
  const { page, tabId } = await openTab('lazy/loader.html?root=article&top=3000&n=0&feed=1');
  await recordScrollPositions(page);
  const r = await generateLazy(tabId, 'article');
  const rec = await recordedPositions(page);
  if (!r.base64) {
    check(false, 'PDF generated', JSON.stringify({ error: r.error }));
    return page.close();
  }
  const { text } = lazyPdf(r, 'content-lazy-article-feed.pdf');
  check(
    text.includes('ARTICLE-START-MARK') && text.includes('ARTICLE-END-MARK'),
    'PDF holds the whole article',
  );
  check(!text.includes('FEED-'), 'PDF holds no feed item');
  check(r.warning === lazyWarning(), `export carries the lazy-load warning (${r.warning})`);
  const step = LAZY_STEP(rec.innerHeight);
  const furthest = Math.max(...rec.positions.map((p) => p.y));
  check(
    furthest >= 249 * step,
    `the pass scrolled past the article for 250 positions, as on main (furthest ${furthest} px, 250 positions ${250 * step} px, ${Math.round(r.ms)} ms)`,
  );
  await page.close();
});

// The warning looks at the page, not at the root: an export of an element warns when the scroll
// stopped before the end of the page, wherever the element is and whether or not its rectangle
// says it was covered. A fixed or sticky panel stays in view for the whole scroll, and a section
// whose only child is floated has a height of 32 px.
await test('element export above an endless feed warns, for a root in the flow, fixed, sticky or holding the feed in a float', async () => {
  const CASES = [
    ['a list that grows at the page end', 'mode=rootfeed&img=0&batches=40', 'section', 'list'],
    ['a fixed panel', 'mode=feed&lat=0&batches=40&root=fixed', 'aside', 'panel'],
    ['a sticky sidebar beside the feed', 'mode=feed&lat=0&batches=40&root=sticky', 'aside', 'panel'],
    [
      'a 32 px section whose floated child holds the feed',
      'mode=feed&lat=0&batches=40&root=float',
      'section',
      'list',
      32,
    ],
  ];
  for (const [name, query, tag, kind, height] of CASES) {
    const { page, tabId } = await openTab(`lazy/scroll.html?${query}`);
    if (height) {
      const h = Math.round((await rectOf(page, '#root')).height);
      check(h === height, `${name}: premise: the root is ${height} px high (${h})`);
    }
    await pickElement(page, tabId, '#root', { widenTo: tag });
    const r = await generateLazy(tabId, 'element');
    await closePreviewOverlay(page);
    if (!r.base64) {
      check(false, `${name}: PDF generated`, JSON.stringify({ error: r.error }));
      await page.close();
      continue;
    }
    const { text } = lazyPdf(r, 'content-lazy-root-feed.pdf');
    const items = (text.match(/FEED-\d+-MARK/g) || []).length;
    const [filled, total] = await page.evaluate(() => [window.__filled(), window.__total]);
    check(filled < total, `${name}: premise: the feed still had batches left (${filled} of ${total} items)`);
    check(
      kind === 'panel'
        ? text.includes('PANEL-START-MARK') && text.includes('PANEL-END-MARK') && items === 0
        : items > 0,
      `${name}: the PDF holds the picked element (${items} feed items)`,
    );
    check(r.warning === lazyWarning(), `${name}: export carries the lazy-load warning (${r.warning})`);
    await page.close();
  }
});

await test('element export of a list that grows near the end of the page loads every batch, with images or text only', async () => {
  for (const [name, query] of [
    ['an image per item', 'mode=rootfeed'],
    ['text only, 3,000 px footer', 'mode=rootfeed&img=0&foot=3000'],
  ]) {
    const { page, tabId } = await openTab(`lazy/scroll.html?${query}`);
    await pickElement(page, tabId, '#root', { widenTo: 'section' });
    const r = await generateLazy(tabId, 'element');
    await closePreviewOverlay(page);
    if (!r.base64) {
      check(false, `${name}: PDF generated`, JSON.stringify({ error: r.error }));
      await page.close();
      continue;
    }
    const { text } = lazyPdf(r, 'content-lazy-rootfeed.pdf');
    const items = (text.match(/FEED-\d+-MARK/g) || []).length;
    check(
      items === 60,
      `${name}: all 60 list items (10, then 5 batches of 10) are in the PDF (${items}, ${Math.round(r.ms)} ms)`,
    );
    check(!r.warning, `${name}: no warning`, String(r.warning));
    await page.close();
  }
});

// The pass holds the bottom of the page for 150 ms before it scrolls back. A loader that fills its
// images only once the window has rested at the end for 125 ms (and then appends a block, as a late
// banner or an image without a size does) gets that time: the last loop position holds the bottom
// for 50 ms, so without the wait the loader never fires. The late block lengthens the page after the
// loop ended, which the export must not report as a stop.
await test('a loader that waits for the page to rest at its end: the 150 ms bottom wait lets it fill every image, and its late growth does not warn', async () => {
  const { page, tabId } = await openTab('lazy/scroll.html?mode=bottom&n=6&gap=1000&t=125');
  const { height: before, innerHeight } = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    innerHeight,
  }));
  const step = LAZY_STEP(innerHeight);
  let atEnd = 0;
  for (let y = 0; y < before; y += step) if (y >= before - innerHeight) atEnd++;
  check(atEnd === 1, `premise: one loop position reaches the end of the page (${atEnd}, page ${before} px)`);
  const r = await generateLazy(tabId);
  if (!r.base64) {
    check(false, 'PDF generated', JSON.stringify({ error: r.error }));
    return page.close();
  }
  const { images, text } = lazyPdf(r, 'content-lazy-bottom.pdf');
  const after = await page.evaluate(() => document.documentElement.scrollHeight);
  check(after > before, `premise: the page grew after the loop ended (${before} to ${after} px)`);
  check(images === 6, `the loader filled every image and all 6 are in the PDF (${images})`);
  check(text.includes('LATE-BLOCK-MARK'), 'the late block is in the PDF');
  check(!r.warning, 'no warning for growth during the bottom wait', String(r.warning));
  await page.close();
});

await test('text feed that answers 100 ms after its end comes near: every batch reaches the PDF', async () => {
  const { page, tabId } = await openTab('lazy/scroll.html?mode=feed&lat=100');
  const r = await generateLazy(tabId);
  if (!r.base64) {
    check(false, 'PDF generated', JSON.stringify({ error: r.error }));
    return page.close();
  }
  const { text } = lazyPdf(r, 'content-lazy-textfeed.pdf');
  const items = (text.match(/FEED-\d+-MARK/g) || []).length;
  check(
    items === 100,
    `all 100 feed items (20, then 8 batches of 10) are in the PDF (${items}, ${Math.round(r.ms)} ms)`,
  );
  check(!r.warning, 'no warning', String(r.warning));
  await page.close();
});

// --- 4. article detection ---------------------------------------------------------------

async function articleCase(
  file,
  label,
  { mustInclude = [], mustExclude = [], expect = '[data-expect="article"]' } = {},
) {
  const { page, tabId } = await openTab(file);
  const before = await snapshot(page);
  const res = await send(tabId, { ...PREP_ALL, prep: 'article' });
  check(res.ok, `${label}: article detected`, res.error || '');
  const info = await page.evaluate((expectSel) => {
    const chosen = document.querySelector('[data-websnap-root]');
    const expected = document.querySelector(expectSel);
    const describe = (el) =>
      el
        ? el.tagName.toLowerCase() +
          (el.id ? '#' + el.id : '') +
          (el.className ? '.' + String(el.className).split(' ')[0] : '')
        : 'null';
    return {
      ok: !!chosen && chosen === expected,
      chosen: describe(chosen),
      expected: describe(expected),
      visibleText: document.body.innerText,
    };
  }, expect);
  check(info.ok, `${label}: chose ${info.expected}`, `chose ${info.chosen}`);
  for (const m of mustInclude) check(info.visibleText.includes(m), `${label}: ${m} printed`);
  for (const m of mustExclude) check(!info.visibleText.includes(m), `${label}: ${m} excluded`);
  await send(tabId, { type: 'ps:restore' });
  await expectRestored(page, before, `${label}: restored exactly`);
  await page.close();
}

await test('article detection (a): blog post with <main><article> and comments below', () =>
  articleCase('article-blog.html', 'blog', {
    mustInclude: ['BLOG-TITLE-MARK'],
    mustExclude: ['COMMENTS-MARK', 'SITE-FOOTER-MARK'],
  }));

await test('article detection (b): docs page, main holds sidebar nav + article + toc', () =>
  articleCase('article-docs.html', 'docs', {
    mustInclude: ['DOCS-TITLE-MARK'],
    mustExclude: ['Section heading number 0', 'On this page', 'DOCS-TOPBAR'],
  }));

await test('article detection (c): div-only page with a big code listing', () =>
  articleCase('article-divs.html', 'divs', {
    mustInclude: ['DIVS-TITLE-MARK', 'DIVS-OUTRO-MARK'],
    mustExclude: ['DIVS-COMMENTS-MARK', 'Popular post number 3', 'DIVS-HEADER'],
  }));

await test('article detection (d): story followed by a longer, unlabeled feed outside <main>', () =>
  articleCase('article-feed.html', 'feed', {
    mustInclude: ['FEED-STORY-MARK'],
    mustExclude: ['FEED-CARD-MARK'],
  }));

await test('article detection: existing article.html fixture still picks <article>', () =>
  articleCase('article.html', 'article.html', {
    expect: 'article#story',
    mustInclude: ['ARTICLE-MARK'],
    mustExclude: ['SIDEBAR-MARK', 'FOOTER-MARK'],
  }));

// --- 2. scan cost / coverage on a large page ------------------------------------------------

await test('large page (~30k elements): fixed banners at the end of body are handled, prepare is fast', async () => {
  const { page, tabId } = await openTab('many.html');
  const count = await page.evaluate(() => window.__count);
  console.log(`    (${count} elements)`);
  const before = await snapshot(page);
  const times = [];
  for (let i = 0; i < 2; i++) {
    const res = await send(tabId, PREP_ALL);
    times.push(res.ms);
    const st = await page.evaluate(() => ({
      cookie: getComputedStyle(document.getElementById('cookie')).display,
      chat: getComputedStyle(document.getElementById('chat')).display,
      sticky: getComputedStyle(document.querySelector('h3.stick')).position,
      boxes: [...document.querySelectorAll('.box')].filter((b) => b.scrollHeight > b.clientHeight + 4).length,
    }));
    if (i === 0) {
      check(st.cookie === 'none', 'cookie banner appended at the end of body is hidden');
      check(st.chat === 'none', 'chat bubble appended at the end of body is hidden');
      check(st.sticky === 'static', 'sticky headings made static');
      check(st.boxes === 0, `all small scroll boxes expanded (${st.boxes} still clipped)`);
    }
    await send(tabId, { type: 'ps:restore' });
  }
  const best = Math.min(...times);
  check(
    best < 1500,
    `prepare (hideFixed + expandScroll, no lazy scrolling) under 1.5 s: ${times.map((t) => Math.round(t)).join(' / ')} ms`,
  );
  const art = await send(tabId, { ...PREP_ALL, prep: 'article' });
  check(art.ms < 1500, `article prepare under 1.5 s (${Math.round(art.ms)} ms, ok=${art.ok})`);
  await send(tabId, { type: 'ps:restore' });
  await expectRestored(page, before);
  await page.close();
});

// --- 5. picker ------------------------------------------------------------------------------

await test('picker: highlight tracks scrolling (fixed-position shadow UI)', async () => {
  const { page, tabId } = await openTab('picker.html');
  await page.evaluate(() => window.scrollTo({ top: 1200, behavior: 'instant' }));
  await send(tabId, { type: 'ps:start-picker', mode: 'remove' });
  const t = await rectOf(page, '#target');
  await page.mouse.move(t.left + 100, t.top + 300);
  await wait(150);
  let hl = await pickerRect(page);
  check(
    hl && hl.display === 'block' && sameRect(hl, t),
    'highlight matches the hovered element on a scrolled page',
    JSON.stringify({ hl, t }),
  );
  check(hl && near(hl.barTop, 12), `toolbar pinned to the viewport (top ${hl && hl.barTop})`);
  await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'instant' }));
  await wait(150);
  const t2 = await rectOf(page, '#target');
  hl = await pickerRect(page);
  check(sameRect(hl, t2), 'highlight follows the element after the page scrolls', JSON.stringify({ hl, t2 }));
  check(hl && near(hl.barTop, 12), 'toolbar stays pinned after scrolling');
  await send(tabId, { type: 'ps:reset-page' });
  await page.close();
});

await test('picker: clicks on links never navigate (click, capture-phase router, middle click, dblclick)', async () => {
  const { page, tabId } = await openTab('picker.html');
  const url0 = page.url();
  const pages0 = context.pages().length;
  await send(tabId, { type: 'ps:start-picker', mode: 'remove' });

  const click = async (sel, opts) => {
    const r = await rectOf(page, sel);
    await page.mouse.move(r.left + 5, r.top + 5);
    await wait(30);
    await page.mouse.click(r.left + 5, r.top + 5, opts);
    await wait(300);
  };
  await click('#nav-link');
  check(page.url() === url0, 'plain link click did not navigate');
  await click('#spa-link');
  check(page.url() === url0, 'capture-phase SPA router never saw the click', page.url());
  await click('#mid-link', { button: 'middle' });
  check(
    context.pages().length === pages0 && page.url() === url0,
    `middle click did not open a tab (${pages0} -> ${context.pages().length} pages)`,
  );
  for (const p of context.pages().slice(pages0)) await p.close();
  await click('#dbl-link', { clickCount: 2 });
  const events = await page.evaluate(() => window.__events);
  check(!events.includes('dblclick'), 'dblclick not delivered to the page', JSON.stringify(events));
  const st = await pageState(tabId);
  check(st.pickerActive, 'picker still active after the clicks');
  await send(tabId, { type: 'ps:reset-page' });
  await page.close();
});

await test('picker: Escape stops the picker even if the page swallows Escape in capture phase', async () => {
  const { page, tabId } = await openTab('picker.html');
  await send(tabId, { type: 'ps:start-picker', mode: 'print' });
  await page.mouse.move(300, 300);
  await page.keyboard.press('Escape');
  await wait(100);
  const st = await pageState(tabId);
  const host = await page.evaluate(() => !!document.querySelector('[data-websnap-ui]'));
  check(!st.pickerActive && !host, 'picker stopped and its UI removed', JSON.stringify({ st, host }));
  await page.close();
});

await test('picker: ArrowUp never widens to <body>; clicks on own toolbar are ignored', async () => {
  const { page, tabId } = await openTab('picker.html');
  await startPicker(tabId, 'remove');
  const r = await rectOf(page, '#top');
  await page.mouse.move(r.left + 30, r.top + 10);
  await wait(50);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
  await wait(150);
  const hl = await pickerRect(page);
  const bodyRect = await rectOf(page, 'body');
  check(
    hl && hl.height < bodyRect.height - 10,
    `highlight stops below <body> (${hl && Math.round(hl.height)}px vs body ${Math.round(bodyRect.height)}px)`,
  );
  // Press/release without moving the mouse (a real click after keyboard widening sends no mousemove).
  await page.mouse.down();
  await page.mouse.up();
  await wait(100);
  const st = await page.evaluate(() => ({
    body: getComputedStyle(document.body).display,
    html: getComputedStyle(document.documentElement).display,
    top: getComputedStyle(document.getElementById('top')).display,
  }));
  check(st.body !== 'none' && st.html !== 'none', `body/html never removed (body ${st.body})`);
  check(st.top === 'none', 'the widest allowed element (#top) was removed instead');
  const before = (await pageState(tabId)).removed;
  const bar = await page.evaluate(() => {
    const b = document
      .querySelector('[data-websnap-ui]')
      .shadowRoot.querySelector('.bar span')
      .getBoundingClientRect();
    return { x: b.left + 5, y: b.top + b.height / 2 };
  });
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.click(bar.x, bar.y);
  await wait(100);
  const after = await pageState(tabId);
  check(
    after.removed === before && after.pickerActive,
    `click on the toolbar text removed nothing (${before} -> ${after.removed})`,
  );
  const done = await page.evaluate(() => {
    const b = [
      ...document.querySelector('[data-websnap-ui]').shadowRoot.querySelectorAll('.bar button'),
    ].find((x) => x.textContent === 'Done');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(done.x, done.y);
  await page.mouse.click(done.x, done.y);
  await wait(100);
  const afterDone = await pageState(tabId);
  const hostGone = await page.evaluate(() => !document.querySelector('[data-websnap-ui]'));
  check(
    !afterDone.pickerActive && hostGone && afterDone.removed === before,
    'toolbar "Done" button still works (stops the picker, keeps removals)',
  );
  await send(tabId, { type: 'ps:reset-page' });
  const restored = await page.evaluate(() => getComputedStyle(document.getElementById('top')).display);
  check(restored !== 'none', 'reset restores removed elements');
  await page.close();
});

await test('picker: works on pages that enforce Trusted Types', async () => {
  const { page, tabId } = await openTab('picker-tt.html');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const res = await startPicker(tabId, 'remove');
  const hl = await pickerRect(page);
  check(
    res.ok && hl && /Remove elements/.test(hl.barText),
    'toolbar rendered',
    JSON.stringify({ res, bar: hl && hl.barText }),
  );
  const res2 = await startPicker(tabId, 'print');
  const hl2 = await pickerRect(page);
  check(
    res2.ok && hl2 && /Select an? element/.test(hl2.barText),
    'select-mode toolbar rendered',
    JSON.stringify({ res2, bar: hl2 && hl2.barText }),
  );
  // The preview overlay is built without HTML strings too.
  const h1 = await rectOf(page, 'h1');
  await page.mouse.move(h1.left + 10, h1.top + 10);
  await wait(50);
  await page.mouse.click(h1.left + 10, h1.top + 10);
  const info = await waitForPreview(page);
  check(
    info.ready && info.formats.length === 3,
    'preview overlay renders under Trusted Types',
    JSON.stringify(info),
  );
  check(
    !errors.some((e) => /TrustedHTML|Trusted Type/i.test(e)),
    'no Trusted Types violations',
    errors.join(' | '),
  );
  await send(tabId, { type: 'ps:reset-page' });
  await page.close();
});

await test('picker: refused while an export holds the tab', async () => {
  const PICKER = '[data-websnap-ui=""]';
  const REFUSAL = 'Wait for the current export to finish before selecting elements.';
  const { page, tabId } = await openTab('article.html');
  // Inside the article root, so the export is unchanged; it only keeps the export running long
  // enough to send both picker requests while activeJobs holds the tab.
  await page.evaluate(
    (n) => document.getElementById('body').insertAdjacentHTML('beforeend', '<p>filler</p>'.repeat(n)),
    1500,
  );
  // pageState through the worker (it reports busy); errors come back as { error } instead of a
  // wrapped evaluate failure.
  const hook = (fn, ...args) =>
    sw.evaluate(({ fn, args }) => globalThis.__websnap[fn](...args).catch((e) => ({ error: e.message })), {
      fn,
      args,
    });
  const pickerOpen = () => page.evaluate((s) => !!document.querySelector(s), PICKER);
  await sw.evaluate((id) => {
    globalThis.__heldExport = globalThis.__websnap
      .generate({ tabId: id, prep: 'article', output: 'return', settings: { loadLazy: true } })
      .then(
        (r) => ({ ok: r.ok }),
        (e) => ({ error: e.message }),
      );
  }, tabId);
  try {
    await waitFor(() => page.evaluate(() => !!document.querySelector('[data-websnap-root]')), {
      interval: 10,
      label: 'prepare() to mark the article root',
    });
    const busyBefore = (await hook('pageState', tabId)).busy;
    check(
      busyBefore === true,
      'the export holds the tab before the first picker request',
      `busy ${busyBefore}`,
    );
    for (const mode of ['remove', 'print']) {
      const res = await hook('startPicker', tabId, mode);
      check(
        res.error === REFUSAL,
        `startPicker('${mode}') is refused during the export`,
        JSON.stringify(res),
      );
      check(!(await pickerOpen()), `no ${mode} picker opens during the export`);
    }
    const busyAfter = (await hook('pageState', tabId)).busy;
    check(
      busyAfter === true,
      'the export still holds the tab after the last picker request',
      `busy ${busyAfter}`,
    );
    const exported = await sw.evaluate(() => globalThis.__heldExport);
    check(exported.ok === true, 'the held export succeeds', JSON.stringify(exported));
    const busyDone = (await hook('pageState', tabId)).busy;
    const res = await hook('startPicker', tabId, 'remove');
    const open = await pickerOpen();
    check(
      busyDone === false && res.ok === true && open,
      'the picker opens once the export has ended',
      JSON.stringify({ busyDone, res, open }),
    );
  } finally {
    await sw.evaluate(() => globalThis.__heldExport);
    await send(tabId, { type: 'ps:reset-page' });
    await page.close();
  }
});

// --- 6. shadow DOM --------------------------------------------------------------------------

await test('shadow DOM: remove mode picks elements inside an open shadow root', async () => {
  const { page, tabId } = await openTab('picker.html');
  await send(tabId, { type: 'ps:start-picker', mode: 'remove' });
  const r = await page.evaluate(() => {
    const b = document.getElementById('card').shadowRoot.getElementById('inner').getBoundingClientRect();
    return { x: b.left + 20, y: b.top + 20 };
  });
  await page.mouse.move(r.x, r.y);
  await wait(50);
  const tag = await pickerRect(page);
  await page.mouse.click(r.x, r.y);
  await wait(100);
  const st = await page.evaluate(() => ({
    host: getComputedStyle(document.getElementById('card')).display,
    inner: getComputedStyle(document.getElementById('card').shadowRoot.getElementById('inner')).display,
    other: getComputedStyle(document.getElementById('card').shadowRoot.getElementById('shadow-other'))
      .display,
  }));
  check(
    st.inner === 'none' && st.host !== 'none' && st.other !== 'none',
    'only the shadow element was removed, not the whole component',
    JSON.stringify(st) + ' hl=' + JSON.stringify(tag),
  );
  await send(tabId, { type: 'ps:reset-page' });
  await page.close();
});

await test('shadow DOM: "select element" isolation crosses the shadow boundary', async () => {
  const { page, tabId } = await openTab('picker.html');
  const before = await snapshot(page);
  await send(tabId, { type: 'ps:start-picker', mode: 'print' });
  // Capture the ps:preview-element request instead of starting a real capture.
  await stubSendMessage(tabId);
  const r = await page.evaluate(() => {
    const b = document.getElementById('card').shadowRoot.getElementById('inner').getBoundingClientRect();
    return { x: b.left + 20, y: b.top + 20 };
  });
  await page.mouse.move(r.x, r.y);
  await wait(50);
  await page.mouse.click(r.x, r.y);
  await wait(100);
  const sent = await readSentMessages(tabId);
  check(
    Array.isArray(sent) && sent.some((m) => m.type === 'ps:preview-element'),
    'click requested an element preview',
    JSON.stringify(sent),
  );
  const res = await send(tabId, { ...PREP_ALL, prep: 'element' });
  check(res.ok, 'prepare(element) ok', res.error || '');
  const st = await page.evaluate(() => {
    const sr = document.getElementById('card').shadowRoot;
    return {
      picked: sr.getElementById('inner').hasAttribute('data-websnap-root'),
      outside: getComputedStyle(document.getElementById('outside')).display,
      target: getComputedStyle(document.getElementById('target')).display,
      other: getComputedStyle(sr.getElementById('shadow-other')).display,
      inner: getComputedStyle(sr.getElementById('inner')).display,
      text: sr.getElementById('inner').innerText,
      host: getComputedStyle(document.getElementById('card')).display,
    };
  });
  check(st.picked, 'the shadow <section> is the isolated root');
  check(
    st.outside === 'none' && st.target === 'none',
    `light-DOM content outside the component hidden (${st.outside}, ${st.target})`,
  );
  check(st.other === 'none', `sibling inside the shadow root hidden (${st.other})`);
  check(
    st.inner !== 'none' && st.host !== 'none' && st.text.includes('SHADOW-MARK'),
    'picked shadow content (and its host) still visible',
  );
  await send(tabId, { type: 'ps:restore' });
  await send(tabId, { type: 'ps:reset-page' });
  await expectRestored(page, before);
  await page.close();
});

await test('shadow DOM: isolating a slotted element hides the component chrome around the slot', async () => {
  const { page, tabId } = await openTab('picker.html');
  const before = await snapshot(page);
  await send(tabId, { type: 'ps:start-picker', mode: 'print' });
  await stubSendMessage(tabId);
  const r = await rectOf(page, '#slotted');
  await page.mouse.move(r.left + 20, r.top + 5);
  await wait(50);
  await page.mouse.click(r.left + 20, r.top + 5);
  await wait(100);
  const res = await send(tabId, { ...PREP_ALL, prep: 'element' });
  check(res.ok, 'prepare(element) ok', res.error || '');
  const st = await page.evaluate(() => {
    const sr = document.getElementById('layout').shadowRoot;
    return {
      picked: document.getElementById('slotted').hasAttribute('data-websnap-root'),
      chrome: getComputedStyle(sr.getElementById('chrome')).display,
      outside: getComputedStyle(document.getElementById('outside')).display,
      slotted: document.getElementById('slotted').getBoundingClientRect().height,
    };
  });
  check(st.picked, 'slotted element is the isolated root');
  check(
    st.chrome === 'none' && st.outside === 'none',
    `component chrome and outside content hidden (${st.chrome}, ${st.outside})`,
  );
  check(st.slotted > 0, 'slotted content still rendered');
  await send(tabId, { type: 'ps:restore' });
  await send(tabId, { type: 'ps:reset-page' });
  await expectRestored(page, before);
  await page.close();
});

// --- 7. element preview & image export ------------------------------------------------------

const RED = [255, 0, 0];

await test('capture: Page.captureScreenshot clip is document-relative with captureBeyondViewport', async () => {
  // Raw CDP probe (no preparation) of the assumption background.js relies on: the clip is given in
  // document coordinates, whatever the scroll position.
  const { page, tabId } = await openTab('element.html');
  for (const scrollY of [0, 1500, 4000]) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), scrollY);
    const r = await page.evaluate(() => {
      const b = document.getElementById('red').getBoundingClientRect();
      return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height, vh: innerHeight };
    });
    const b64 = await sw.evaluate(
      async ({ tabId, r }) => {
        const t = { tabId };
        await chrome.debugger.attach(t, '1.3');
        try {
          // The clip is shorter than the viewport, so the debugger info bar resizing the viewport
          // cannot make the capture repeat content (see waitForStableViewport in background.js).
          await new Promise((res) => setTimeout(res, 600));
          const { data } = await chrome.debugger.sendCommand(t, 'Page.captureScreenshot', {
            format: 'png',
            clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 },
            captureBeyondViewport: true,
          });
          return data;
        } finally {
          await chrome.debugger.detach(t);
        }
      },
      { tabId, r },
    );
    const png = decodePng(Buffer.from(b64, 'base64'));
    const c = png.pixel(png.width >> 1, png.height >> 1);
    check(
      isColor(c, RED),
      `scrollY ${scrollY}: clip at document y=${r.y} (viewport ${r.vh}px) captures the red element (${c})`,
    );
  }
  await page.close();
});

await test('preview: picker click opens the full-page overlay with a preview of just that element; Esc closes and restores', async () => {
  await setSettings({ imageScale: 2, theme: 'dark' });
  const { page, tabId } = await openTab('element.html');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.evaluate(() => window.scrollTo({ top: 4800, behavior: 'instant' }));
  const before = await snapshot(page);
  const info = await pickElement(page, tabId, '#red', { scroll: false });
  check(info.ready, 'overlay shows the captured preview', JSON.stringify(info));
  check(
    info.title === 'Export this element' || /\S/.test(info.title),
    `overlay title from background strings (${info.title})`,
  );
  check(
    /div#red · 400×300 px/.test(info.caption),
    `caption names the element and its size (${info.caption})`,
  );
  check(
    !info.dialogCard &&
      info.overlay.top === 0 &&
      info.overlay.left === 0 &&
      info.overlay.width === info.viewport.width &&
      info.overlay.height === info.viewport.height,
    `overlay covers the whole viewport, no dialog card (${JSON.stringify(info.overlay)})`,
  );
  check(
    info.toolbar.top === 0 && info.toolbar.width === info.viewport.width,
    `toolbar fixed at the top of the viewport (${JSON.stringify(info.toolbar)})`,
  );
  check(info.stage.top >= info.toolbar.bottom - 1, 'preview below the toolbar');
  check(
    near(info.stage.bottom, info.viewport.height, 1),
    `preview fills the rest of the viewport (stage ${info.stage.top}–${info.stage.bottom})`,
  );
  check(
    info.canvas &&
      info.canvas.width === 400 &&
      info.canvas.height === 300 &&
      info.canvas.cssWidth === '400px',
    `preview is the element at screen resolution (${JSON.stringify(info.canvas)})`,
  );
  check(
    info.parts.length === 1 && !info.parts[0].label && !info.splitNote,
    'small element: one part, no split',
  );
  const centre = await previewPixel(page, 0.5, 0.5);
  const corner = await previewPixel(page, 0.02, 0.98);
  check(
    isColor(centre, RED) && isColor(corner, RED),
    `preview pixels are the element's colour (${centre} / ${corner})`,
  );
  check(
    JSON.stringify(info.formats) === '["pdf","png","jpeg"]',
    `format control PDF | PNG | JPEG, no Markdown by default (${info.formats})`,
  );
  check(
    info.checked === 'pdf' && !info.copyVisible,
    `PDF selected by default, Copy hidden (${info.checked})`,
  );
  check(info.theme === 'dark', `theme "dark" from settings applied (${info.theme})`);
  check(
    info.buttons.join('|') === 'Download|Reselect|Toggle light / dark|Close',
    `toolbar actions with PDF (${info.buttons.join('|')})`,
  );
  await chooseFormat(page, 'png');
  let now = await previewInfo(page);
  check(now.checked === 'png' && now.copyVisible, 'choosing PNG selects it and shows "Copy image"');
  check(
    now.buttons.join('|') === 'Copy image|Download|Reselect|Toggle light / dark|Close',
    `toolbar actions with PNG (${now.buttons.join('|')})`,
  );
  await page.locator('[data-websnap-ui="preview"] select.format').focus();
  await page.keyboard.press('j');
  now = await previewInfo(page);
  check(
    now.checked === 'jpeg' && now.copyVisible && !now.downloadDisabled,
    `type-ahead moves to JPEG; Copy image stays available for JPEG (${now.checked})`,
  );
  // The page is already back to normal while the overlay is open.
  const st = await pageState(tabId);
  check(st.previewOpen && !st.pickerActive, 'picker stopped, preview open');
  await expectRestored(
    page,
    before,
    'page fully restored after the preview capture (styles, scroll position)',
  );
  const header = await page.evaluate(() => getComputedStyle(document.querySelector('header.fixed')).display);
  check(header !== 'none', 'fixed header visible again');
  // The wheel over the toolbar does not scroll the page underneath.
  await page.mouse.move(200, Math.round(info.toolbar.height / 2));
  await page.mouse.wheel(0, 400);
  await wait(150);
  check((await page.evaluate(() => scrollY)) === 4800, 'wheel over the toolbar leaves the page alone');
  await page.mouse.move(100, Math.round(info.toolbar.bottom + 200)); // the preview has nothing to scroll
  await page.mouse.wheel(0, 400);
  await wait(150);
  check((await page.evaluate(() => scrollY)) === 4800, 'wheel over a short preview leaves the page alone');
  await page.keyboard.press('Escape');
  await wait(100);
  const after = await pageState(tabId);
  const host = await page.evaluate(() => !!document.querySelector('[data-websnap-ui]'));
  check(!after.previewOpen && !host, 'Esc closes the overlay');
  await expectRestored(page, before, 'page unchanged after closing the overlay');
  check(errors.length === 0, 'no page errors', errors.join(' | '));
  await page.close();
  await setSettings({});
});

await test('preview: Copy image puts a PNG on the clipboard for PNG and JPEG', async () => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const { page, tabId } = await openTab('element.html');
  await pickElement(page, tabId, '#red');
  const readClipboard = () =>
    page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items[0];
      if (!item || !item.types.includes('image/png')) return { types: item ? item.types : [] };
      const bmp = await createImageBitmap(await item.getType('image/png'));
      return { types: item.types, width: bmp.width, height: bmp.height };
    });
  for (const format of ['png', 'jpeg']) {
    await page.evaluate(() => navigator.clipboard.writeText('-')); // clear
    await chooseFormat(page, format);
    await clickPreview(page, '.copy');
    const clip = await waitFor(
      async () => {
        const c = await readClipboard();
        return c.types.includes('image/png') ? c : null;
      },
      { label: 'image on the clipboard' },
    ).catch(() => ({ types: [] }));
    const copied = await previewInfo(page);
    check(
      clip.types.includes('image/png') && clip.width === 400 && clip.height === 300,
      `${format.toUpperCase()} selected: clipboard holds a 400×300 PNG (${JSON.stringify(clip)}; ${copied.status})`,
    );
  }
  await closePreviewOverlay(page);
  await context.clearPermissions();
  await page.close();
});

await test('preview: theme toggle switches the overlay at once and saves settings.theme', async () => {
  await setSettings({ theme: 'system' });
  const { page, tabId } = await openTab('element.html');
  await page.emulateMedia({ colorScheme: 'dark' });
  const info = await pickElement(page, tabId, '#red');
  check(info.theme === 'dark', `'system' resolved through matchMedia (dark) (${info.theme})`);
  const stored = () => sw.evaluate(async () => (await chrome.storage.sync.get('settings')).settings?.theme);
  await clickPreview(page, '.theme');
  let now = await previewInfo(page);
  check(now.theme === 'light', `toggle switches the overlay to light immediately (${now.theme})`);
  const saved = await waitFor(async () => ((await stored()) === 'light' ? 'light' : null), {
    label: 'theme saved',
  });
  check(saved === 'light', 'settings.theme saved as "light" through the worker');
  await clickPreview(page, '.theme');
  now = await previewInfo(page);
  check(now.theme === 'dark', `toggling again gives dark (${now.theme})`);
  await waitFor(async () => (await stored()) === 'dark', { label: 'theme saved dark' });
  check(true, 'settings.theme saved as "dark"');
  // The picker toolbar follows the same theme.
  await clickPreview(page, '.reselect');
  await wait(100);
  const barTheme = await page.evaluate(
    () => document.querySelector('[data-websnap-ui]').shadowRoot.querySelector('.bar').dataset.theme,
  );
  check(barTheme === 'dark', `picker toolbar uses the overlay's theme (${barTheme})`);
  await send(tabId, { type: 'ps:reset-page' });
  await setSettings({ theme: 'light' });
  await startPicker(tabId, 'remove');
  const bar = await page.evaluate(() => {
    const b = document.querySelector('[data-websnap-ui]').shadowRoot.querySelector('.bar');
    return { theme: b.dataset.theme, bg: getComputedStyle(b).backgroundColor };
  });
  check(
    bar.theme === 'light' && bar.bg === 'rgb(255, 255, 255)',
    `picker toolbar light when settings.theme is light (${JSON.stringify(bar)})`,
  );
  await send(tabId, { type: 'ps:reset-page' });
  await page.close();
  await setSettings({});
});

await test('preview: toolbar wraps at 360 px and keeps keyboard focus inside the overlay', async () => {
  const { page, tabId } = await openTab('element.html');
  const info = await pickElement(page, tabId, '#red');
  // Resized once the overlay is open: the capture's debugger session drops Playwright's viewport
  // emulation (the window itself cannot be narrower than 500 px).
  await page.setViewportSize({ width: 360, height: 740 });
  await wait(100);
  await chooseFormat(page, 'jpeg');
  const now = await previewInfo(page);
  check(now.viewport.width === 360, `viewport is 360 px wide (${now.viewport.width})`);
  await page.screenshot({ path: path.join(outDir, 'preview-overlay-360.png') }); // for visual review
  check(
    now.toolbar.scrollWidth <= 360 && now.actionsRight <= 360,
    `every toolbar control fits in 360 px (scrollWidth ${now.toolbar.scrollWidth}, right ${now.actionsRight})`,
  );
  check(now.toolbar.height > 60, `toolbar wraps onto several rows (${Math.round(now.toolbar.height)} px)`);
  check(now.stage.top >= now.toolbar.bottom - 1 && now.stage.height > 200, 'preview still gets the rest');
  check(info.ready, 'preview rendered at 360 px');
  // Tab cycles through the overlay's controls and never reaches the page.
  const seen = new Set();
  let escaped = false;
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab');
    const f = await page.evaluate(() => {
      const host = document.querySelector('[data-websnap-ui="preview"]');
      if (document.activeElement !== host) return null;
      const a = host.shadowRoot.activeElement;
      return a ? a.className || a.dataset.format || a.tagName : null;
    });
    if (!f) escaped = true;
    else seen.add(f);
  }
  check(!escaped, 'focus never leaves the overlay');
  check(
    ['btn copy', 'btn primary download', 'btn reselect', 'btn icon theme', 'btn icon close'].every((c) =>
      seen.has(c),
    ),
    `every toolbar action reachable with Tab (${[...seen].join(', ')})`,
  );
  await page.keyboard.press('Escape');
  await wait(100);
  check(!(await previewInfo(page)), 'Esc closes the overlay');
  await page.close();
});

await test('preview: Download PNG saves the element at settings.imageScale; JPEG export; format remembered', async () => {
  await setSettings({ imageScale: 2, filenameTemplate: '{title} {time}' });
  const { page, tabId } = await openTab('element.html');
  await pickElement(page, tabId, '#red');
  await chooseFormat(page, 'png');
  await clickPreview(page, '.download');
  const item = await waitForDownload((i) => /Element Fixture.*\.png$/.test(i.filename));
  check(
    path.dirname(item.filename) === fs.realpathSync(downloadDir) ||
      path.dirname(item.filename) === downloadDir,
    `PNG downloaded (${path.basename(item.filename)})`,
  );
  check(!/-1\.png$/.test(item.filename), 'single-part image has no part suffix');
  const png = decodePng(fs.readFileSync(item.filename));
  check(
    png.width === 800 && png.height === 600,
    `PNG is element size × imageScale 2 (${png.width}×${png.height})`,
  );
  check(isColor(png.pixel(400, 300), RED) && isColor(png.pixel(5, 595), RED), 'PNG shows only the element');
  const closed = await waitFor(async () => !(await previewInfo(page)), { label: 'overlay to close' });
  check(closed, 'overlay closes after a successful download');

  // JPEG through the same background export.
  const res = await sw.evaluate((id) => globalThis.__websnap.exportElementImage(id, 'jpeg'), tabId);
  const jpg = await waitForDownload((i) => /\.jpg$/.test(i.filename));
  const head = fs.readFileSync(jpg.filename).subarray(0, 3);
  check(
    res.ok && res.width === 800 && res.height === 600 && res.count === 1,
    `JPEG export reports 800×600, one part (${res.width}×${res.height}, ${res.count})`,
  );
  check(
    head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    `JPEG file starts with FF D8 (${path.basename(jpg.filename)})`,
  );

  // The last format chosen in the overlay is the default next time.
  const again = await pickElement(page, tabId, '#red');
  check(again.checked === 'png', `last format remembered (${again.checked})`);
  await clickPreview(page, '.close');
  const overlayGone = await waitFor(async () => !(await previewInfo(page)), {
    label: 'preview overlay closed',
  }).catch(() => false);
  check(overlayGone, 'Close button closes the overlay');
  await page.close();
  await setSettings({});
});

await test('preview: Download PDF saves a PDF with only the element (overlay not printed)', async () => {
  const { page, tabId } = await openTab('element.html');
  await page.evaluate(() => window.scrollTo({ top: 4700, behavior: 'instant' }));
  const before = await snapshot(page);
  await pickElement(page, tabId, '#red', { scroll: false });
  await chooseFormat(page, 'pdf');
  await clickPreview(page, '.download');
  const item = await waitForDownload((i) => /Element Fixture.*\.pdf$/.test(i.filename), 60000);
  const text = execFileSync('pdftotext', ['-layout', item.filename, '-'], { encoding: 'utf8' });
  check(text.includes('RED-MARK'), 'PDF contains the element text');
  check(
    !text.includes('BEFORE-MARK') && !text.includes('AFTER-MARK') && !text.includes('ELEMENT-FIXED-HEADER'),
    'PDF contains nothing else',
  );
  check(!/Export this element|Download|Reselect/.test(text), 'preview overlay not printed');
  await waitFor(async () => !(await previewInfo(page)), { label: 'overlay to close' });
  await expectRestored(page, before, 'page restored after the PDF export');
  await page.close();
});

await test('preview: Reselect restarts the picker in select mode', async () => {
  const { page, tabId } = await openTab('element.html');
  await pickElement(page, tabId, '#red');
  await clickPreview(page, '.reselect');
  await wait(100);
  const st = await pageState(tabId);
  const bar = await pickerRect(page);
  check(st.pickerActive && !st.previewOpen, 'overlay closed, picker active again');
  check(
    bar && /Select an? element/.test(bar.barText),
    `picker toolbar in select mode (${bar && bar.barText})`,
  );
  // Picking again opens a new preview.
  const r = await rectOf(page, '#red');
  await page.mouse.move(r.left + 50, r.top + 50);
  await page.mouse.click(r.left + 50, r.top + 50);
  const info = await waitForPreview(page);
  check(info.ready, 'picking again shows a new preview');
  await send(tabId, { type: 'ps:reset-page' });
  check(!(await previewInfo(page)), 'reset-page closes the overlay');
  await page.close();
});

await test('split: a 400×3700 element is shown and saved as 3 parts (1600 / 1600 / 500)', async () => {
  await setSettings({ imageScale: 1, filenameTemplate: 'split-part' });
  const { page, tabId } = await openTab('element.html');
  await page.evaluate(() =>
    document.querySelector('#split').scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  const before = await snapshot(page);
  const info = await pickElement(page, tabId, '#split', { scroll: false });
  check(/div#split\.stripes · 400×3700 px/.test(info.caption), `caption (${info.caption})`);
  const dims = info.canvases.map((c) => `${c.width}×${c.height}`).join(', ');
  check(
    dims === '400×1600, 400×1600, 400×500' && info.canvases.every((c) => c.cssWidth === '400px'),
    `three preview canvases at scale 1 (${dims})`,
  );
  check(
    info.parts.map((p) => p.label).join('|') === 'Part 1 of 3|Part 2 of 3|Part 3 of 3',
    `part headers (${info.parts.map((p) => p.label).join('|')})`,
  );
  check(info.checked === 'pdf', `PDF is selected by default (${info.checked})`);
  check(
    info.splitNote === '' && info.partHeads.length === 3 && info.partHeads.every((h) => !h),
    `PDF selected: no split note and no part headers (${JSON.stringify([info.splitNote, info.partHeads])})`,
  );
  check(info.partsGap === '0px', `PDF selected: the parts touch (gap ${info.partsGap})`);
  // Each canvas shows its own slice of the element (stripes 0, 16 and 32 at the top).
  const tops = [];
  for (const [i, first] of [
    [0, 0],
    [1, 16],
    [2, 32],
  ]) {
    const c = await previewPixel(page, 0.5, 50 / (i === 2 ? 500 : 1600), i);
    const k = first % 25;
    tops.push(isColor(c, [k * 10, 100, 255 - k * 10]));
  }
  check(tops.every(Boolean), `each part starts at its own stripe (${tops})`);
  // PDF selected: parts have no per-part actions; the toolbar says Download.
  await chooseFormat(page, 'pdf');
  let now = await previewInfo(page);
  check(
    now.parts.every((p) => !p.copy && !p.download) && now.downloadLabel === 'Download',
    `PDF: no per-part buttons, "${now.downloadLabel}"`,
  );
  await chooseFormat(page, 'png');
  now = await previewInfo(page);
  check(
    now.parts.every((p) => p.copy && p.download) && now.downloadLabel === 'Download all parts',
    `PNG: per-part Copy / Download, toolbar "${now.downloadLabel}"`,
  );
  check(
    now.splitNote === 'Split into 3 parts for easier viewing' &&
      now.partHeads.every(Boolean) &&
      now.partsGap === '24px',
    `PNG selected: split note, part headers and the 24 px gap (${now.splitNote}, ${now.partsGap})`,
  );
  check(/Part 1 of 3/.test(now.copyTitle), `toolbar Copy tooltip names part 1 (${now.copyTitle})`);

  // Per-part Download: only that part, overlay stays open.
  const t0 = new Date().toISOString();
  await clickPreview(page, '.part[data-part="3"] .part-download');
  const one = await waitForDownload((i) => /split-part-3\.png$/.test(i.filename) && i.startTime >= t0);
  const p3 = decodePng(fs.readFileSync(one.filename));
  check(p3.width === 400 && p3.height === 500, `part 3 saved as 400×500 (${p3.width}×${p3.height})`);
  check(badStripes(p3, 5, 32).length === 0, 'part 3 holds stripes 32–36', badStripes(p3, 5, 32).join(', '));
  const kept = await waitFor(
    async () => {
      const i = await previewInfo(page);
      return i && /Saved/.test(i.status) ? i : null;
    },
    { label: 'saved status' },
  );
  check(/split-part-3\.png/.test(kept.status), `overlay stays open after a part download (${kept.status})`);
  const partFiles = (await sw.evaluate(() => chrome.downloads.search({ limit: 50 }))).filter((i) =>
    /split-part-[12]\.png$/.test(i.filename),
  );
  check(partFiles.length === 0, 'the other parts were not downloaded');

  // Download all parts: one file per part, -1 / -2 / -3.
  await setSettings({ imageScale: 1, filenameTemplate: 'split-all' });
  const t1 = new Date().toISOString();
  await clickPreview(page, '.download');
  const files = await waitForDownloads((i) => /split-all-\d\.png$/.test(i.filename) && i.startTime >= t1, 3);
  const names = files.map((f) => path.basename(f.filename)).sort();
  check(
    names.join(',') === 'split-all-1.png,split-all-2.png,split-all-3.png',
    `three files named -1 / -2 / -3 (${names})`,
  );
  const pngs = names.map((n) => decodePng(fs.readFileSync(path.join(path.dirname(files[0].filename), n))));
  check(
    pngs.map((p) => `${p.width}×${p.height}`).join(', ') === '400×1600, 400×1600, 400×500',
    `part sizes (${pngs.map((p) => `${p.width}×${p.height}`).join(', ')})`,
  );
  const bad = [...badStripes(pngs[0], 16, 0), ...badStripes(pngs[1], 16, 16), ...badStripes(pngs[2], 5, 32)];
  check(bad.length === 0, 'the parts line up: every stripe once, in order', bad.slice(0, 5).join(', '));
  await waitFor(async () => !(await previewInfo(page)), { label: 'overlay to close' });
  check(true, 'overlay closes after Download all parts');
  await expectRestored(page, before, 'page restored after the split exports');

  // The background splits at 1600 CSS px and returns every part.
  const res = await sw.evaluate(
    (id) => globalThis.__websnap.exportElementImage(id, 'png', { output: 'return' }),
    tabId,
  );
  check(
    res.count === 3 && res.filenames.join(',') === 'split-all-1.png,split-all-2.png,split-all-3.png',
    `exportElementImage returns 3 parts (${res.filenames})`,
  );
  const only2 = await sw.evaluate(
    (id) => globalThis.__websnap.exportElementImage(id, 'jpeg', { output: 'return', part: 2 }),
    tabId,
  );
  check(
    only2.parts.length === 1 &&
      only2.parts[0].filename === 'split-all-2.jpg' &&
      only2.parts[0].height === 1600,
    `part: 2 captures only the second part (${JSON.stringify(only2.parts.map(({ base64, ...p }) => p))})`,
  );
  const split = await sw.evaluate(() =>
    globalThis.__websnap.splitRect({ x: 5, y: 7, width: 10, height: 3200 }),
  );
  check(
    split.map((r) => `${r.y}+${r.height}`).join(',') === '7+1600,1607+1600',
    `an exact multiple gives no empty part (${JSON.stringify(split)})`,
  );
  await page.close();
  await setSettings({});
});

await test('capture: tall element (3× viewport) is captured in full, split at 1600 px', async () => {
  const { page, tabId } = await openTab('element.html');
  const info = await pickElement(page, tabId, '#tall');
  check(/div#tall\.stripes · 500×2400 px/.test(info.caption), `caption (${info.caption})`);
  const vh = await page.evaluate(() => innerHeight);
  check(2400 >= vh * 3, `element is at least 3× the viewport height (2400 vs ${vh})`);
  check(
    info.canvases.map((c) => c.height).join(',') === '1600,800',
    `preview in two parts (${info.canvases.map((c) => c.height)})`,
  );
  await closePreviewOverlay(page);
  for (const imageScale of [1, 2]) {
    await setSettings({ imageScale });
    const res = await sw.evaluate(
      (id) => globalThis.__websnap.exportElementImage(id, 'png', { output: 'return' }),
      tabId,
    );
    const pngs = res.parts.map((p) => decodePng(Buffer.from(p.base64, 'base64')));
    const sizes = pngs.map((p) => `${p.width}×${p.height}`).join(', ');
    check(
      sizes === `${500 * imageScale}×${1600 * imageScale}, ${500 * imageScale}×${800 * imageScale}`,
      `scale ${imageScale}: parts ${sizes} = element × scale`,
    );
    const bad = [...badStripes(pngs[0], 16, 0), ...badStripes(pngs[1], 8, 16)];
    check(
      bad.length === 0,
      `scale ${imageScale}: every 100px band captured in place (no repeated viewport)`,
      bad.slice(0, 5).join(', '),
    );
    check(!res.warning, 'no size warning');
  }
  await page.close();
  await setSettings({});
});

await test('capture: 20000 px tall element needs no reduction once split (13 parts at 2×)', async () => {
  await setSettings({ imageScale: 2 });
  const { page, tabId } = await openTab('element.html');
  const info = await pickElement(page, tabId, '#huge');
  check(info.ready && info.parts.length === 13, `preview in 13 parts (${info.parts.length})`);
  await chooseFormat(page, 'png');
  const withPng = await previewInfo(page);
  check(!withPng.warning, `no size warning (${withPng.warning})`);
  await closePreviewOverlay(page);
  const res = await sw.evaluate(
    (id) => globalThis.__websnap.exportElementImage(id, 'png', { output: 'return' }),
    tabId,
  );
  check(
    res.scale === 2 && !res.warning && res.parts.length === 13,
    `full 2× scale in 13 parts (scale ${res.scale}, ${res.parts.length} parts)`,
  );
  const bad = [];
  let top = 0; // CSS px of the part's top edge; stripes are 1000 px
  for (const p of res.parts) {
    const png = decodePng(Buffer.from(p.base64, 'base64'));
    if (png.width !== 600) bad.push(`width ${png.width}`);
    // Sample the middle of every 1000 px stripe that lies fully inside the part.
    for (let s = Math.ceil(top / 1000); (s + 1) * 1000 <= top + png.height / 2; s++) {
      const y = Math.round((s * 1000 + 500 - top) * 2);
      const c = png.pixel(300, y);
      if (!isColor(c, [s * 10, 100, 255 - s * 10])) bad.push(`${s}:${c.join('/')}`);
    }
    top += png.height / 2;
  }
  check(top === 20000, `parts add up to the element height (${top})`);
  check(bad.length === 0, 'every band rendered in place across the parts', bad.slice(0, 5).join(', '));
  await page.close();
  await setSettings({});
});

await test('capture: very wide element is capped at 16384 px with a warning', async () => {
  await setSettings({ imageScale: 2 });
  const { page, tabId } = await openTab('element.html');
  const info = await pickElement(page, tabId, '#wide');
  await chooseFormat(page, 'pdf');
  const withPdf = await previewInfo(page);
  check(info.ready && !withPdf.warning, 'preview shown, no warning while PDF is selected');
  await chooseFormat(page, 'png');
  const withPng = await previewInfo(page);
  check(
    /16,384|16384/.test(withPng.warning) && /1\.82/.test(withPng.warning),
    `caption warns about the reduced image scale (${withPng.warning})`,
  );
  check(
    info.canvas.width <= 16384,
    `preview itself within the limit (${info.canvas.width}×${info.canvas.height})`,
  );
  await closePreviewOverlay(page);
  const res = await sw.evaluate(
    (id) => globalThis.__websnap.exportElementImage(id, 'png', { output: 'return' }),
    tabId,
  );
  const png = decodePng(Buffer.from(res.parts[0].base64, 'base64'));
  check(
    png.width <= 16384 && png.width >= 16000,
    `PNG width capped (${png.width}×${png.height}, scale ${res.scale})`,
  );
  check(
    Math.abs(png.width - 9000 * res.scale) <= 1 && Math.abs(png.height - 200 * res.scale) <= 1,
    'PNG keeps the aspect ratio at the reduced scale',
  );
  const left = png.pixel(20, png.height >> 1);
  const right = png.pixel(png.width - 20, png.height >> 1);
  check(
    left[1] > 120 && left[2] < 40 && right[2] > 150 && right[1] < 40,
    `both ends of the element rendered (${left} … ${right})`,
  );
  check(/16,384|16384/.test(res.warning || ''), `export returns a warning (${res.warning})`);
  // Through the overlay: a download that comes back with a warning keeps the overlay open to show it.
  await pickElement(page, tabId, '#wide');
  await chooseFormat(page, 'png');
  const t0 = new Date().toISOString();
  await clickPreview(page, '.download');
  const item = await waitForDownload((i) => /Element Fixture.*\.png$/.test(i.filename) && i.startTime >= t0);
  check(
    decodePng(fs.readFileSync(item.filename)).width <= 16384,
    `downloaded PNG within the limit (${path.basename(item.filename)})`,
  );
  const kept = await waitFor(
    async () => {
      const i = await previewInfo(page);
      return i && /Saved/.test(i.status) ? i : null;
    },
    { label: 'saved status' },
  );
  check(
    kept.hostDisplay !== 'none' && /16,384|16384/.test(kept.warning),
    `overlay stays visible with the warning after saving (${kept.status})`,
  );
  await closePreviewOverlay(page);
  await page.close();
  await setSettings({});
});

// --- 8. Markdown export (experimental) ------------------------------------------------------

await test('markdown: gated by settings.markdownEnabled; article conversion', async () => {
  const { page, tabId } = await openTab('markdown.html');
  await setSettings({ markdownEnabled: false });
  const denied = await sw.evaluate(
    (id) =>
      globalThis.__websnap
        .exportMarkdown(id, 'article', { output: 'return' })
        .catch((e) => ({ error: e.message })),
    tabId,
  );
  check(/experimental feature/i.test(denied.error || ''), `rejected while disabled (${denied.error})`);
  const viaMsg = await sw.evaluate(
    (id) => globalThis.__websnap.exportMarkdown(id, 'none').catch((e) => ({ error: e.message })),
    tabId,
  );
  check(/experimental feature/i.test(viaMsg.error || ''), 'page export rejected too');

  await setSettings({ markdownEnabled: true });
  const res = await sw.evaluate(
    (id) => globalThis.__websnap.exportMarkdown(id, 'article', { output: 'return' }),
    tabId,
  );
  const md = res.markdown || '';
  fs.writeFileSync(path.join(outDir, 'markdown-article.md'), md);
  const has = (s, label = s) => check(md.includes(s), `contains ${label}`, JSON.stringify(md.slice(0, 200)));
  check(/\.md$/.test(res.filename), `filename ${res.filename}`);
  has('# MD-TITLE-MARK Markdown fixture');
  has('## Section');
  has('- item one');
  has('  - nested');
  has('  - nested **two**', 'nested bold item');
  has('1. first');
  has('2. second');
  has('**bold**');
  has('_italic_');
  has('~~gone~~');
  has('`inline()`');
  has(`[relative link](${base}/docs/page.html?x=1)`, 'absolute link');
  has('  \nSecond line', 'hard line break');
  has(`![A picture](${base}/img/pic.png)`, 'absolute image');
  has(
    "```js\nfunction hello() {\n  return 'world';\n}\n\n\nconsole.log(hello());\n```",
    'fenced js block with blank lines kept',
  );
  has('| a | b |');
  has('| --- | --- |');
  has('| 1 | x \\| y |', 'escaped pipe in a cell');
  has('[cell link](https://example.com/cell)');
  has('> Quoted text');
  has('**Term**  \nDefinition text', 'definition list');
  has('---');
  has('Special \\* chars \\_ here \\[ok\\]', 'escaped special characters');
  has(`Source: <${base}/markdown.html>`);
  check(!md.includes('HIDDEN-MARK') && !md.includes('SCRIPT-MARK'), 'hidden elements and scripts skipped');
  check(!md.includes('NAV-MARK') && !md.includes('MD-FOOTER-MARK'), 'article mode leaves out nav and footer');
  check(
    !/\n{3,}/.test(md.replace(/```js[\s\S]*?```/, 'CODE')),
    'at most one blank line between blocks (outside code)',
  );
  const all = await sw.evaluate(
    (id) => globalThis.__websnap.exportMarkdown(id, 'none', { output: 'return' }),
    tabId,
  );
  check(
    all.markdown.includes('NAV-MARK') && all.markdown.includes('MD-FOOTER-MARK'),
    'whole-page mode keeps nav and footer',
  );
  await page.close();
  await setSettings({});
});

await test('markdown: preview overlay offers Markdown only when enabled; download saves a .md file', async () => {
  const { page, tabId } = await openTab('markdown.html');
  await setSettings({ markdownEnabled: false });
  let info = await pickElement(page, tabId, 'table', { widenTo: 'table' });
  check(!info.formats.includes('markdown'), `no Markdown option while disabled (${info.formats})`);
  await closePreviewOverlay(page);
  await setSettings({ markdownEnabled: true });
  info = await pickElement(page, tabId, 'table', { widenTo: 'table' });
  check(
    info.formats.includes('markdown') && info.labels.includes('Markdown'),
    `Markdown option shown when enabled (${info.labels})`,
  );
  await chooseFormat(page, 'markdown');
  await clickPreview(page, '.download');
  const item = await waitForDownload((i) => /\.md$/.test(i.filename));
  const md = fs.readFileSync(item.filename, 'utf8');
  check(md.startsWith('# Markdown Fixture\n'), 'element without an <h1> gets the page title as heading');
  check(
    md.includes('| a | b |') && md.includes('| 2 | [cell link](https://example.com/cell) |'),
    'picked table converted',
  );
  check(!md.includes('MD-TITLE-MARK') && !md.includes('Intro with'), 'only the picked element');
  await page.close();
  await setSettings({});
});

// --- 8. page and article previews -----------------------------------------------------------

await test('preview: Full page card opens the preview overlay', async () => {
  const { page, tabId } = await openTab('article.html');
  const popup = await openPopupFor(tabId, page);
  const downloadsBefore = await downloadCount();
  await popup.click('#act-page');
  await waitForOverlay(page);
  const info = await waitForPreview(page);
  check(info.title === 'Export this page' && info.ready, `overlay "Export this page" ready (${info.title})`);
  await page.screenshot({ path: path.join(outDir, 'preview-page.png') });
  check(/^\d+×\d+ px$/.test(info.caption), `caption is a size with no selector (${info.caption})`);
  check(
    await waitFor(() => popup.evaluate(() => window.__closed >= 1), { label: 'popup.close()' }),
    'the popup closes itself',
  );
  check((await downloadCount()) === downloadsBefore, 'nothing downloaded before Download is clicked');
  const t0 = new Date().toISOString();
  await clickPreview(page, '.download');
  const item = await waitForDownload((i) => /\.pdf$/.test(i.filename) && i.startTime >= t0);
  check(!!item, 'Download saves the PDF');
  await waitFor(async () => !(await overlayOpen(page)), { label: 'overlay to close' });
  await popup.close();
  await page.close();
});

await test('preview: Article card opens the preview overlay', async () => {
  const { page, tabId } = await openTab('article.html');
  const popup = await openPopupFor(tabId, page);
  await popup.click('#act-article');
  await waitForOverlay(page);
  const info = await waitForPreview(page);
  const story = await rectOf(page, '#story');
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  check(info.title === 'Export this article', `title (${info.title})`);
  await page.screenshot({ path: path.join(outDir, 'preview-article.png') });
  check(/^\d+×\d+ px$/.test(info.caption), `caption is a size with no selector (${info.caption})`);
  check(
    info.canvases.every((c) => c.cssWidth === Math.round(story.width) + 'px') &&
      Math.round(story.width) < pageWidth - 200,
    `canvases have the article's CSS width ${Math.round(story.width)}px, narrower than the page (${info.canvases.map((c) => c.cssWidth)})`,
  );
  const t0 = new Date().toISOString();
  await clickPreview(page, '.download');
  const item = await waitForDownload((i) => /\.pdf$/.test(i.filename) && i.startTime >= t0);
  const text = pdfText(fs.readFileSync(item.filename), 'article-preview.pdf');
  check(text.includes('ARTICLE-MARK') && !text.includes('SIDEBAR-MARK'), 'the article PDF has no sidebar');
  await popup.close();
  await page.close();
});

await test('preview: Article preview shows an error when no article is found', async () => {
  const { page, tabId } = await openTab('picker.html');
  const popup = await openPopupFor(tabId, page);
  const before = await snapshot(page);
  await popup.click('#act-article');
  const status = await waitFor(
    async () => {
      const t = await popup.textContent('#status');
      return /Could not detect an article/.test(t) ? t : null;
    },
    { label: 'the no-article error in the popup' },
  );
  check(/Could not detect an article/.test(status), `popup shows the error (${status})`);
  check((await popup.evaluate(() => window.__closed)) === 0, 'the popup stays open');
  check((await hostCount(page)) === 0, 'no overlay host exists');
  await expectRestored(page, before, 'snapshotDom is unchanged');
  check((await badge(tabId)) === '!', `badge is ! (${await badge(tabId)})`);
  await popup.close();
  await page.close();
});

await test('preview: shortcuts and menu entries open the preview', async () => {
  const { page, tabId } = await openTab('article.html');
  const downloadsBefore = await downloadCount();
  const cases = [
    ['save-pdf', () => command('save-pdf', tabId), 'Export this page'],
    ['save-article', () => command('save-article', tabId), 'Export this article'],
    ['menu page', () => menu('page', tabId), 'Export this page'],
    ['menu article', () => menu('article', tabId), 'Export this article'],
  ];
  for (const [label, run, title] of cases) {
    await run();
    await waitForOverlay(page, label);
    const info = await waitForPreview(page);
    check(info.title === title && info.ready, `${label} opens "${title}" (${info.title})`);
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await overlayOpen(page)), { label: 'overlay to close' });
    await waitFor(async () => !(await workerState(tabId)).busy, { label: 'the tab to be released' });
  }
  check((await downloadCount()) === downloadsBefore, 'no download started');
  await page.close();
  const none = await openTab('picker.html');
  await menu('article', none.tabId);
  await wait(500);
  check((await hostCount(none.page)) === 0, 'menu article on a page without an article opens no overlay');
  check((await badge(none.tabId)) === '!', `and sets the badge to ! (${await badge(none.tabId)})`);
  await none.page.close();
});

await test('preview: the format dropdown changes what Download saves', async () => {
  await setSettings({ imageScale: 2, filenameTemplate: 'dd' });
  const { page, tabId } = await openTab('article.html');
  await command('save-pdf', tabId);
  const info = await waitForPreview(page);
  const height = Number(/×(\d+) px/.exec(info.caption)[1]);
  check(
    info.formats.join() === 'pdf,png,jpeg' && info.checked === 'pdf',
    `options PDF, PNG, JPEG, PDF selected (${info.formats})`,
  );
  await chooseFormat(page, 'png');
  await page.screenshot({ path: path.join(outDir, 'preview-page-png-selected.png') });
  const parts = Math.ceil(height / 1600);
  const t0 = new Date().toISOString();
  await clickPreview(page, '.download');
  const files = await waitForDownloads((i) => /dd-\d+\.png$/.test(i.filename) && i.startTime >= t0, parts);
  const total = files.reduce((n, f) => n + decodePng(fs.readFileSync(f.filename)).height, 0);
  check(
    files.length === parts && Math.abs(total - height * 2) <= parts,
    `PNG: ${parts} files, ${total} px high for a ${height} px page at scale 2`,
  );
  await waitFor(async () => !(await overlayOpen(page)), { label: 'overlay to close' });
  await command('save-pdf', tabId);
  await waitForPreview(page);
  await chooseFormat(page, 'jpeg');
  const t1 = new Date().toISOString();
  await clickPreview(page, '.download');
  const jpgs = await waitForDownloads((i) => /dd-\d+\.jpg$/.test(i.filename) && i.startTime >= t1, parts);
  check(jpgs.length === parts, `JPEG saves ${parts} .jpg files`);
  await waitFor(async () => !(await overlayOpen(page)), { label: 'overlay to close' });
  await command('save-pdf', tabId);
  await waitForPreview(page);
  await chooseFormat(page, 'pdf');
  const t2 = new Date().toISOString();
  await clickPreview(page, '.download');
  const pdf = await waitForDownload((i) => /dd\.pdf$/.test(i.filename) && i.startTime >= t2);
  check(!!pdf, 'PDF saves one PDF');
  await waitFor(async () => !(await overlayOpen(page)), { label: 'overlay to close' });
  await setSettings({ markdownEnabled: true, filenameTemplate: 'dd' });
  await command('save-pdf', tabId);
  const withMd = await waitForPreview(page);
  check(
    withMd.formats.join() === 'pdf,png,jpeg,markdown',
    `Markdown is offered when enabled (${withMd.formats})`,
  );
  await chooseFormat(page, 'markdown');
  const t3 = new Date().toISOString();
  await clickPreview(page, '.download');
  const md = await waitForDownload((i) => /dd\.md$/.test(i.filename) && i.startTime >= t3);
  check(fs.readFileSync(md.filename, 'utf8').includes('ARTICLE-MARK'), 'Markdown saves the page as .md');
  await page.close();
  await setSettings({});
});

await test('preview: the Format label, first focus on Close and the keyboard', async () => {
  const { page, tabId } = await openTab('article.html');
  const focusInfo = () =>
    page.evaluate(() => {
      const sr = document.querySelector('[data-websnap-ui="preview"]').shadowRoot;
      const a = sr.activeElement;
      const sel = sr.querySelector('select.format');
      const lab = sel.labels[0];
      const r = (el) => el.getBoundingClientRect();
      const tb = sr.querySelector('.toolbar');
      return {
        active: a ? a.className : null,
        label: lab ? lab.textContent : null,
        overflow: tb.scrollWidth <= tb.clientWidth,
        inView:
          !!lab &&
          r(lab).left >= 0 &&
          r(lab).right <= innerWidth &&
          r(sel).left >= 0 &&
          r(sel).right <= innerWidth,
      };
    });
  await command('save-pdf', tabId);
  await waitForOverlay(page);
  let f = await focusInfo();
  check(/\bclose\b/.test(f.active), `focus starts on Close while the preview loads (${f.active})`);
  await waitForPreview(page);
  f = await focusInfo();
  check(f.label === 'Format', `the select's label is "Format" (${f.label})`);
  check(/\bclose\b/.test(f.active), `focus is still on Close after the image lands (${f.active})`);
  const visited = [];
  for (let i = 0; i < 4 && !/\bformat\b/.test(f.active || ''); i++) {
    await page.keyboard.press('Tab');
    f = await focusInfo();
    visited.push(f.active);
  }
  check(
    /\bformat\b/.test(f.active) && visited.every(Boolean),
    `Tab from Close reaches the Format dropdown and never leaves the overlay (${visited})`,
  );
  await page.keyboard.press('j');
  check((await previewInfo(page)).checked === 'jpeg', 'type-ahead "j" selects JPEG');
  await page.keyboard.press('Escape');
  check(!(await overlayOpen(page)), 'Esc closes the overlay');
  await waitFor(async () => !(await workerState(tabId)).busy, { label: 'the tab to be released' });
  await setSettings({ language: 'de' });
  await page.setViewportSize({ width: 360, height: 800 });
  await command('save-pdf', tabId);
  await waitForPreview(page);
  f = await focusInfo();
  check(
    f.overflow && f.inView,
    `360 px, German: no toolbar overflow, label and select in view (${JSON.stringify(f)})`,
  );
  check(
    (await previewInfo(page)).title === 'Diese Seite exportieren',
    'the overlay is translated into German',
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1200, height: 800 });
  await setSettings({});
  await page.close();
});

await test('preview: every part is a JPEG data URL', async () => {
  await resetWorkerLog();
  const { page, tabId } = await openTab('article.html');
  await command('save-pdf', tabId);
  await waitForPreview(page);
  const shown = await workerMsgs('ps:show-preview');
  check(
    shown.length === 1 &&
      shown[0].prefixes.length > 1 &&
      shown[0].prefixes.every((p) => p === 'data:image/jpeg;base64,'),
    `ps:show-preview carries ${shown[0] && shown[0].prefixes.length} JPEG parts (${shown[0] && shown[0].prefixes[0]}), ${shown[0] && (shown[0].bytes / 1e6).toFixed(2)} MB`,
  );
  await page.keyboard.press('Escape');
  await page.close();
});

await test('preview: page preview loads lazy images with the overlay up', async () => {
  const { page, tabId } = await openTab('article.html');
  await recordScrolls(page);
  const last = await page.evaluate(() => {
    const r = [...document.querySelectorAll('img.lazy')].pop().getBoundingClientRect();
    return { x: r.left + 150, y: r.top + scrollY + 60 };
  });
  await command('save-pdf', tabId);
  await waitForPreview(page);
  const done = await page.evaluate(() => ({ loaded: window.__lazyLoaded, total: window.__lazyTotal }));
  check(
    done.loaded === done.total && done.total > 0,
    `every lazy image loaded (${done.loaded} of ${done.total})`,
  );
  const px = await canvasPixelAt(page, last.x, last.y);
  check(px && px[2] > 150 && px[0] < 140, `the last lazy image is drawn, not gray (${px})`);
  const { sc } = await scrollLog(page);
  const moving = sc.filter((e) => e.y > 0);
  const lastMoving = sc.lastIndexOf(moving[moving.length - 1]);
  check(
    moving.length >= 3 &&
      moving.every((e) => e.d === 'block') &&
      sc.slice(0, lastMoving + 1).every((e) => e.d !== 'none'),
    `the overlay host is displayed over the whole lazy scroll (${moving.length} scroll events, ${[...new Set(sc.map((e) => e.d))]})`,
  );
  await page.keyboard.press('Escape');
  await page.close();
});

await test('preview: page preview of a scroll-locked page covers the whole document', async () => {
  const { page, tabId } = await openTab('body-fixed.html');
  await command('save-pdf', tabId);
  const info = await waitForPreview(page);
  const height = Number(/×(\d+) px/.exec(info.caption)[1]);
  const sum = info.canvases.reduce((n, c) => n + c.height, 0);
  const measured = (await send(tabId, { type: 'ps:measure' })).height;
  check(height >= 3000 && height > 800 * 2, `the caption height is the document's (${height} px)`);
  check(
    sum === height && info.canvases.length > 1,
    `${info.canvases.length} canvases add up to it (${sum} px)`,
  );
  check(Math.abs(measured - height) < 100 || measured >= 800, `ps:measure agrees it is long (${measured})`);
  await page.keyboard.press('Escape');
  await page.close();
});

await test('preview: page preview of a page wider than the window covers its width', async () => {
  const { page, tabId } = await openTab('big.html');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  await command('save-pdf', tabId);
  const info = await waitForPreview(page);
  const width = Number(/(\d+)×\d+ px/.exec(info.caption)[1]);
  check(scrollWidth > 1250, `big.html overflows the window sideways (${scrollWidth} px)`);
  check(width >= scrollWidth - 1, `the preview is as wide as the document (${width} px)`);
  await page.keyboard.press('Escape');
  await page.close();
});

await test('preview: page and article previews restore the page', async () => {
  const { page, tabId } = await openTab('article.html');
  const before = await snapshot(page);
  for (const [cmd, how] of [
    ['save-pdf', 'Esc'],
    ['save-article', 'Close'],
    ['save-pdf', 'Download'],
  ]) {
    await command(cmd, tabId);
    await waitForPreview(page);
    await expectRestored(page, before, `${cmd}: the page is restored while the preview is open`);
    if (how === 'Esc') await page.keyboard.press('Escape');
    else if (how === 'Close') await clickPreview(page, '.close');
    else {
      await clickPreview(page, '.download');
      await waitForDownload((i) => /\.pdf$/.test(i.filename));
    }
    await waitFor(async () => !(await overlayOpen(page)), { label: 'overlay to close' });
    await expectRestored(page, before, `${cmd} + ${how}: the page is as before`);
    await waitFor(async () => !(await workerState(tabId)).busy, { label: 'the tab to be released' });
  }
  await page.close();
});

await test('preview: refused while an export holds the tab', async () => {
  const { page, tabId } = await openTab('article.html');
  await page.evaluate(
    (h) => document.getElementById('body').insertAdjacentHTML('beforeend', h),
    bigText(1500),
  );
  const popup = await openPopupFor(tabId, page);
  await sw.evaluate((id) => {
    globalThis.__heldExport = globalThis.__websnap
      .generate({ tabId: id, prep: 'article', output: 'return', settings: { loadLazy: true } })
      .then(
        (r) => ({ ok: r.ok }),
        (e) => ({ error: e.message }),
      );
  }, tabId);
  try {
    await waitFor(() => page.evaluate(() => !!document.querySelector('[data-websnap-root]')), {
      interval: 10,
      label: 'prepare() to mark the article root',
    });
    const res = await popupSend(popup, { type: 'ps:open-preview', tabId, kind: 'page' });
    check(
      res.ok === false && res.error === 'Wait for the current export to finish before previewing.',
      `ps:open-preview is refused (${JSON.stringify(res)})`,
    );
    check((await hostCount(page)) === 0, 'no overlay host appears');
    check((await badge(tabId)) === '!', `the badge is ! (${await badge(tabId)})`);
    const done = await sw.evaluate(() => globalThis.__heldExport);
    check(done.ok === true, 'the held export succeeds', JSON.stringify(done));
  } finally {
    await sw.evaluate(() => globalThis.__heldExport);
    await send(tabId, { type: 'ps:reset-page' });
    await popup.close();
    await page.close();
  }
});

await test('preview: a stale preview is ignored', async () => {
  const { page, tabId } = await openTab('article.html');
  await send(tabId, { type: 'ps:ping' });
  await stubSendMessage(tabId);
  const target = { type: 'ps:set-target', kind: 'page', strings: {}, theme: 'light' };
  const lastRequest = async () => {
    const sent = (await readSentMessages(tabId)).filter((m) => m.type === 'ps:preview-element');
    return sent[sent.length - 1];
  };
  const shown = (requestId) => ({
    type: 'ps:show-preview',
    requestId,
    parts: [{ dataUrl: 'data:image/png;base64,' + PIXEL_PNG, width: 10, height: 10 }],
    width: 10,
    height: 10,
    description: '',
    format: 'pdf',
    imageWarning: null,
    markdownEnabled: false,
    strings: {},
    theme: 'light',
  });
  await send(tabId, target);
  const a = await lastRequest();
  check(
    a && a.prep === 'none' && Number.isInteger(a.requestId),
    `the overlay asks for a capture (${JSON.stringify(a)})`,
  );
  await send(tabId, shown(a.requestId + 99));
  await wait(150);
  check((await previewInfo(page)).loading, '(a) a preview with another id leaves the overlay loading');
  await send(tabId, shown(a.requestId));
  check((await waitForPreview(page)).ready, '(a) the recorded id shows the image');
  await page.keyboard.press('Escape');
  await send(tabId, target);
  const b = await lastRequest();
  check(
    b.requestId !== a.requestId,
    `(b) the next overlay gets a new id (${a.requestId} then ${b.requestId})`,
  );
  await send(tabId, shown(a.requestId));
  await wait(150);
  check((await previewInfo(page)).loading, '(b) a preview for the closed overlay leaves the new one loading');
  await page.keyboard.press('Escape');
  await send(tabId, shown(b.requestId));
  await wait(150);
  check(!(await overlayOpen(page)), '(c) a preview after Esc opens no overlay');
  await send(tabId, { type: 'ps:reset-page' });
  await page.close();
});

await test('preview: Select part narrows a page preview to one element', async () => {
  const { page, tabId } = await openTab('article.html');
  await command('save-pdf', tabId);
  const info = await waitForPreview(page);
  check(info.buttons.includes('Select part'), `the button reads "Select part" (${info.buttons})`);
  await clickPreview(page, '.reselect');
  await waitFor(
    () =>
      page.evaluate(
        () =>
          !!document.querySelector('[data-websnap-ui=""]') &&
          !document.querySelector('[data-websnap-ui="preview"]'),
      ),
    { label: 'the picker to replace the overlay' },
  );
  const r = await rectOf(page, '#sidebar');
  await page.mouse.move(r.left + 20, r.top + 20);
  await wait(50);
  await page.mouse.down();
  await page.mouse.up();
  const el = await waitForPreview(page);
  check(
    el.title === 'Export this element' && /aside#sidebar/.test(el.caption),
    `element preview (${el.title}, ${el.caption})`,
  );
  check(el.buttons.includes('Reselect'), 'an element preview keeps "Reselect"');
  const t0 = new Date().toISOString();
  await clickPreview(page, '.download');
  const item = await waitForDownload((i) => /\.pdf$/.test(i.filename) && i.startTime >= t0);
  const text = pdfText(fs.readFileSync(item.filename), 'select-part.pdf');
  check(text.includes('SIDEBAR-MARK') && !text.includes('ARTICLE-MARK'), 'the PDF holds only the sidebar');
  await page.close();
});

await test('preview: a large photo-like element stays under the message limit', async () => {
  const big = await launchExtension({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  try {
    const url = `${big.base}/element.html`;
    const page = await big.context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const tabId = await tabIdForUrl(big.sw, url);
    await page.bringToFront();
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.id = 'photo';
      c.width = 1200;
      c.height = 6000;
      c.style.display = 'block';
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(1200, 6000);
      const d = img.data;
      const noise = new Uint8Array(65536);
      for (let i = 0; i < d.length; i += 4) {
        const px = i >> 2;
        if ((i & 0xffff) === 0) crypto.getRandomValues(noise);
        const n = noise[(i & 0xffff) >> 2] & 31;
        d[i] = ((px % 1200) * 255) / 1200 + n;
        d[i + 1] = ((px / 1200) * 255) / 6000 + n;
        d[i + 2] = 128 + n;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      document.body.append(c);
      c.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    await big.sw.evaluate(() => {
      globalThis.__sizes = [];
      const send = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (tabId, msg, ...rest) => {
        if (msg.type === 'ps:show-preview') globalThis.__sizes.push(JSON.stringify(msg).length);
        return send(tabId, msg, ...rest);
      };
    });
    await big.sw.evaluate((id) => globalThis.__websnap.startPicker(id, 'print'), tabId);
    await page.mouse.move(300, 300);
    await wait(50);
    await page.mouse.down();
    await page.mouse.up();
    const info = await waitFor(
      () =>
        page.evaluate(() => {
          const host = document.querySelector('[data-websnap-ui="preview"]');
          if (!host) return null;
          const cs = [...host.shadowRoot.querySelectorAll('.stage canvas')];
          const err = host.shadowRoot.querySelector('.placeholder.error');
          if (err) return { error: err.textContent };
          return cs.length && cs.every((c) => c.dataset.ready)
            ? { first: { width: cs[0].width, css: parseFloat(cs[0].style.width) }, n: cs.length }
            : null;
        }),
      { timeout: 60000, label: 'the large preview' },
    );
    const sizes = await big.sw.evaluate(() => globalThis.__sizes);
    check(!info.error, `the preview renders (${info.error || info.n + ' parts'})`);
    check(
      info.first && info.first.width === info.first.css * 2,
      `the first canvas is at device scale 2 (${info.first && info.first.width} px for ${info.first && info.first.css} CSS px)`,
    );
    check(
      sizes.length === 1 && sizes[0] < 32e6,
      `the message is ${(sizes[0] / 1e6).toFixed(2)} MB, under Chrome's limit`,
    );
    await page.close();
  } finally {
    await big.close();
  }
});

await test('preview: the overlay is not in the image or the PDF', async () => {
  await setSettings({ filenameTemplate: 'ov', imageScale: 2 });
  const { page, tabId } = await openTab('article.html');
  await page.evaluate(() => (document.body.style.background = 'rgb(200, 40, 40)'));
  const base = await sw.evaluate(
    (id) => globalThis.__websnap.exportElementImage(id, 'png', { prep: 'none', output: 'return' }),
    tabId,
  );
  const baseline = decodePng(Buffer.from(base.parts[0].base64, 'base64'));
  const expected = baseline.pixel(1200, 40);
  await command('save-pdf', tabId);
  await waitForPreview(page);
  const previewPx = await canvasPixelAt(page, 600, 20);
  check(
    previewPx && previewPx.every((v, i) => Math.abs(v - expected[i]) <= 8),
    `the preview pixel at (600, 20) is the page's (${previewPx} vs ${expected})`,
  );
  await chooseFormat(page, 'png');
  const t0 = new Date().toISOString();
  await clickPreview(page, '.download');
  const files = await waitForDownloads((i) => /ov-1\.png$/.test(i.filename) && i.startTime >= t0, 1);
  const png = decodePng(fs.readFileSync(files[0].filename));
  check(
    isColor(png.pixel(1200, 40), expected),
    `the PNG pixel matches an export with no overlay (${png.pixel(1200, 40)})`,
  );
  await waitFor(async () => !(await overlayOpen(page)), { label: 'overlay to close' });
  await command('save-pdf', tabId);
  await waitForPreview(page);
  await chooseFormat(page, 'pdf');
  const t1 = new Date().toISOString();
  await clickPreview(page, '.download');
  const pdf = await waitForDownload((i) => /ov\.pdf$/.test(i.filename) && i.startTime >= t1);
  const text = pdfText(fs.readFileSync(pdf.filename), 'overlay-not-in-pdf.pdf');
  check(!text.includes('Export this page') && !/\bFormat\b/.test(text), 'the PDF has no overlay text');
  await page.close();
  await setSettings({});
});

await test("preview: the remove bar's Preview opens the page preview", async () => {
  const { page, tabId } = await openTab('article.html');
  await startPicker(tabId, 'remove');
  const r = await rectOf(page, '#sidebar');
  await page.mouse.move(r.left + 20, r.top + 20);
  await wait(50);
  await page.mouse.down();
  await page.mouse.up();
  const downloadsBefore = await downloadCount();
  const btn = await page.evaluate(() => {
    const host = document.querySelector('[data-websnap-ui=""]');
    const b = [...host.shadowRoot.querySelectorAll('.bar button')].find((x) =>
      x.classList.contains('primary'),
    );
    const rr = b.getBoundingClientRect();
    return { text: b.textContent, x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 };
  });
  check(btn.text === 'Preview', `the bar's button reads "Preview" (${btn.text})`);
  await page.mouse.move(btn.x, btn.y);
  await page.mouse.click(btn.x, btn.y);
  const info = await waitForPreview(page);
  check(info.title === 'Export this page', `the overlay "Export this page" opens (${info.title})`);
  check((await downloadCount()) === downloadsBefore, 'nothing downloads');
  const t0 = new Date().toISOString();
  await clickPreview(page, '.download');
  const pdf = await waitForDownload((i) => /\.pdf$/.test(i.filename) && i.startTime >= t0);
  const text = pdfText(fs.readFileSync(pdf.filename), 'remove-preview.pdf');
  check(!text.includes('SIDEBAR-MARK') && text.includes('ARTICLE-MARK'), 'the PDF lacks the removed sidebar');
  await send(tabId, { type: 'ps:reset-page' });
  await page.close();
});

await test('preview: Download fails when the previewed article left the page', async () => {
  const { page, tabId } = await openTab('article.html');
  await command('save-article', tabId);
  await waitForPreview(page);
  await page.evaluate(() => {
    const a = document.querySelector('article');
    a.replaceWith(a.cloneNode(true));
  });
  const downloadsBefore = await downloadCount();
  await clickPreview(page, '.download');
  const info = await waitFor(
    async () => {
      const i = await previewInfo(page);
      return i && /gone/.test(i.status) ? i : null;
    },
    { label: 'the element-gone status' },
  );
  check(
    info.status === 'The selected element is gone. Select it again.',
    `the overlay says the element is gone (${info.status})`,
  );
  await wait(300);
  check((await downloadCount()) === downloadsBefore, 'no file is saved');
  await page.keyboard.press('Escape');
  await page.close();
});

await test('preview: an unknown prep is refused', async () => {
  const { page, tabId } = await openTab('article.html');
  await send(tabId, { type: 'ps:ping' });
  const downloadsBefore = await downloadCount();
  const replies = await sw.evaluate(async (tabId) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const out = [];
        for (const type of ['ps:generate-from-content', 'ps:preview-element', 'ps:export-element'])
          out.push(await chrome.runtime.sendMessage({ type, prep: 'bogus', format: 'png' }));
        return out;
      },
    });
    return r.result;
  }, tabId);
  check(
    replies.length === 3 && replies.every((r) => r.ok === false && r.error === 'Unknown export target.'),
    `each message is refused (${JSON.stringify(replies)})`,
  );
  check((await downloadCount()) === downloadsBefore, 'no download starts');
  await page.close();
});

// --- 9. cancelling a capture or a Download ---------------------------------------------------

const hostShown = (page) =>
  page.evaluate(() => {
    const h = document.querySelector('[data-websnap-ui="preview"]');
    return !!h && getComputedStyle(h).display !== 'none';
  });
// Presses Esc in the page and returns performance.now() of the page at that moment.
async function pressEsc(page) {
  await page.evaluate(() =>
    addEventListener('keydown', (e) => e.key === 'Escape' && (window.__escAt = performance.now()), true),
  );
  await page.keyboard.press('Escape');
  return page.evaluate(() => window.__escAt);
}
// Polls until the page matches `before` and the tab is released; returns the ms it took.
async function restoredWithin(page, tabId, before, limit = 1000, { overlay = false } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < limit + 2000) {
    const same = diffSnapshots(before, await snapshot(page)).length === 0;
    if (same && (overlay || !(await overlayOpen(page))) && !(await workerState(tabId)).busy)
      return Date.now() - t0;
    await wait(25);
  }
  return null;
}
const noNewPassScroll = async (page, escAt) => {
  const { sc } = await scrollLog(page);
  const late = sc.filter((e) => e.t > escAt + 100);
  // One step may be in flight when Esc lands; the pass must not run on to the end of the page.
  const before = sc.filter((e) => e.t <= escAt);
  const yAtEsc = before.length ? before[before.length - 1].y : 0;
  const furthest = Math.max(0, ...sc.filter((e) => e.t > escAt).map((e) => e.y));
  return {
    ok: late.length <= 1 && late.every((e) => e.y === 0) && furthest <= yAtEsc + 1500,
    late: late.length,
    total: sc.length,
  };
};

await test('preview: Esc while loading cancels the capture and restores the page', async () => {
  await resetWorkerLog();
  const { page, tabId } = await openTab(LAZY_LONG);
  const before = await snapshot(page);
  await recordScrolls(page);
  const downloadsBefore = await downloadCount();
  // (a) Esc during the scroll of a ~200,000 px page.
  for (const round of ['first', 'second']) {
    await command('save-pdf', tabId);
    await waitFor(async () => (await hostShown(page)) && (await page.evaluate(() => scrollY)) > 0, {
      interval: 20,
      label: `the ${round} pass to scroll under the overlay`,
    });
    const escAt = await pressEsc(page);
    const took = await restoredWithin(page, tabId, before);
    check(took !== null && took <= 1000, `(a) ${round}: the page is restored ${took} ms after Esc`);
    const late = await noNewPassScroll(page, escAt);
    check(
      late.ok,
      `(a) ${round}: no pass scroll later than 100 ms after Esc (${late.late} of ${late.total})`,
    );
    check((await badge(tabId)) !== '!', `(a) ${round}: no error badge`);
  }
  check((await downloadCount()) === downloadsBefore, '(a) no download exists');
  const prepares = await workerMsgs('ps:prepare');
  check(
    prepares.length === 2 && prepares.every((p) => p.aborted === true),
    `(a) both prepares came back aborted (${prepares.length})`,
  );
  await page.close();

  // (b) Esc during the bottom wait for an image that never loads.
  const art = await openTab('article.html');
  await art.page.evaluate(() => {
    const img = document.createElement('img');
    img.src = '/__hang';
    document.body.append(img);
  });
  const artBefore = await snapshot(art.page);
  await recordScrolls(art.page);
  await command('save-pdf', art.tabId);
  await waitFor(
    async () => {
      const { sc } = await scrollLog(art.page);
      const max = await art.page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      return sc.some((e) => e.y >= max - 2) && sc[sc.length - 1].y <= 10;
    },
    { interval: 20, label: 'the pass to reach the bottom and come back' },
  );
  await wait(300);
  await pressEsc(art.page);
  const tookB = await restoredWithin(art.page, art.tabId, artBefore);
  check(tookB !== null && tookB <= 1000, `(b) the bottom wait is cut short: restored ${tookB} ms after Esc`);
  await art.page.close();

  // (c) Esc while ps:prepare is held back: the signal is fired when it arrives.
  const held = await openTab('article.html');
  await resetWorkerLog();
  await recordScrolls(held.page);
  await sw.evaluate(() => (globalThis.__holdPrepareMs = 500));
  await command('save-pdf', held.tabId);
  await waitFor(async () => (await workerMsgs('ps:prepare')).length === 1, {
    interval: 10,
    label: 'ps:prepare to be held',
  });
  await wait(100);
  await held.page.keyboard.press('Escape');
  await waitFor(async () => (await workerMsgs('ps:prepare'))[0].repliedAt, { label: 'the prepare reply' });
  const [prep] = await workerMsgs('ps:prepare');
  const { sc: heldScrolls } = await scrollLog(held.page);
  check(
    prep.aborted === true && prep.repliedAt - prep.sentAt <= 50,
    `(c) the held prepare is answered "aborted" ${prep.repliedAt - prep.sentAt} ms after it is released`,
  );
  check(heldScrolls.length === 0, `(c) the page saw no scroll from that prepare (${heldScrolls.length})`);
  await resetWorkerLog();
  await held.page.close();
});

await test('preview: Esc during the screenshots cancels the capture', async () => {
  await setSettings({ loadLazy: false });
  await resetWorkerLog();
  const { page, tabId } = await openTab(LAZY_LONG);
  const before = await snapshot(page);
  await sw.evaluate(() => {
    globalThis.__cdp.onShot = (n, target) =>
      n === 2
        ? chrome.scripting.executeScript({
            target: { tabId: target.tabId },
            func: () =>
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
          })
        : undefined;
  });
  await command('save-pdf', tabId);
  await waitFor(() => sw.evaluate(() => globalThis.__cdp.shots >= 2), {
    interval: 10,
    label: 'the second screenshot',
  });
  const took = await restoredWithin(page, tabId, before);
  await wait(500);
  const shots = await sw.evaluate(() => globalThis.__cdp.shots);
  check(shots <= 4, `the capture stops within two screenshots of the Esc (${shots} taken)`);
  check(took !== null && took <= 1000, `the page is restored ${took} ms after the Esc`);
  check((await workerMsgs('ps:show-preview')).length === 0, 'no ps:show-preview reaches the page');
  check((await badge(tabId)) !== '!', 'no error badge');
  await resetWorkerLog();
  await setSettings({});
  await page.close();
});

await test('preview: a second request while loading', async () => {
  await resetWorkerLog();
  const { page, tabId } = await openTab(LAZY_LONG);
  const before = await snapshot(page);
  await sw.evaluate((id) => chrome.action.setBadgeText({ tabId: id, text: '' }), tabId);
  await command('save-pdf', tabId);
  await waitFor(async () => (await workerState(tabId)).busy === true, {
    interval: 10,
    label: 'the capture to hold the tab',
  });
  await command('save-pdf', tabId);
  check((await badge(tabId)) !== '!', `a repeat of the same kind sets no badge (${await badge(tabId)})`);
  check(
    (await received('ps:preview-element')).length === 1,
    'exactly one ps:preview-element reaches the worker',
  );
  await command('save-article', tabId);
  check((await badge(tabId)) === '!', 'another kind is refused with the badge');
  const info = await previewInfo(page);
  check(
    info.title === 'Export this page' && info.loading,
    `the page overlay is still loading (${info.title})`,
  );
  await page.keyboard.press('Escape');
  check((await restoredWithin(page, tabId, before)) !== null, 'Esc restores the page');
  await resetWorkerLog();
  await page.close();
});

await test('preview: a new preview is refused while the overlay downloads', async () => {
  const { page, tabId } = await openTab('element.html');
  await pickElement(page, tabId, '#red');
  await sw.evaluate(async (id) => {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => {
        chrome.runtime.sendMessage = () => new Promise(() => {});
      },
    });
    await chrome.action.setBadgeText({ tabId: id, text: '' });
  }, tabId);
  await clickPreview(page, '.download');
  await waitFor(async () => (await previewInfo(page)).downloadDisabled, {
    label: 'the overlay to turn busy',
  });
  await command('save-pdf', tabId);
  check((await badge(tabId)) === '!', 'the new preview is refused with the badge');
  const info = await previewInfo(page);
  check(
    info.title === 'Export this element' && info.downloadDisabled && /Saving/.test(info.status),
    `the element overlay is still there and busy (${info.title}, ${info.status})`,
  );
  await page.keyboard.press('Escape');
  await page.close();
});

await test('preview: Esc or Close during a Download cancels it and saves nothing', async () => {
  const P6 = 'lazy/loader.html?root=section&top=500&n=100&gap=2000&loader=lodash&t=50';
  const savedFiles = () => sw.evaluate(async () => (await chrome.downloads.search({})).length);
  const cancelDuringPass = async (label, how) => {
    const { page, tabId } = await openTab(P6);
    const before = await snapshot(page);
    await pickElement(page, tabId, 'section', { scroll: false, timeout: 90000 });
    await chooseFormat(page, 'pdf');
    await recordScrolls(page);
    const files = await savedFiles();
    await clickPreview(page, '.download');
    await waitFor(async () => (await page.evaluate(() => scrollY)) > 0, {
      interval: 20,
      label: 'the Download pass to scroll',
    });
    let escAt;
    if (how === 'Close') {
      escAt = await page.evaluate(() => performance.now());
      await clickPreview(page, '.close');
    } else escAt = await pressEsc(page);
    const took = await restoredWithin(page, tabId, before);
    const late = await noNewPassScroll(page, escAt);
    check(took !== null && took <= 1000, `${label}: restored ${took} ms after ${how}`);
    check(late.ok, `${label}: no pass scroll later than 100 ms after ${how} (${late.late})`);
    check((await badge(tabId)) !== '!', `${label}: no error badge`);
    await wait(5000);
    check((await savedFiles()) === files, `${label}: no file is saved`);
    return { page, tabId };
  };
  let r = await cancelDuringPass('PDF, Esc', 'Esc');
  await r.page.close();
  r = await cancelDuringPass('PDF, Close', 'Close');
  await r.page.close();

  await resetWorkerLog();
  const png = await openTab('lazy/loader.html?root=section&top=500&n=100&gap=2000&loader=lodash&t=50');
  const pngBefore = await snapshot(png.page);
  await pickElement(png.page, png.tabId, 'section', { scroll: false, timeout: 90000 });
  await chooseFormat(png.page, 'png');
  const files = await savedFiles();
  await sw.evaluate(() => {
    globalThis.__cdp.shots = 0;
    globalThis.__cdp.onShot = (n, target) =>
      n === 3
        ? chrome.scripting.executeScript({
            target: { tabId: target.tabId },
            func: () =>
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
          })
        : undefined;
  });
  await clickPreview(png.page, '.download');
  // A part of this PNG is a 2400 x 3200 screenshot of about 0.6 to 1.3 s, and the one in flight finishes.
  const tookPng = await restoredWithin(png.page, png.tabId, pngBefore, 3000);
  await wait(3000);
  check(tookPng !== null && tookPng <= 3000, `PNG, Esc: restored ${tookPng} ms after Esc`);
  check((await savedFiles()) === files, 'PNG, Esc: no file is saved');
  await resetWorkerLog();
  await png.page.close();

  const held = await openTab('article.html');
  await pickElement(held.page, held.tabId, '#story');
  const heldBefore = await snapshot(held.page);
  await chooseFormat(held.page, 'pdf');
  const filesHeld = await savedFiles();
  await sw.evaluate(() => (globalThis.__cdp.hold = { method: 'Page.printToPDF', ms: 2500, hit: false }));
  await clickPreview(held.page, '.download');
  await waitFor(() => sw.evaluate(() => globalThis.__cdp.hold.hit), {
    interval: 10,
    label: 'printToPDF to start',
  });
  await held.page.keyboard.press('Escape');
  const tookHeld = await restoredWithin(held.page, held.tabId, heldBefore, 4000);
  await wait(1500);
  check(tookHeld !== null, 'PDF held at printToPDF: the page is restored after Esc');
  check((await savedFiles()) === filesHeld, 'PDF held at printToPDF: no file is saved after the hold');
  await resetWorkerLog();
  await command('save-pdf', held.tabId);
  check((await waitForPreview(held.page)).ready, 'a new preview opens and loads afterwards');
  await held.page.keyboard.press('Escape');
  await held.page.close();
});

await test('preview: the overlay is busy during any pass', async () => {
  const { page, tabId } = await openTab('adv/lazyroot.html?n=60');
  await pickElement(page, tabId, '#root', { timeout: 90000 });
  await page.evaluate(() => (window.__scrolls = 0));
  await sw.evaluate((id) => {
    globalThis.__held = globalThis.__websnap.generate({ tabId: id, prep: 'none', output: 'return' }).then(
      (r) => ({ ok: r.ok, base64: r.base64 }),
      (e) => ({ error: e.message }),
    );
  }, tabId);
  await waitFor(() => page.evaluate(() => window.__scrolls > 3), {
    interval: 20,
    label: 'the export pass to scroll',
  });
  const states = () =>
    page.evaluate(() => {
      const sr = document.querySelector('[data-websnap-ui="preview"]').shadowRoot;
      const dis = (s) => [...sr.querySelectorAll(s)].map((b) => b.disabled);
      return {
        download: dis('.download'),
        reselect: dis('.reselect'),
        copy: dis('.copy'),
        format: dis('select.format'),
        parts: dis('.part-copy, .part-download'),
        close: dis('.close'),
      };
    });
  const mid = await states();
  await page.screenshot({ path: path.join(outDir, 'preview-busy-during-pass.png') });
  check(
    mid.download[0] &&
      mid.reselect[0] &&
      mid.copy[0] &&
      mid.format[0] &&
      mid.parts.length > 0 &&
      mid.parts.every(Boolean) &&
      !mid.close[0],
    `(a) every control but Close is disabled during the pass (${JSON.stringify(mid)})`,
  );
  await page.evaluate(() =>
    document.querySelector('[data-websnap-ui="preview"]').shadowRoot.querySelector('.reselect').click(),
  );
  await wait(200);
  const st = await send(tabId, { type: 'ps:state' });
  check(
    !st.pickerActive && st.previewOpen,
    `(a) a dispatched click on Reselect starts no picker (${JSON.stringify(st)})`,
  );
  const done = await sw.evaluate(() => globalThis.__held);
  const pdf = lazyPdf(done, 'busy-pass.pdf');
  check(
    pdf.images === 60 && pdf.text.includes('ROOT-START-MARK'),
    `(a) the export holds ${pdf.images} of 60 images and the root`,
  );
  const after = await states();
  check(
    !after.download[0] &&
      !after.reselect[0] &&
      !after.copy[0] &&
      !after.format[0] &&
      after.parts.every((d) => !d),
    '(a) every control is enabled again after the export',
  );
  await page.keyboard.press('Escape');
  await page.close();

  const pv = await openTab('adv/lazyroot.html?n=60');
  const pvBefore = await snapshot(pv.page);
  await command('save-pdf', pv.tabId);
  await waitFor(() => pv.page.evaluate(() => window.__scrolls > 3), {
    interval: 20,
    label: 'the preview pass to scroll',
  });
  const sel = await pv.page.evaluate(() => {
    const b = document.querySelector('[data-websnap-ui="preview"]').shadowRoot.querySelector('.reselect');
    const wasDisabled = b.disabled;
    b.click();
    return wasDisabled;
  });
  await wait(200);
  const st2 = await send(pv.tabId, { type: 'ps:state' });
  check(
    sel && !st2.pickerActive,
    `(b) Select part is disabled during the preview's own pass and starts no picker`,
  );
  await pv.page.keyboard.press('Escape');
  await restoredWithin(pv.page, pv.tabId, pvBefore);
  await pv.page.close();
});

await test('preview: a dismissed debugging bar stops the export with a plain message', async () => {
  const CLOSED = "The export stopped because Chrome's debugging bar was closed. Try again.";
  const raw = (t) => /tab with (given )?id/.test(t) || /\d{6,}/.test(t);
  await sw.evaluate(() => {
    globalThis.__dismiss = async (tabId, withEvent) => {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      if (withEvent) globalThis.__websnap.debuggerDetached({ tabId }, 'canceled_by_user');
    };
  });
  const dismiss = (tabId, withEvent) =>
    sw.evaluate(({ tabId, withEvent }) => globalThis.__dismiss(tabId, withEvent), { tabId, withEvent });
  const arm = (withEvent, nth) =>
    sw.evaluate(
      ({ withEvent, nth }) => {
        globalThis.__cdp.onShot = (n, target) =>
          n === nth ? globalThis.__dismiss(target.tabId, withEvent) : undefined;
      },
      { withEvent, nth },
    );
  const errorText = async (page) => {
    const i = await waitFor(
      async () => {
        const x = await previewInfo(page);
        return x && (x.error || /bar/.test(x.status)) ? x : null;
      },
      { label: 'the plain message' },
    );
    return i.error || i.status;
  };
  // (a) during the lazy pass.
  await resetWorkerLog();
  const a = await openTab(LAZY_LONG);
  const aBefore = await snapshot(a.page);
  await sw.evaluate((id) => chrome.action.setBadgeText({ tabId: id, text: '' }), a.tabId);
  const filesA = await downloadCount();
  await command('save-pdf', a.tabId);
  await waitFor(async () => (await hostShown(a.page)) && (await a.page.evaluate(() => scrollY)) > 0, {
    interval: 20,
    label: 'the pass to scroll',
  });
  await dismiss(a.tabId, true);
  const tookA = await restoredWithin(a.page, a.tabId, aBefore, 1000, { overlay: true });
  const textA = await errorText(a.page);
  check(textA === CLOSED && !raw(textA), `(a) the overlay says the bar was closed (${textA})`);
  check((await badge(a.tabId)) === '!', '(a) the badge is !');
  check((await downloadCount()) === filesA, '(a) no file is saved');
  check(tookA !== null && tookA <= 1000, `(a) the page is restored ${tookA} ms after the bar was dismissed`);
  await setSettings({ loadLazy: false });
  await a.page.keyboard.press('Escape');
  await command('save-pdf', a.tabId);
  check((await waitForPreview(a.page, 120000)).ready, '(a) the next preview on the tab loads');
  await a.page.keyboard.press('Escape');
  await a.page.close();

  // (b) during the screenshots, with the event and with the detach alone.
  for (const withEvent of [true, false]) {
    await resetWorkerLog();
    const b = await openTab(LAZY_LONG);
    const bBefore = await snapshot(b.page);
    await sw.evaluate((id) => chrome.action.setBadgeText({ tabId: id, text: '' }), b.tabId);
    await arm(withEvent, 2);
    await command('save-pdf', b.tabId);
    const t = await errorText(b.page);
    const took = await restoredWithin(b.page, b.tabId, bBefore, 1000, { overlay: true });
    check(
      t === CLOSED && !raw(t),
      `(b${withEvent ? '' : ', detach only'}) the overlay says the bar was closed (${t})`,
    );
    check(
      (await badge(b.tabId)) === '!' && took !== null,
      `(b${withEvent ? '' : ', detach only'}) badge ! and the page is restored`,
    );
    await b.page.close();
  }

  // (c) at the start of printToPDF, with the event and with the detach alone.
  for (const withEvent of [true, false]) {
    await resetWorkerLog();
    const c = await openTab('article.html');
    await pickElement(c.page, c.tabId, '#story');
    const cBefore = await snapshot(c.page);
    await chooseFormat(c.page, 'pdf');
    await sw.evaluate((id) => chrome.action.setBadgeText({ tabId: id, text: '' }), c.tabId);
    const filesC = await downloadCount();
    await sw.evaluate(() => (globalThis.__cdp.hold = { method: 'Page.printToPDF', ms: 1500, hit: false }));
    await clickPreview(c.page, '.download');
    await waitFor(() => sw.evaluate(() => globalThis.__cdp.hold.hit), {
      interval: 10,
      label: 'printToPDF to start',
    });
    await dismiss(c.tabId, withEvent);
    const t = await errorText(c.page);
    const took = await restoredWithin(c.page, c.tabId, cBefore, 4000, { overlay: true });
    check(
      t === CLOSED && !raw(t),
      `(c${withEvent ? '' : ', detach only'}) the status says the bar was closed (${t})`,
    );
    check(
      (await badge(c.tabId)) === '!' && took !== null && (await downloadCount()) === filesC,
      `(c${withEvent ? '' : ', detach only'}) badge !, page restored, no file`,
    );
    await c.page.close();
  }
  await resetWorkerLog();
  await setSettings({});
});

// --- 10. one lazy pass for the preview and its Download --------------------------------------

const imageCount = (file, min = 100) =>
  execFileSync('pdfimages', ['-list', file], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .slice(2)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => Number(c[3]) >= min).length;
const lastPrepare = async () => {
  const all = await workerMsgs('ps:prepare');
  return all[all.length - 1];
};
const scrolls = (page) => page.evaluate(() => window.__scrolls);
async function settledViewport(page, quietMs = 700) {
  let last = await page.evaluate(() => innerHeight);
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    await wait(50);
    const now = await page.evaluate(() => innerHeight);
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
}
// A page preview of adv/lazyroot.html with the image landed, the worker log cleared and the scroll
// counter reset, ready for a Download.
async function previewReady(n = 20) {
  const { page, tabId } = await openTab(`adv/lazyroot.html?n=${n}`);
  await command('save-pdf', tabId);
  await waitForPreview(page, 60000);
  await resetWorkerLog();
  await page.evaluate(() => (window.__scrolls = 0));
  return { page, tabId };
}
async function downloadPdfFrom(page) {
  const t0 = new Date().toISOString();
  await chooseFormat(page, 'pdf');
  await clickPreview(page, '.download');
  return waitForDownload((i) => /\.pdf$/.test(i.filename) && i.startTime >= t0, 60000);
}

await test("preview: Download reuses the preview's lazy pass on an unchanged page", async () => {
  const { page } = await previewReady(20);
  const item = await downloadPdfFrom(page);
  const prep = await lastPrepare();
  const n = await scrolls(page);
  check(n <= 2, `the page saw ${n} scroll events during the Download`);
  check(prep.reused === true, `the Download's ps:prepare reply says reused (${prep.reused})`);
  check(prep.repliedAt - prep.sentAt < 600, `the prepare took ${prep.repliedAt - prep.sentAt} ms`);
  check(
    imageCount(item.filename, 250) === 20,
    `the PDF holds ${imageCount(item.filename, 250)} of 20 images`,
  );
  await page.close();

  const el = await openTab('adv/lazyroot.html?n=20');
  await pickElement(el.page, el.tabId, '#root', { timeout: 90000 });
  await resetWorkerLog();
  const gen = () =>
    sw.evaluate(
      (id) =>
        globalThis.__websnap
          .generate({ tabId: id, prep: 'element', output: 'return' })
          .then((r) => ({ ok: r.ok, base64: r.base64 })),
      el.tabId,
    );
  await gen();
  await wait(200);
  await el.page.evaluate(() => (window.__scrolls = 0));
  const second = await gen();
  const preps = await workerMsgs('ps:prepare');
  check(
    preps.length === 2 && preps[0].reused === undefined && preps[1].reused === true,
    `element: the second export reuses the first one's pass (${preps.map((p) => p.reused)})`,
  );
  check(
    (await scrolls(el.page)) <= 2,
    `element: ${await scrolls(el.page)} scroll events in the second export`,
  );
  check(lazyPdf(second, 'reuse-element.pdf').images === 20, 'element: 20 of 20 images');
  await el.page.close();
});

await test('preview: Download runs a new pass when the page grew', async () => {
  const { page } = await previewReady(20);
  await page.evaluate(() => window.appendBlocks(30));
  const item = await downloadPdfFrom(page);
  const prep = await lastPrepare();
  check(prep.reused === undefined, `the Download's prepare is a full pass (${prep.reused})`);
  check((await scrolls(page)) > 2, `the page scrolls again (${await scrolls(page)} scroll events)`);
  check(
    imageCount(item.filename, 250) === 50,
    `the PDF holds ${imageCount(item.filename, 250)} of 50 images`,
  );
  await page.close();
});

await test('preview: Download runs a new pass when the page grew without a DOM change', async () => {
  const { page } = await previewReady(20);
  await page.evaluate(() => document.styleSheets[0].insertRule('.block { height: 2200px !important; }'));
  const item = await downloadPdfFrom(page);
  const prep = await lastPrepare();
  check(
    prep.reused === undefined,
    `a taller page, no mutation record: the Download runs a full pass (${prep.reused})`,
  );
  check((await scrolls(page)) > 2, `the page scrolls again (${await scrolls(page)} scroll events)`);
  check(
    imageCount(item.filename, 250) === 20,
    `the PDF holds ${imageCount(item.filename, 250)} of 20 images`,
  );
  await page.close();
});

await test('preview: Download runs a new pass when the page re-rendered its images', async () => {
  const { page } = await previewReady(20);
  await page.evaluate(() => {
    for (const img of document.querySelectorAll('img.lz')) {
      const c = img.cloneNode(false);
      c.removeAttribute('src');
      img.replaceWith(c);
    }
  });
  const item = await downloadPdfFrom(page);
  const prep = await lastPrepare();
  check(prep.reused === undefined, `the Download's prepare is a full pass (${prep.reused})`);
  check(
    imageCount(item.filename, 250) === 20,
    `the PDF holds ${imageCount(item.filename, 250)} of 20 images`,
  );
  await page.close();
});

await test('preview: two exports in a row with the overlay open', async () => {
  const gen = (tabId) =>
    sw.evaluate(
      (id) =>
        globalThis.__websnap
          .generate({ tabId: id, prep: 'none', output: 'return' })
          .then((r) => ({ ok: r.ok, base64: r.base64 })),
      tabId,
    );
  const mutations = {
    unchanged: [() => {}, 20, 20],
    grew: [() => window.appendBlocks(30), 50, 50],
    rerendered: [
      () => {
        for (const img of document.querySelectorAll('img.lz')) {
          const c = img.cloneNode(false);
          c.removeAttribute('src');
          img.replaceWith(c);
        }
      },
      20,
      20,
    ],
  };
  for (const [name, [mutate, , expected]] of Object.entries(mutations)) {
    const { page, tabId } = await openTab('adv/lazyroot.html?n=20');
    await pickElement(page, tabId, '#root', { timeout: 90000 });
    await resetWorkerLog();
    await gen(tabId);
    await page.evaluate(mutate);
    await wait(200);
    await page.evaluate(() => (window.__scrolls = 0));
    const second = await gen(tabId);
    const prep = await lastPrepare();
    const images = lazyPdf(second, `two-${name}.pdf`).images;
    check(images === expected, `(a) ${name}: the second PDF holds ${images} of ${expected} images`);
    if (name === 'unchanged')
      check(
        prep.reused === true && (await scrolls(page)) <= 2 && prep.repliedAt - prep.sentAt < 600,
        `(a) unchanged reuses (${prep.reused}, ${await scrolls(page)} scroll events, ${prep.repliedAt - prep.sentAt} ms)`,
      );
    else check(prep.reused === undefined, `(a) ${name} runs a new pass`);
    await page.close();
  }
  const { page } = await previewReady(20);
  await chooseFormat(page, 'png');
  for (const part of [1, 2]) {
    const t0 = new Date().toISOString();
    await clickPreview(page, `.part[data-part="${part}"] .part-download`);
    await waitForDownload((i) => /\.png$/.test(i.filename) && i.startTime >= t0, 60000);
    await waitFor(async () => !(await previewInfo(page)).downloadDisabled, {
      label: 'the overlay to be idle again',
    });
    const prep = await lastPrepare();
    check(
      (await overlayOpen(page)) && prep.reused === true,
      `(b) part ${part}: the overlay stays open and the pass is reused (${prep.reused})`,
    );
  }
  check((await scrolls(page)) <= 2, `(b) ${await scrolls(page)} scroll events across both part Downloads`);
  await page.close();
});

await test('preview: Download reuses an incomplete pass and shows its warning', async () => {
  const { page, tabId } = await openTab('lazy/loader.html?n=0&feed=1');
  await command('save-pdf', tabId);
  await waitForPreview(page, 90000);
  await resetWorkerLog();
  const t0 = new Date().toISOString();
  await chooseFormat(page, 'pdf');
  await clickPreview(page, '.download');
  await waitForDownload((i) => /\.pdf$/.test(i.filename) && i.startTime >= t0, 60000);
  const prep = await lastPrepare();
  check(prep.reused === true, `the Download reuses the preview's pass (${prep.reused})`);
  check(
    prep.lazy && prep.lazy.complete === false,
    `the reused pass is still incomplete (${JSON.stringify(prep.lazy)})`,
  );
  const info = await waitFor(
    async () => {
      const i = await previewInfo(page);
      return i && i.warning ? i : null;
    },
    { label: 'the lazy-load warning' },
  );
  check(info.warning === lazyWarning(), `the overlay shows the warning the pass earned (${info.warning})`);
  await page.keyboard.press('Escape');
  await page.close();
});

await test("preview: resize and orientation galleries keep main's image count", async () => {
  const direct = (tabId) =>
    sw.evaluate(
      (id) =>
        globalThis.__websnap
          .generate({ tabId: id, output: 'return', settings: { loadLazy: true } })
          .then((r) => ({ base64: r.base64 })),
      tabId,
    );
  const countOf = (r, name) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(r.base64, 'base64'));
    return imageCount(file);
  };
  for (const [id, url] of [
    ['reset0-io', 'lazy/adv.html?loader=io&mode=reset&rd=0'],
    ['orient-mq-io', 'lazy/adv.html?loader=io&mode=mq'],
  ]) {
    // main's export of the URL on a fresh tab, and after a preview was shown and closed. A headless
    // run leaves Chrome's debugging bar up after a preview's capture, and its slide-in at the next
    // attach resizes the page under any export, so the second count (give or take the few frames
    // the resizes race) is the fair floor for a Download. A record reused wrongly gives 1 here.
    const fresh = await openTab(url);
    const expected = countOf(await direct(fresh.tabId), `gallery-${id}-fresh.pdf`);
    await fresh.page.close();
    const after = await openTab(url);
    await command('save-pdf', after.tabId);
    await waitForPreview(after.page, 90000);
    await after.page.keyboard.press('Escape');
    await waitFor(async () => !(await workerState(after.tabId)).busy, { label: 'the tab to be released' });
    await settledViewport(after.page);
    const floor = countOf(await direct(after.tabId), `gallery-${id}-after-preview.pdf`);
    await after.page.close();
    const { page, tabId } = await openTab(url);
    await command('save-pdf', tabId);
    await waitForPreview(page, 90000);
    await settledViewport(page);
    const t0 = new Date().toISOString();
    await chooseFormat(page, 'pdf');
    await clickPreview(page, '.download');
    const item = await waitForDownload((i) => /\.pdf$/.test(i.filename) && i.startTime >= t0, 60000);
    const got = imageCount(item.filename);
    check(
      got >= floor - 5 && got > 1,
      `${id}: preview + Download saves ${got} images; main exports ${expected} on a fresh tab and ${floor} after a preview`,
    );
    await page.close();
  }
});

// --- 11. the page going away mid-export ------------------------------------------------------

await test('preview: a page that goes away mid-export gets a plain message', async () => {
  const messages = JSON.parse(
    fs.readFileSync(path.join(root, 'extension/_locales/en/messages.json'), 'utf8'),
  );
  const de = JSON.parse(fs.readFileSync(path.join(root, 'extension/_locales/de/messages.json'), 'utf8'));
  const raw = /message channel|Receiving end|No tab with|port closed/i;
  for (const [language, expected] of [
    ['en', messages.preview_errorInterrupted.message],
    ['de', de.preview_errorInterrupted.message],
  ]) {
    await setSettings({ language });
    for (const how of ['navigates', 'closes']) {
      const { page, tabId } = await openTab(LAZY_LONG);
      const popup = await openPopupFor(tabId, page);
      const pending = popupSend(popup, { type: 'ps:export-element', tabId, format: 'png', prep: 'none' });
      await waitFor(() => page.evaluate(() => scrollY > 0), { interval: 20, label: 'the pass to scroll' });
      if (how === 'navigates') await page.goto(`${base}/body-fixed.html`);
      else await page.close();
      const res = await pending;
      check(
        res.ok === false && res.error === expected && !raw.test(res.error),
        `${language}, tab ${how}: "${res.error}"`,
      );
      await popup.close();
      if (how === 'navigates') await page.close();
    }
  }
  await setSettings({});

  const { page, tabId } = await openTab('article.html');
  await send(tabId, { type: 'ps:ping' });
  const lost =
    'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';
  await sw.evaluate(
    async ({ tabId, lost }) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (lost) => {
          chrome.runtime.sendMessage = () => Promise.reject(new Error(lost));
        },
        args: [lost],
      });
    },
    { tabId, lost },
  );
  const strings = { preview_errorInterrupted: 'INTERRUPTED', preview_errorGeneric: 'GENERIC' };
  await send(tabId, { type: 'ps:set-target', kind: 'page', strings, theme: 'light' });
  const info = await waitForPreview(page);
  check(
    info.error === 'INTERRUPTED',
    `the overlay shows the plain message for a lost capture (${info.error})`,
  );
  await page.keyboard.press('Escape');
  await stubSendMessage(tabId);
  await send(tabId, { type: 'ps:set-target', kind: 'page', strings, theme: 'light' });
  const [req] = (await readSentMessages(tabId)).filter((m) => m.type === 'ps:preview-element').slice(-1);
  await send(tabId, {
    type: 'ps:show-preview',
    requestId: req.requestId,
    parts: [{ dataUrl: 'data:image/png;base64,' + PIXEL_PNG, width: 10, height: 10 }],
    width: 10,
    height: 10,
    format: 'pdf',
    strings,
    theme: 'light',
  });
  await waitForPreview(page);
  await sw.evaluate(
    async ({ tabId, lost }) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (lost) => {
          chrome.runtime.sendMessage = () => Promise.reject(new Error(lost));
        },
        args: [lost],
      });
    },
    { tabId, lost },
  );
  await clickPreview(page, '.download');
  const after = await waitFor(
    async () => {
      const i = await previewInfo(page);
      return i && /INTERRUPTED/.test(i.status) ? i : null;
    },
    { label: 'the status line' },
  );
  check(
    after.status === 'INTERRUPTED',
    `the status line shows the plain message for a lost Download (${after.status})`,
  );
  await page.keyboard.press('Escape');
  await send(tabId, { type: 'ps:reset-page' });
  await page.close();
});

const failures = summary();
await close();
process.exit(failures ? 1 : 0);
