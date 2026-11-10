// Screenshots of the in-page element preview overlay for the README and the Web Store listing.
// Loads the extension into Chromium, opens test/fixtures/element.html, starts the "select element"
// picker through the service worker's test hook, clicks the element and captures the viewport once
// the overlay shows the rendered preview.
// Output (1280×800, docs/images/):
//   preview-overlay-light.png, preview-overlay-dark.png  #red (400×300), PNG selected
//   preview-overlay-split-light.png                        #split (400×3700) in 3 parts, scrolled to
//                                                          the "Part 2 of 3" header
// Run with: node scripts/screenshot-preview.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const fixturesDir = path.join(root, 'test/fixtures');
const outDir = path.join(root, 'docs/images');
const VIEWPORT = { width: 1280, height: 800 }; // Chrome Web Store screenshot size
const FIXTURE = 'element.html';
const SHOTS = [
  { name: 'preview-overlay-light', theme: 'light', target: '#red' },
  { name: 'preview-overlay-dark', theme: 'dark', target: '#red' },
  { name: 'preview-overlay-split-light', theme: 'light', target: '#split', part: 2 },
];
fs.mkdirSync(outDir, { recursive: true });
// Superseded by the overlay shots.
for (const old of ['preview-modal-light.png', 'preview-modal-dark.png']) {
  fs.rmSync(path.join(outDir, old), { force: true });
}

// --- static server for the fixtures (same as test/e2e.mjs) ------------------------------------
const server = http.createServer((req, res) => {
  const file = path.join(fixturesDir, path.normalize(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!file.startsWith(fixturesDir) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// Automation cannot grant activeTab, so use a copy of the extension with host permission for the
// local fixture server only (the shipped manifest is unchanged).
const testExtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'websnap-shot-ext-'));
fs.cpSync(extDir, testExtDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(testExtDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = [`${base}/*`];
fs.writeFileSync(path.join(testExtDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'websnap-shot-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium',
  viewport: VIEWPORT,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${testExtDir}`, `--load-extension=${testExtDir}`],
});

let failed = false;
try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 200)));

  for (const shot of SHOTS) {
    const { theme, target } = shot;
    // The background passes settings.theme to the overlay; also emulate the OS scheme to match.
    await sw.evaluate((t) => chrome.storage.sync.set({ settings: { theme: t } }), theme);
    // Start with PNG selected so the Copy image button (and per-part actions) are visible.
    await sw.evaluate(() => chrome.storage.local.set({ previewFormat: 'png' }));
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: theme });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const url = `${base}/${FIXTURE}`;
    await page.goto(url, { waitUntil: 'load' });

    const tabId = await sw.evaluate(async (u) => {
      for (let i = 0; i < 40; i++) {
        const t = (await chrome.tabs.query({})).find((x) => x.url === u);
        if (t) return t.id;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    }, url);
    if (tabId == null) throw new Error('tab not found for ' + url);

    await page.evaluate(
      (s) => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }),
      target,
    );
    const started = await sw.evaluate((id) => globalThis.__websnap.startPicker(id, 'print'), tabId);
    if (!started || !started.ok) throw new Error('picker did not start: ' + JSON.stringify(started));

    const r = await page.evaluate((s) => {
      const b = document.querySelector(s).getBoundingClientRect();
      return { x: b.left + 40, y: Math.min(Math.max(b.top + 40, 120), b.bottom - 10) }; // below the fixed header
    }, target);
    await page.mouse.move(r.x, r.y);
    await page.waitForTimeout(50);
    await page.mouse.down();
    await page.mouse.up();

    // Wait for every captured part to be drawn into the overlay's canvases.
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      await page.waitForTimeout(100);
      ready = await page.evaluate(() => {
        const host = document.querySelector('[data-websnap-ui="preview"]');
        const canvases = host ? [...host.shadowRoot.querySelectorAll('.stage canvas')] : [];
        return canvases.length > 0 && canvases.every((c) => c.dataset.ready);
      });
    }
    if (!ready) throw new Error(`${shot.name}: the overlay did not show a captured preview`);
    // The capture's debugger session can drop the viewport emulation: put the store size back.
    await page.setViewportSize(VIEWPORT);
    if (shot.part) {
      // Scroll the preview so the end of the previous part and the part's header are in view.
      await page.evaluate((n) => {
        const sr = document.querySelector('[data-websnap-ui="preview"]').shadowRoot;
        const stage = sr.querySelector('.stage');
        const head = sr.querySelector(`.part[data-part="${n}"]`);
        stage.scrollTop += head.getBoundingClientRect().top - stage.getBoundingClientRect().top - 220;
      }, shot.part);
    }
    await page.mouse.move(0, 799); // no hover state on the buttons
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForTimeout(300);

    const file = path.join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file }); // viewport only: the overlay is position: fixed
    console.log(`  ✓ ${path.relative(root, file)}`);
    if (errors.length) {
      failed = true;
      console.log(`  ✗ ${shot.name}: page errors: ${errors.join(' | ')}`);
    }
    await page.close();
  }
  await sw.evaluate(() => chrome.storage.local.remove('previewFormat'));
  await sw.evaluate(() => chrome.storage.sync.clear());
} catch (err) {
  failed = true;
  console.error('  ✗', err && err.stack ? err.stack : err);
} finally {
  await context.close();
  server.close();
  fs.rmSync(testExtDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
