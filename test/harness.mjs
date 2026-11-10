// Shared setup for everything that drives the unpacked extension in Chromium: test/e2e.mjs,
// test/content.e2e.mjs, scripts/screenshot-preview.mjs, scripts/verify-popup.mjs and
// formal/page-restore/replay-finding.mjs.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(root, 'test/fixtures');

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function serveFixtures() {
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
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function launchExtension({
  extDir = path.join(root, 'extension'),
  viewport,
  headless = !process.env.HEADED,
} = {}) {
  const { server, base } = await serveFixtures();
  const testExtDir = tempDir('websnap-ext-');
  const userDataDir = tempDir('websnap-');
  // Downloads go to a fresh temp dir via Chrome's own profile prefs (never ~/Downloads).
  const downloadDir = tempDir('websnap-dl-');
  let context;

  async function close() {
    await context?.close();
    server.close();
    for (const dir of [testExtDir, userDataDir, downloadDir]) {
      // Chromium can hold the profile for a moment after closing.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  try {
    // The shipped extension relies on activeTab (granted by a real user click), which automation
    // cannot trigger. Load a copy whose manifest has host permission for the fixture server only.
    fs.cpSync(extDir, testExtDir, { recursive: true });
    const manifestPath = path.join(testExtDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.host_permissions = [`${base}/*`];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'Default', 'Preferences'),
      JSON.stringify({
        download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
      }),
    );

    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      channel: 'chromium',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${testExtDir}`, `--load-extension=${testExtDir}`],
      ...(viewport && { viewport }),
    });
    // Playwright intercepts downloads (Browser.setDownloadBehavior 'allowAndName'), saving every file
    // as <playwright-artifacts>/<GUID> and discarding the filename the extension asked for. Hand
    // downloads back to Chrome's own download delegate so chrome.downloads applies the extension's
    // filename, as in production. The CDP session stays open until close().
    const browserCdp = await context.newCDPSession(context.pages()[0] || (await context.newPage()));
    await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'default' });

    const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    await sw.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    const extensionId = new URL(sw.url()).host;
    return { context, sw, extensionId, base, downloadDir, close };
  } catch (err) {
    await close();
    throw err;
  }
}

// The chrome.tabs id of the tab showing `url` (tabs.query can lag behind page.goto).
export async function tabIdForUrl(sw, url) {
  const tabId = await sw.evaluate(async (u) => {
    for (let i = 0; i < 40; i++) {
      const t = (await chrome.tabs.query({})).find((x) => x.url === u);
      if (t) return t.id;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }, url);
  if (tabId == null) throw new Error('tab not found for ' + url);
  return tabId;
}

// The most recent completed download matching `pred`. Fails fast when a recent download was
// interrupted, and on timeout lists every download for diagnosis.
export async function waitForDownload(sw, pred, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = await sw.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 5 }));
    const hit = items.find((i) => i.state === 'complete' && pred(i));
    if (hit) return hit;
    const failed = items.find((i) => i.state === 'interrupted');
    if (failed) throw new Error('download interrupted: ' + failed.error);
    await new Promise((r) => setTimeout(r, 250));
  }
  const all = await sw.evaluate(() => chrome.downloads.search({}));
  const summary = all.map((i) => ({
    id: i.id,
    state: i.state,
    error: i.error,
    filename: i.filename,
    bytesReceived: i.bytesReceived,
    totalBytes: i.totalBytes,
    url: String(i.url).slice(0, 60),
  }));
  throw new Error('download did not complete; downloads.search: ' + JSON.stringify(summary));
}

export function createReporter() {
  const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
  let passes = 0;
  const failed = [];

  function check(cond, label, extra = '') {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
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
      failed.push(name + ' (threw)');
      console.log(`  ✗ threw: ${err && err.stack ? err.stack : err}`);
    }
  }

  function summary() {
    console.log(`\n${passes} passed, ${failed.length} failed`);
    if (failed.length) console.log('Failed:\n  - ' + failed.join('\n  - '));
    return failed.length;
  }

  return { check, test, summary };
}
