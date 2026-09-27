// Screenshots of the in-page element preview modal (light + dark) for the README and the Web
// Store listing. Loads the extension into Chromium, opens test/fixtures/element.html, starts the
// "select element" picker through the service worker's test hook, clicks #red and captures the
// viewport once the modal shows the rendered preview.
// Output: docs/images/preview-modal-light.png, docs/images/preview-modal-dark.png (1280×800).
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
const TARGET = '#red';
fs.mkdirSync(outDir, { recursive: true });

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
const testExtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesnap-shot-ext-'));
fs.cpSync(extDir, testExtDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(testExtDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = [`${base}/*`];
fs.writeFileSync(path.join(testExtDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesnap-shot-'));
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

  for (const theme of ['light', 'dark']) {
    // The background passes settings.theme to the modal; also emulate the OS scheme to match.
    await sw.evaluate((t) => chrome.storage.sync.set({ settings: { theme: t } }), theme);
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
      TARGET,
    );
    const started = await sw.evaluate((id) => globalThis.__pagesnap.startPicker(id, 'print'), tabId);
    if (!started || !started.ok) throw new Error('picker did not start: ' + JSON.stringify(started));

    const r = await page.evaluate((s) => {
      const b = document.querySelector(s).getBoundingClientRect();
      return { x: b.left + 40, y: b.top + 40 };
    }, TARGET);
    await page.mouse.move(r.x, r.y);
    await page.waitForTimeout(50);
    await page.mouse.down();
    await page.mouse.up();

    // Wait for the captured preview to be drawn into the modal's canvas.
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      await page.waitForTimeout(100);
      ready = await page.evaluate(() => {
        const host = document.querySelector('[data-pagesnap-ui="preview"]');
        const canvas = host && host.shadowRoot.querySelector('.stage canvas');
        return !!(canvas && canvas.dataset.ready);
      });
    }
    if (!ready) throw new Error(`${theme}: preview modal did not show a captured preview`);
    await page.mouse.move(0, 0); // no hover state on the buttons
    await page.waitForTimeout(300);

    const file = path.join(outDir, `preview-modal-${theme}.png`);
    await page.screenshot({ path: file }); // viewport only: the modal is position: fixed
    console.log(`  ✓ ${path.relative(root, file)}`);
    if (errors.length) {
      failed = true;
      console.log(`  ✗ ${theme}: page errors: ${errors.join(' | ')}`);
    }
    await page.close();
  }
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
