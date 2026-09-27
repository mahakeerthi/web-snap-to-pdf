// Content-script hardening tests: drives extension/src/content.js directly (executeScript +
// tabs.sendMessage from the service worker) against fixture pages and asserts DOM state after
// ps:prepare and after ps:restore, the article element chosen, and picker behaviour.
// Run with: npm run test:content   (or: node test/content.e2e.mjs)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// EXT_DIR lets you run the suite against another build (e.g. an older content.js) for comparison.
const extDir = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.join(root, 'extension');
const fixturesDir = path.join(root, 'test/fixtures');
const outDir = path.join(root, 'test/out');
fs.mkdirSync(outDir, { recursive: true });
const headless = process.env.HEADED ? false : true;
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
const context = await chromium.launchPersistentContext(userDataDir, {
  headless,
  channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${testExtDir}`, `--load-extension=${testExtDir}`],
  viewport: { width: 1200, height: 800 },
});
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
// chrome.runtime.sendMessage there to capture the picker's ps:generate-from-content request.
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
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__psSent || null });
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
  check(diffs.length === 0, label, diffs.slice(0, 6).join('; ') + (diffs.length > 6 ? ` (+${diffs.length - 6} more)` : ''));
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
    return { left: r.left, top: r.top, width: r.width, height: r.height, display: getComputedStyle(hl).display, barTop: b.top, barText: bar.textContent };
  });
}
async function rectOf(page, selector) {
  return page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, selector);
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const sameRect = (a, b) => a && b && near(a.left, b.left) && near(a.top, b.top) && near(a.width, b.width) && near(a.height, b.height);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function pageState(tabId) {
  return send(tabId, { type: 'ps:state' });
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
    innerClipped: document.getElementById('inner').scrollHeight > document.getElementById('inner').clientHeight + 4,
    loading: [...document.querySelectorAll('img')].map((i) => i.getAttribute('loading')),
    lazy2: document.getElementById('lazy2').getAttribute('src'),
  }));
  check(during.fixed === 'none', 'small fixed bar hidden during prepare');
  check(during.sticky === 'static', 'sticky element made static');
  check(during.innerOverflow === 'visible' && !during.innerClipped, 'inner scroll pane expanded');
  check(during.loading.every((l) => l === 'eager'), `lazy images switched to eager (${during.loading})`);
  check(!!during.lazy2, 'data-src image got a src');

  await send(tabId, { type: 'ps:restore' });
  const y = await page.evaluate(() => window.scrollY);
  check(y === 900, `window scroll position restored immediately, even with scroll-behavior:smooth (${y})`);
  const inner = await page.evaluate(() => document.getElementById('inner').scrollTop);
  check(inner === 150, `inner pane scrollTop restored (${inner})`);
  const imgs = await page.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.getAttribute('loading')));
  check(imgs.every((l) => l === 'lazy'), `loading="lazy" restored (${imgs})`);
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
  check(s.clippers.length === 0, 'no ancestor clips the last message (app shell released)', `clipped by ${s.clippers.join(', ')}`);
  check(s.docHeight >= s.lastBottom - 2, `document is tall enough for all messages (${s.docHeight} >= ${Math.round(s.lastBottom)})`);
  check(!s.preClipped, 'code block shows every line');
  check(s.spill <= 1, `long code lines do not spill past the page width (spill ${s.spill}px)`);
  check(s.preOverflowX !== 'visible', `code block keeps its own horizontal overflow handling (${s.preOverflowX})`);
  check(s.clamp === orig.clamp && s.clampOverflow === 'hidden', `line-clamped teaser left alone (${orig.clamp} -> ${s.clamp}px)`);
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
  check(st.docHeight > st.vh * 3, `document height covers all content (${st.docHeight}px, viewport ${st.vh}px)`);
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

async function articleCase(file, label, { mustInclude = [], mustExclude = [], expect = '[data-expect="article"]' } = {}) {
  const { page, tabId } = await openTab(file);
  const before = await snapshot(page);
  const res = await send(tabId, { ...PREP_ALL, prep: 'article' });
  check(res.ok, `${label}: article detected`, res.error || '');
  const info = await page.evaluate((expectSel) => {
    const chosen = document.querySelector('[data-pagesnap-root]');
    const expected = document.querySelector(expectSel);
    const describe = (el) => (el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : '') : 'null');
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
  check(best < 1500, `prepare (hideFixed + expandScroll, no lazy scrolling) under 1.5 s: ${times.map((t) => Math.round(t)).join(' / ')} ms`);
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
  check(hl && hl.display === 'block' && sameRect(hl, t), 'highlight matches the hovered element on a scrolled page', JSON.stringify({ hl, t }));
  check(hl && near(hl.barTop, 12), `toolbar pinned to the viewport (top ${hl && hl.barTop})`);
  await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'instant' }));
  await wait(150);
  const t2 = await rectOf(page, '#target');
  hl = await pickerRect(page);
  check(sameRect(hl, t2), 'highlight follows the element after the page scrolls', JSON.stringify({ hl, t2 }));
  check(hl && near(hl.barTop, 12), 'toolbar stays pinned after scrolling');
  await send(tabId, { type: 'ps:stop-picker' });
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
  check(context.pages().length === pages0 && page.url() === url0, `middle click did not open a tab (${pages0} -> ${context.pages().length} pages)`);
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
  await send(tabId, { type: 'ps:start-picker', mode: 'remove' });
  const r = await rectOf(page, '#top');
  await page.mouse.move(r.left + 30, r.top + 10);
  await wait(50);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
  await wait(150);
  const hl = await pickerRect(page);
  const bodyRect = await rectOf(page, 'body');
  check(hl && hl.height < bodyRect.height - 10, `highlight stops below <body> (${hl && Math.round(hl.height)}px vs body ${Math.round(bodyRect.height)}px)`);
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
    const b = document.querySelector('[data-pagesnap-ui]').shadowRoot.querySelector('.bar span').getBoundingClientRect();
    return { x: b.left + 5, y: b.top + b.height / 2 };
  });
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.click(bar.x, bar.y);
  await wait(100);
  const after = await pageState(tabId);
  check(after.removed === before && after.pickerActive, `click on the toolbar text removed nothing (${before} -> ${after.removed})`);
  const done = await page.evaluate(() => {
    const b = [...document.querySelector('[data-pagesnap-ui]').shadowRoot.querySelectorAll('.bar button')].find((x) => x.textContent === 'Done');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(done.x, done.y);
  await page.mouse.click(done.x, done.y);
  await wait(100);
  const afterDone = await pageState(tabId);
  const hostGone = await page.evaluate(() => !document.querySelector('[data-pagesnap-ui]'));
  check(!afterDone.pickerActive && hostGone && afterDone.removed === before, 'toolbar "Done" button still works (stops the picker, keeps removals)');
  await send(tabId, { type: 'ps:reset-page' });
  const restored = await page.evaluate(() => getComputedStyle(document.getElementById('top')).display);
  check(restored !== 'none', 'reset restores removed elements');
  await page.close();
});

await test('picker: works on pages that enforce Trusted Types', async () => {
  const { page, tabId } = await openTab('picker-tt.html');
  const res = await send(tabId, { type: 'ps:start-picker', mode: 'remove' });
  const hl = await pickerRect(page);
  check(res.ok && hl && /Remove elements/.test(hl.barText), 'toolbar rendered', JSON.stringify({ res, bar: hl && hl.barText }));
  await send(tabId, { type: 'ps:stop-picker' });
  const res2 = await send(tabId, { type: 'ps:start-picker', mode: 'print' });
  const hl2 = await pickerRect(page);
  check(res2.ok && hl2 && /Select element/.test(hl2.barText), 'select-mode toolbar rendered', JSON.stringify({ res2, bar: hl2 && hl2.barText }));
  await send(tabId, { type: 'ps:stop-picker' });
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
    other: getComputedStyle(document.getElementById('card').shadowRoot.getElementById('shadow-other')).display,
  }));
  check(st.inner === 'none' && st.host !== 'none' && st.other !== 'none', 'only the shadow element was removed, not the whole component', JSON.stringify(st) + ' hl=' + JSON.stringify(tag));
  await send(tabId, { type: 'ps:reset-page' });
  await page.close();
});

await test('shadow DOM: "select element" isolation crosses the shadow boundary', async () => {
  const { page, tabId } = await openTab('picker.html');
  const before = await snapshot(page);
  await send(tabId, { type: 'ps:start-picker', mode: 'print' });
  // Capture the ps:generate-from-content request instead of starting a real generation.
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
  check(Array.isArray(sent) && sent.some((m) => m.type === 'ps:generate-from-content' && m.prep === 'element'), 'click requested an element PDF', JSON.stringify(sent));
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
  check(st.outside === 'none' && st.target === 'none', `light-DOM content outside the component hidden (${st.outside}, ${st.target})`);
  check(st.other === 'none', `sibling inside the shadow root hidden (${st.other})`);
  check(st.inner !== 'none' && st.host !== 'none' && st.text.includes('SHADOW-MARK'), 'picked shadow content (and its host) still visible');
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
  check(st.chrome === 'none' && st.outside === 'none', `component chrome and outside content hidden (${st.chrome}, ${st.outside})`);
  check(st.slotted > 0, 'slotted content still rendered');
  await send(tabId, { type: 'ps:restore' });
  await send(tabId, { type: 'ps:reset-page' });
  await expectRestored(page, before);
  await page.close();
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failed.length) console.log('Failed:\n  - ' + failed.join('\n  - '));
await context.close();
server.close();
fs.rmSync(testExtDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
