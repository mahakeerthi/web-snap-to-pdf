// Content-script hardening tests: drives extension/src/content.js directly (executeScript +
// tabs.sendMessage from the service worker) against fixture pages and asserts DOM state after
// ps:prepare and after ps:restore, the article element chosen, picker behaviour, the element
// preview modal (PNG / JPEG / PDF / Markdown export) and the Markdown converter.
// Run with: npm run test:content   (or: node test/content.e2e.mjs)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// EXT_DIR lets you run the suite against another build (e.g. an older content.js) for comparison.
const extDir = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.join(root, 'extension');
const fixturesDir = path.join(root, 'test/fixtures');
const outDir = path.join(root, 'test/out');
fs.mkdirSync(outDir, { recursive: true });
const headless = !process.env.HEADED;
const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;

// --- tiny static server for fixtures -------------------------------------------------
const server = http.createServer((req, res) => {
  const file = path.join(fixturesDir, path.normalize(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!file.startsWith(fixturesDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><title>not found</title>not found');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// --- browser with extension (same setup as test/e2e.mjs) -------------------------------
const testExtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesnap-ext-'));
fs.cpSync(extDir, testExtDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(testExtDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = [`${base}/*`];
fs.writeFileSync(path.join(testExtDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesnap-'));
// Downloads go to a fresh temp dir via Chrome's own profile prefs (never ~/Downloads).
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesnap-dl-'));
fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
fs.writeFileSync(
  path.join(userDataDir, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
  }),
);
const context = await chromium.launchPersistentContext(userDataDir, {
  headless,
  channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${testExtDir}`, `--load-extension=${testExtDir}`],
  viewport: { width: 1200, height: 800 },
});
// Hand downloads back to Chrome's own delegate so chrome.downloads keeps the extension's filename
// (Playwright would save them as GUIDs). Keep the CDP session open for the whole run.
const browserCdp = await context.newCDPSession(context.pages()[0] || (await context.newPage()));
await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker');
await sw.evaluate(() => new Promise((r) => setTimeout(r, 200)));
sw.on('console', (m) => {
  if (m.type() === 'error') console.log('  [sw]', m.text());
});

// --- helpers ----------------------------------------------------------------------------
let failures = 0;
let passes = 0;
const failed = [];
function check(cond, label, extra = '') {
  if (cond) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    failed.push(label);
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
}
async function test(name, fn) {
  if (only && !only.test(name)) return;
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (err) {
    failures++;
    failed.push(name + ' (threw)');
    console.log(`  ✗ threw: ${err && err.stack ? err.stack : err}`);
  }
}
async function openTab(file) {
  const url = `${base}/${file}`;
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e)));
  await page.goto(url, { waitUntil: 'load' });
  const tabId = await sw.evaluate(async (u) => {
    for (let i = 0; i < 40; i++) {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url === u);
      if (t) return t.id;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }, url);
  if (tabId == null) throw new Error('tab not found for ' + url);
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
      if (el.hasAttribute('data-pagesnap-ui')) continue;
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
        marker: el.hasAttribute('data-pagesnap-root'),
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
    const host = document.querySelector('[data-pagesnap-ui]');
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
  return sw.evaluate(({ tabId, mode }) => globalThis.__pagesnap.startPicker(tabId, mode), { tabId, mode });
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
// State of the preview modal, read from its (open) shadow root.
async function previewInfo(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-pagesnap-ui="preview"]');
    if (!host) return null;
    const sr = host.shadowRoot;
    const q = (s) => sr.querySelector(s);
    const canvas = q('.stage canvas');
    const seg = [...sr.querySelectorAll('.seg button')];
    return {
      hostDisplay: getComputedStyle(host).display,
      title: q('h2').textContent,
      dark: q('.overlay').classList.contains('dark'),
      caption: q('.caption').textContent,
      warning: q('.warning').hidden ? '' : q('.warning').textContent,
      status: q('.status').textContent,
      loading: !!q('.placeholder') && !q('.placeholder.error'),
      error: q('.placeholder.error') ? q('.placeholder.error').textContent : '',
      ready: !!(canvas && canvas.dataset.ready),
      canvas: canvas ? { width: canvas.width, height: canvas.height, cssWidth: canvas.style.width } : null,
      formats: seg.map((b) => b.dataset.format),
      labels: seg.map((b) => b.textContent),
      checked: (seg.find((b) => b.getAttribute('aria-checked') === 'true') || {}).dataset?.format || null,
      copyVisible: !q('.copy').hidden,
      downloadDisabled: q('.download').disabled,
      buttons: [...sr.querySelectorAll('footer .btn')].map((b) => b.textContent),
      focused: sr.activeElement ? sr.activeElement.className || sr.activeElement.dataset.format : null,
    };
  });
}
// Pixel of the preview canvas at a fraction of its size.
async function previewPixel(page, fx, fy) {
  return page.evaluate(
    ({ fx, fy }) => {
      const c = document
        .querySelector('[data-pagesnap-ui="preview"]')
        .shadowRoot.querySelector('.stage canvas');
      const d = c
        .getContext('2d')
        .getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { fx, fy },
  );
}
async function clickPreview(page, selector) {
  const r = await page.evaluate((s) => {
    const b = document
      .querySelector('[data-pagesnap-ui="preview"]')
      .shadowRoot.querySelector(s)
      .getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, selector);
  await page.mouse.move(r.x, r.y);
  await page.mouse.click(r.x, r.y);
}
async function waitForPreview(page) {
  return waitFor(
    async () => {
      const info = await previewInfo(page);
      return info && (info.ready || info.error) ? info : null;
    },
    { label: 'preview modal' },
  );
}
// Start the select-element picker, hover `selector` (scrolled into view unless `scroll: false`),
// widen the highlight with ArrowUp until it names `widenTo` (e.g. 'table' when the pointer is over
// a cell) and click: the real user flow up to the preview modal.
async function pickElement(page, tabId, selector, { scroll = true, widenTo = null } = {}) {
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
      () => document.querySelector('[data-pagesnap-ui]').shadowRoot.querySelector('.tag').textContent,
    );
  for (let i = 0; widenTo && i < 8 && !(await tag()).startsWith(widenTo); i++)
    await page.keyboard.press('ArrowUp');
  await page.mouse.down();
  await page.mouse.up();
  return waitForPreview(page);
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
// Stripe i of the striped fixture elements is rgb(i*10, 100, 255-i*10); returns the bad stripes.
function badStripes(png, n) {
  const bad = [];
  const band = png.height / n;
  for (let i = 0; i < n; i++) {
    const c = png.pixel(Math.floor(png.width / 2), Math.floor(i * band + band / 2));
    if (!isColor(c, [i * 10, 100, 255 - i * 10])) bad.push(`${i}:${c.join('/')}`);
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
    (o) => globalThis.__pagesnap.generate(o).catch((e) => ({ error: String(e && e.message) })),
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
    (o) => globalThis.__pagesnap.generate(o).catch((e) => ({ error: String(e && e.message) })),
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
    const chosen = document.querySelector('[data-pagesnap-root]');
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
  const host = await page.evaluate(() => !!document.querySelector('[data-pagesnap-ui]'));
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
      .querySelector('[data-pagesnap-ui]')
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
      ...document.querySelector('[data-pagesnap-ui]').shadowRoot.querySelectorAll('.bar button'),
    ].find((x) => x.textContent === 'Done');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(done.x, done.y);
  await page.mouse.click(done.x, done.y);
  await wait(100);
  const afterDone = await pageState(tabId);
  const hostGone = await page.evaluate(() => !document.querySelector('[data-pagesnap-ui]'));
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
  // The preview modal is built without HTML strings too.
  const h1 = await rectOf(page, 'h1');
  await page.mouse.move(h1.left + 10, h1.top + 10);
  await wait(50);
  await page.mouse.click(h1.left + 10, h1.top + 10);
  const info = await waitForPreview(page);
  check(
    info.ready && info.formats.length === 3,
    'preview modal renders under Trusted Types',
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
      picked: sr.getElementById('inner').hasAttribute('data-pagesnap-root'),
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
      picked: document.getElementById('slotted').hasAttribute('data-pagesnap-root'),
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

await test('preview: picker click opens the modal with a preview of just that element; Esc closes and restores', async () => {
  await setSettings({ imageScale: 2, theme: 'dark' });
  const { page, tabId } = await openTab('element.html');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.evaluate(() => window.scrollTo({ top: 4800, behavior: 'instant' }));
  const before = await snapshot(page);
  const info = await pickElement(page, tabId, '#red', { scroll: false });
  check(info.ready, 'modal shows the captured preview', JSON.stringify(info));
  check(
    info.title === 'Export this element' || /\S/.test(info.title),
    `modal title from background strings (${info.title})`,
  );
  check(
    /div#red · 400×300 px/.test(info.caption),
    `caption names the element and its size (${info.caption})`,
  );
  check(
    info.canvas &&
      info.canvas.width === 400 &&
      info.canvas.height === 300 &&
      info.canvas.cssWidth === '400px',
    `preview is the element at screen resolution (${JSON.stringify(info.canvas)})`,
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
  check(info.dark, 'theme "dark" from settings applied');
  check(info.buttons.join('|') === 'Reselect|Copy image|Download', `buttons (${info.buttons.join('|')})`);
  await clickPreview(page, '.seg [data-format="png"]');
  let now = await previewInfo(page);
  check(now.checked === 'png' && now.copyVisible, 'choosing PNG selects it and shows "Copy image"');
  await page.keyboard.press('ArrowRight');
  now = await previewInfo(page);
  check(now.checked === 'jpeg' && !now.copyVisible, `arrow keys move through the formats (${now.checked})`);
  // The page is already back to normal while the modal is open.
  const st = await pageState(tabId);
  check(st.previewOpen && !st.pickerActive, 'picker stopped, preview open');
  await expectRestored(
    page,
    before,
    'page fully restored after the preview capture (styles, scroll position)',
  );
  const header = await page.evaluate(() => getComputedStyle(document.querySelector('header.fixed')).display);
  check(header !== 'none', 'fixed header visible again');
  await page.keyboard.press('Escape');
  await wait(100);
  const after = await pageState(tabId);
  const host = await page.evaluate(() => !!document.querySelector('[data-pagesnap-ui]'));
  check(!after.previewOpen && !host, 'Esc closes the modal');
  await expectRestored(page, before, 'page unchanged after closing the modal');
  check(errors.length === 0, 'no page errors', errors.join(' | '));
  await page.close();
  await setSettings({});
});

await test('preview: Download PNG saves the element at settings.imageScale; JPEG export; format remembered', async () => {
  await setSettings({ imageScale: 2, filenameTemplate: '{title} {time}' });
  const { page, tabId } = await openTab('element.html');
  await pickElement(page, tabId, '#red');
  await clickPreview(page, '.seg [data-format="png"]');
  await clickPreview(page, '.download');
  const item = await waitForDownload((i) => /Element Fixture.*\.png$/.test(i.filename));
  check(
    path.dirname(item.filename) === fs.realpathSync(downloadDir) ||
      path.dirname(item.filename) === downloadDir,
    `PNG downloaded (${path.basename(item.filename)})`,
  );
  const png = decodePng(fs.readFileSync(item.filename));
  check(
    png.width === 800 && png.height === 600,
    `PNG is element size × imageScale 2 (${png.width}×${png.height})`,
  );
  check(isColor(png.pixel(400, 300), RED) && isColor(png.pixel(5, 595), RED), 'PNG shows only the element');
  const closed = await waitFor(async () => !(await previewInfo(page)), { label: 'modal to close' });
  check(closed, 'modal closes after a successful download');

  // JPEG through the same background export.
  const res = await sw.evaluate((id) => globalThis.__pagesnap.exportElementImage(id, 'jpeg'), tabId);
  const jpg = await waitForDownload((i) => /\.jpg$/.test(i.filename));
  const head = fs.readFileSync(jpg.filename).subarray(0, 3);
  check(
    res.ok && res.width === 800 && res.height === 600,
    `JPEG export reports 800×600 (${res.width}×${res.height})`,
  );
  check(
    head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    `JPEG file starts with FF D8 (${path.basename(jpg.filename)})`,
  );

  // The last format chosen in the modal is the default next time.
  const again = await pickElement(page, tabId, '#red');
  check(again.checked === 'png', `last format remembered (${again.checked})`);
  await send(tabId, { type: 'ps:cancel-preview' });
  check(!(await previewInfo(page)), 'ps:cancel-preview closes the modal');
  await page.close();
  await setSettings({});
});

await test('preview: Download PDF saves a PDF with only the element (modal not printed)', async () => {
  const { page, tabId } = await openTab('element.html');
  await page.evaluate(() => window.scrollTo({ top: 4700, behavior: 'instant' }));
  const before = await snapshot(page);
  await pickElement(page, tabId, '#red', { scroll: false });
  await clickPreview(page, '.seg [data-format="pdf"]');
  await clickPreview(page, '.download');
  const item = await waitForDownload((i) => /Element Fixture.*\.pdf$/.test(i.filename), 60000);
  const text = execFileSync('pdftotext', ['-layout', item.filename, '-'], { encoding: 'utf8' });
  check(text.includes('RED-MARK'), 'PDF contains the element text');
  check(
    !text.includes('BEFORE-MARK') && !text.includes('AFTER-MARK') && !text.includes('ELEMENT-FIXED-HEADER'),
    'PDF contains nothing else',
  );
  check(!/Export this element|Download|Reselect/.test(text), 'preview modal not printed');
  await waitFor(async () => !(await previewInfo(page)), { label: 'modal to close' });
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
  check(st.pickerActive && !st.previewOpen, 'modal closed, picker active again');
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
  check(!(await previewInfo(page)), 'reset-page closes the modal');
  await page.close();
});

await test('capture: tall element (3× viewport) is captured in full', async () => {
  const { page, tabId } = await openTab('element.html');
  const info = await pickElement(page, tabId, '#tall');
  check(/div#tall\.stripes · 500×2400 px/.test(info.caption), `caption (${info.caption})`);
  const vh = await page.evaluate(() => innerHeight);
  check(2400 >= vh * 3, `element is at least 3× the viewport height (2400 vs ${vh})`);
  await send(tabId, { type: 'ps:cancel-preview' });
  for (const imageScale of [1, 2]) {
    await setSettings({ imageScale });
    const res = await sw.evaluate(
      (id) => globalThis.__pagesnap.exportElementImage(id, 'png', { output: 'return' }),
      tabId,
    );
    const png = decodePng(Buffer.from(res.base64, 'base64'));
    check(
      png.width === 500 * imageScale && png.height === 2400 * imageScale,
      `scale ${imageScale}: PNG ${png.width}×${png.height} = element × scale`,
    );
    const bad = badStripes(png, 24);
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

await test('capture: huge element is capped at 16384 px with a warning', async () => {
  await setSettings({ imageScale: 2 });
  const { page, tabId } = await openTab('element.html');
  const info = await pickElement(page, tabId, '#huge');
  check(info.ready && !info.warning, 'preview shown, no warning while PDF is selected');
  await clickPreview(page, '.seg [data-format="png"]');
  const withPng = await previewInfo(page);
  check(
    /16,384|16384/.test(withPng.warning) && /0\.81/.test(withPng.warning),
    `caption warns about the reduced image scale (${withPng.warning})`,
  );
  check(
    info.canvas.height <= 16384,
    `preview itself within the limit (${info.canvas.width}×${info.canvas.height})`,
  );
  await send(tabId, { type: 'ps:cancel-preview' });
  const res = await sw.evaluate(
    (id) => globalThis.__pagesnap.exportElementImage(id, 'png', { output: 'return' }),
    tabId,
  );
  const png = decodePng(Buffer.from(res.base64, 'base64'));
  check(
    png.height <= 16384 && png.height >= 16000,
    `PNG height capped (${png.width}×${png.height}, scale ${res.scale})`,
  );
  check(
    Math.abs(png.width - 300 * res.scale) <= 1 && Math.abs(png.height - 20000 * res.scale) <= 1,
    'PNG keeps the aspect ratio at the reduced scale',
  );
  const bad = badStripes(png, 20);
  check(
    bad.length === 0,
    'every band rendered (no wrap-around past the texture limit)',
    bad.slice(0, 5).join(', '),
  );
  check(/16,384|16384/.test(res.warning || ''), `export returns a warning (${res.warning})`);
  // Through the modal: a download that comes back with a warning keeps the modal open to show it.
  await pickElement(page, tabId, '#huge');
  await clickPreview(page, '.seg [data-format="png"]');
  await clickPreview(page, '.download');
  const item = await waitForDownload(
    (i) =>
      /Element Fixture.*\.png$/.test(i.filename) && i.startTime > new Date(Date.now() - 20000).toISOString(),
  );
  check(
    decodePng(fs.readFileSync(item.filename)).height <= 16384,
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
    `modal stays visible with the warning after saving (${kept.status})`,
  );
  await send(tabId, { type: 'ps:cancel-preview' });
  await page.close();
  await setSettings({});
});

// --- 8. Markdown export (experimental) ------------------------------------------------------

await test('markdown: gated by settings.markdownEnabled; article conversion', async () => {
  const { page, tabId } = await openTab('markdown.html');
  await setSettings({ markdownEnabled: false });
  const denied = await sw.evaluate(
    (id) =>
      globalThis.__pagesnap
        .exportMarkdown(id, 'article', { output: 'return' })
        .catch((e) => ({ error: e.message })),
    tabId,
  );
  check(/experimental feature/i.test(denied.error || ''), `rejected while disabled (${denied.error})`);
  const viaMsg = await sw.evaluate(
    (id) => globalThis.__pagesnap.exportMarkdown(id, 'none').catch((e) => ({ error: e.message })),
    tabId,
  );
  check(/experimental feature/i.test(viaMsg.error || ''), 'page export rejected too');

  await setSettings({ markdownEnabled: true });
  const res = await sw.evaluate(
    (id) => globalThis.__pagesnap.exportMarkdown(id, 'article', { output: 'return' }),
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
    (id) => globalThis.__pagesnap.exportMarkdown(id, 'none', { output: 'return' }),
    tabId,
  );
  check(
    all.markdown.includes('NAV-MARK') && all.markdown.includes('MD-FOOTER-MARK'),
    'whole-page mode keeps nav and footer',
  );
  await page.close();
  await setSettings({});
});

await test('markdown: preview modal offers Markdown only when enabled; download saves a .md file', async () => {
  const { page, tabId } = await openTab('markdown.html');
  await setSettings({ markdownEnabled: false });
  let info = await pickElement(page, tabId, 'table', { widenTo: 'table' });
  check(!info.formats.includes('markdown'), `no Markdown option while disabled (${info.formats})`);
  await send(tabId, { type: 'ps:cancel-preview' });
  await setSettings({ markdownEnabled: true });
  info = await pickElement(page, tabId, 'table', { widenTo: 'table' });
  check(
    info.formats.includes('markdown') && info.labels.includes('Markdown'),
    `Markdown option shown when enabled (${info.labels})`,
  );
  await clickPreview(page, '.seg [data-format="markdown"]');
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

console.log(`\n${passes} passed, ${failures} failed`);
if (failed.length) console.log('Failed:\n  - ' + failed.join('\n  - '));
await context.close();
server.close();
fs.rmSync(testExtDir, { recursive: true, force: true });
fs.rmSync(downloadDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
