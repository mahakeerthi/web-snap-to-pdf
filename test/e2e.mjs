// End-to-end test: loads the unpacked extension into Chromium and exercises the PDF pipeline.
// Run with: npm test
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchExtension, createReporter, tabIdForUrl, waitForDownload } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test/out');
fs.mkdirSync(outDir, { recursive: true });

const { context, sw, extensionId, base, downloadDir, close } = await launchExtension();
sw.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('  [sw]', m.text());
});

// --- helpers ----------------------------------------------------------------------------
const { check, test, summary } = createReporter();
async function openTab(url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  return { page, tabId: await tabIdForUrl(sw, url) };
}
async function generate(opts) {
  const res = await sw.evaluate((o) => globalThis.__websnap.generate(o), { output: 'return', ...opts });
  if (!res || !res.base64) throw new Error('no pdf returned');
  return Buffer.from(res.base64, 'base64');
}
function savePdf(name, buf) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, buf);
  return file;
}
function pdfInfo(file) {
  const out = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  const pages = Number(/Pages:\s+(\d+)/.exec(out)?.[1] || 0);
  const m = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(out);
  return { pages, width: Number(m?.[1]), height: Number(m?.[2]), raw: out };
}
function pdfText(file) {
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
}

const articleUrl = `${base}/article.html`;

// --- tests ------------------------------------------------------------------------------

await test('paged A4 default: real PDF, hides fixed header, keeps links, loads lazy images', async () => {
  const { page, tabId } = await openTab(articleUrl);
  const before = await page.evaluate(() => window.__lazyLoaded);
  const buf = await generate({ tabId, settings: {} });
  check(buf.subarray(0, 5).toString() === '%PDF-', 'starts with %PDF header');
  const file = savePdf('a4-default.pdf', buf);
  const info = pdfInfo(file);
  check(info.pages >= 2, `multiple pages (${info.pages})`);
  check(
    Math.abs(info.width - 595) < 2 && Math.abs(info.height - 842) < 2,
    `A4 portrait size (${info.width}x${info.height} pt)`,
  );
  const text = pdfText(file);
  check(text.includes('ARTICLE-MARK'), 'article text present');
  check(text.includes('SIDEBAR-MARK'), 'sidebar present in full-page mode');
  check(!text.includes('FIXED-HEADER-MARK'), 'fixed header hidden');
  check(
    text.includes('PRINT-ONLY-MARK') && !text.includes('SCREEN-ONLY-MARK'),
    'print media styles used by default',
  );
  check(buf.includes('https://example.com/link-target'), 'link annotation kept');
  check(buf.includes('/Outlines') || buf.includes('/Outline'), 'document outline generated');
  const after = await page.evaluate(() => ({ loaded: window.__lazyLoaded, total: window.__lazyTotal }));
  check(after.loaded === after.total, `lazy images loaded (${before} -> ${after.loaded}/${after.total})`);
  // page restored
  const restored = await page.evaluate(() => ({
    header: getComputedStyle(document.querySelector('header.fixed')).display,
    pos: getComputedStyle(document.querySelector('header.fixed')).position,
    scrollY: window.scrollY,
  }));
  check(restored.header !== 'none' && restored.pos === 'fixed', 'fixed header restored after generation');
  await page.close();
});

await test('landscape Letter + custom margins + header/footer', async () => {
  const { page, tabId } = await openTab(articleUrl);
  const buf = await generate({
    tabId,
    settings: {
      format: 'Letter',
      orientation: 'landscape',
      marginPreset: 'custom',
      margins: { top: 25.4, right: 12.7, bottom: 25.4, left: 12.7 },
      headerFooter: true,
      loadLazy: false,
    },
  });
  const file = savePdf('letter-landscape-hf.pdf', buf);
  const info = pdfInfo(file);
  check(
    Math.abs(info.width - 792) < 2 && Math.abs(info.height - 612) < 2,
    `Letter landscape size (${info.width}x${info.height} pt)`,
  );
  const text = pdfText(file);
  check(text.includes('Fixture Article: The Long Read'), 'header shows document title');
  check(/1\s*\/\s*\d+/.test(text), 'footer shows page numbers');
  check(text.includes('article.html'), 'footer shows URL');
  await page.close();
});

await test('single-page layout produces exactly one tall page', async () => {
  const { page, tabId } = await openTab(articleUrl);
  const buf = await generate({ tabId, settings: { layout: 'single', loadLazy: false } });
  const file = savePdf('single-page.pdf', buf);
  const info = pdfInfo(file);
  check(info.pages === 1, `one page (${info.pages})`);
  check(info.height > 842 * 3, `page is tall (${info.height} pt)`);
  check(Math.abs(info.width - 595) < 2, `width still A4 (${info.width} pt)`);
  const text = pdfText(file);
  check(text.includes('FOOTER-MARK'), 'content reaches the footer (nothing cut off)');
  await page.close();
});

await test('screen view uses screen media styles', async () => {
  const { page, tabId } = await openTab(articleUrl);
  const buf = await generate({ tabId, settings: { mediaView: 'screen', loadLazy: false } });
  const text = pdfText(savePdf('screen-view.pdf', buf));
  check(
    text.includes('SCREEN-ONLY-MARK') && !text.includes('PRINT-ONLY-MARK'),
    'screen-only paragraph printed',
  );
  await page.close();
});

await test('page ranges and layout width (scale) are honoured', async () => {
  const { page, tabId } = await openTab(articleUrl);
  const buf = await generate({ tabId, settings: { pageRanges: '1-2', loadLazy: false } });
  const info = pdfInfo(savePdf('ranges.pdf', buf));
  check(info.pages === 2, `two pages from range 1-2 (${info.pages})`);
  const full = pdfInfo(savePdf('full.pdf', await generate({ tabId, settings: { loadLazy: false } })));
  const wide = pdfInfo(
    savePdf('wide.pdf', await generate({ tabId, settings: { layoutWidth: '1440', loadLazy: false } })),
  );
  check(wide.pages < full.pages, `1440px layout shrinks content (${full.pages} -> ${wide.pages} pages)`);
  await page.close();
});

await test('article mode isolates the main content and restores the page', async () => {
  const { page, tabId } = await openTab(articleUrl);
  const buf = await generate({ tabId, prep: 'article', settings: { loadLazy: false } });
  const text = pdfText(savePdf('article-only.pdf', buf));
  check(text.includes('ARTICLE-MARK'), 'article text present');
  check(!text.includes('SIDEBAR-MARK'), 'sidebar removed');
  check(!text.includes('FOOTER-MARK'), 'footer removed');
  const sidebarDisplay = await page.evaluate(
    () => getComputedStyle(document.getElementById('sidebar')).display,
  );
  check(sidebarDisplay !== 'none', 'sidebar visible again after restore');
  await page.close();
});

await test('remove-elements picker hides clicked element; reset restores it', async () => {
  const { page, tabId } = await openTab(articleUrl);
  const started = await sw.evaluate((id) => globalThis.__websnap.startPicker(id, 'remove'), tabId);
  check(started && started.ok, 'picker started through the background (content script injected)');
  const box = await page.locator('#sidebar h3').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.click(box.x + 5, box.y + 5);
  const st = await sw.evaluate((id) => globalThis.__websnap.pageState(id), tabId);
  check(st.removed === 1, `one element removed (${st.removed})`);
  await page.keyboard.press('Escape');
  const text = pdfText(savePdf('removed.pdf', await generate({ tabId, settings: { loadLazy: false } })));
  check(!text.includes('SIDEBAR-MARK'), 'removed element absent from PDF');
  await sw.evaluate((id) => globalThis.__websnap.resetPage(id), tabId);
  const vis = await page.evaluate(() => getComputedStyle(document.querySelector('#sidebar h3')).display);
  check(vis !== 'none', 'reset restores removed element');
  await page.close();
});

await test('select-element picker opens a preview; Download (PDF) saves just that element', async () => {
  const { page, tabId } = await openTab(articleUrl);
  const started = await sw.evaluate((id) => globalThis.__websnap.startPicker(id, 'print'), tabId);
  check(started && started.ok, 'picker started through the background (content script injected)');
  const box = await page.locator('#sidebar').boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.click(box.x + 10, box.y + 10);
  // The click opens the in-page preview overlay (shadow DOM) instead of downloading right away.
  const overlay = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-websnap-ui="preview"]');
      if (!host) return null;
      const sr = host.shadowRoot;
      const canvas = sr.querySelector('.stage canvas');
      const checked = sr.querySelector('.seg [aria-checked="true"]');
      const d = sr.querySelector('.download').getBoundingClientRect();
      return {
        ready: !!(canvas && canvas.dataset.ready),
        toolbarTop: sr.querySelector('.toolbar').getBoundingClientRect().top,
        format: checked && checked.dataset.format,
        download: { x: d.left + d.width / 2, y: d.top + d.height / 2 },
      };
    });
  let m = null;
  for (let i = 0; i < 100 && !(m && m.ready); i++) {
    await page.waitForTimeout(100);
    m = await overlay();
  }
  check(m && m.ready, 'preview overlay shows the captured element');
  const downloads = await sw.evaluate(() => chrome.downloads.search({}));
  check(
    !downloads.some((d) => /Fixture Article/.test(d.filename)),
    'nothing downloaded before "Download" is clicked',
  );
  check(m && m.format === 'pdf', `PDF is the default format (${m && m.format})`);
  check(m && m.toolbarTop === 0, 'options in a toolbar at the top of the viewport');
  await page.mouse.click(m.download.x, m.download.y);
  const item = await waitForDownload(sw, (i) => /Fixture Article.*\.pdf$/.test(i.filename));
  check(fs.existsSync(item.filename), `downloaded to ${item.filename}`);
  check(
    path.dirname(item.filename) === fs.realpathSync(downloadDir) ||
      path.dirname(item.filename) === downloadDir,
    'saved in the configured download directory',
  );
  const text = pdfText(item.filename);
  check(
    text.includes('SIDEBAR-MARK') && !text.includes('ARTICLE-MARK'),
    'PDF contains only the selected element',
  );
  await page.close();
});

await test('large PDF downloads through the data URL path', async () => {
  const { page, tabId } = await openTab(`${base}/big.html`);
  const res = await sw.evaluate((o) => globalThis.__websnap.generate(o), {
    tabId,
    output: 'download',
    settings: { filenameTemplate: '{title}-{date}', loadLazy: false },
  });
  check(res.ok, 'generate reported ok');
  const item = await waitForDownload(sw, (i) => /Big Fixture/.test(i.filename), 60000);
  const size = fs.statSync(item.filename).size;
  check(size > 3 * 1024 * 1024, `downloaded file is large (${(size / 1048576).toFixed(1)} MB)`);
  check(fs.readFileSync(item.filename).subarray(0, 5).toString() === '%PDF-', 'downloaded file is a PDF');
  await page.close();
});

await test('restricted pages are rejected with a friendly error', async () => {
  const page = await context.newPage();
  await page.goto('chrome://version/');
  const tabId = await sw.evaluate(
    async () =>
      (await chrome.tabs.query({ title: 'About Version*' }))[0]?.id ??
      (await chrome.tabs.query({ active: true }))[0]?.id,
  );
  let error = '';
  try {
    await sw.evaluate((o) => globalThis.__websnap.generate(o), { tabId, output: 'return' });
  } catch (err) {
    error = String(err.message || err);
  }
  check(/cannot be converted/i.test(error), `friendly error: ${error.split('\n')[0]}`);
  await page.close();
});

await test('extension pages load without errors (popup, options, viewer)', async () => {
  for (const p of ['src/popup/popup.html', 'src/options/options.html', 'src/viewer/viewer.html']) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`chrome-extension://${extensionId}/${p}`);
    await page.waitForTimeout(400);
    check(errors.length === 0, `${p} has no errors`, errors.join(' | '));
    await page.close();
  }
});

const failures = summary();
await close();
process.exit(failures ? 1 : 0);
