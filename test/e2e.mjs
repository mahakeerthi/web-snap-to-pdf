// End-to-end test: loads the unpacked extension into Chromium and exercises the PDF pipeline.
// Run with: npm test
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

// --- stream-save helpers ----------------------------------------------------------------
// Tests wrap chrome APIs in the worker. Each install function is self-contained (it runs in the
// worker) and pushes an undo into globalThis.__restore. withWrapped runs every undo whatever the
// test does.
async function withWrapped(installs, body) {
  for (const install of [].concat(installs)) await sw.evaluate(install);
  try {
    return await body();
  } finally {
    await sw.evaluate(() => {
      for (const undo of globalThis.__restore || []) undo();
      globalThis.__restore = [];
    });
  }
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const offscreenOpen = () =>
  sw.evaluate(
    async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length,
  );
async function offscreenClosed(ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleepMs(50)) {
    if ((await offscreenOpen()) === 0) return true;
  }
  return (await offscreenOpen()) === 0;
}
function saveToDisk(tabId, template, settings = {}) {
  return sw.evaluate((o) => globalThis.__websnap.generate(o), {
    tabId,
    output: 'download',
    settings: { filenameTemplate: template, loadLazy: false, ...settings },
  });
}
// The message `promise` rejects with, or null when it resolves. A promise still pending after
// `ms` counts as a failure of its own, so a removed timeout shows up as a red check, not a hang.
async function failureOf(promise, ms = 60000) {
  const outcome = promise.then(
    () => null,
    (err) =>
      String(err.message || err)
        .split('\n')[0]
        .replace(/^worker\.evaluate: (\w*Error: )?/, ''),
  );
  return Promise.race([outcome, sleepMs(ms).then(() => `no answer within ${ms} ms`)]);
}
// Waits until every named file has a completed download. Fails fast on an interrupted one.
async function waitForFiles(names, timeoutMs = 60000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleepMs(100)) {
    const items = await sw.evaluate(() => chrome.downloads.search({}));
    const byName = names.map((n) => items.find((i) => path.basename(i.filename) === n));
    const bad = items.find((i) => i.state === 'interrupted');
    if (bad) throw new Error(`download interrupted: ${bad.error} (${path.basename(bad.filename)})`);
    if (byName.every((i) => i && i.state === 'complete')) return byName;
  }
  throw new Error('downloads did not complete: ' + names.join(', '));
}
// Records every Page.printToPDF reply and every IO.read / IO.close call.
function recordPdfStream() {
  const rec = (globalThis.__rec = { prints: [], reads: [], closes: [] });
  const orig = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async function (target, method, params) {
    if (method === 'IO.close') rec.closes.push(params.handle);
    const reply = await orig.call(this, target, method, params);
    if (method === 'Page.printToPDF') {
      rec.prints.push({ transferMode: params.transferMode, data: reply.data, stream: reply.stream });
    }
    if (method === 'IO.read') {
      const { base64Encoded, data, eof } = reply;
      rec.reads.push({ handle: params.handle, base64Encoded, data, eof });
    }
    return reply;
  };
  (globalThis.__restore ||= []).push(() => {
    chrome.debugger.sendCommand = orig;
  });
}
// Decodes the recorded chunks with its own atob loop, never the extension's decoder.
const recordedStream = () =>
  sw.evaluate(async () => {
    const { prints, reads, closes } = globalThis.__rec;
    const parts = reads
      .filter((r) => r.data)
      .map((r) => {
        const bin = atob(r.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      });
    const all = await new Blob(parts).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', all);
    return {
      prints,
      reads: reads.map(({ handle, base64Encoded, eof, data }) => ({
        handle,
        base64Encoded,
        eof,
        length: data.length,
      })),
      closes,
      bytes: all.byteLength,
      sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
    };
  });
// The saved file is the PDF Chrome printed: same bytes as the stream, the name generate replied
// with, and a blob: URL from this extension.
async function checkSavedStream(res, item, label) {
  const rec = await recordedStream();
  const file = fs.readFileSync(item.filename);
  check(res.ok, `${label}: generate reported ok`);
  check(
    rec.prints.length === 1 && rec.prints[0].transferMode === 'ReturnAsStream',
    `${label}: printed with ReturnAsStream`,
  );
  check(
    rec.prints[0]?.data === '' && !!rec.prints[0]?.stream,
    `${label}: the print reply carries a stream handle and no data`,
  );
  check(
    rec.reads.length >= 1 && rec.reads.every((r) => r.base64Encoded === true),
    `${label}: ${rec.reads.length} IO.read calls, all base64`,
  );
  check(rec.reads.at(-1)?.eof === true, `${label}: the last IO.read reply is eof`);
  check(
    rec.closes.length === 1 && rec.closes[0] === rec.prints[0]?.stream,
    `${label}: one IO.close with the printed handle`,
  );
  check(sha256(file) === rec.sha256, `${label}: file on disk is byte-identical to the IO.read bytes`);
  check(
    file.length === res.bytes && file.length === rec.bytes,
    `${label}: file size ${file.length} equals res.bytes and the stream`,
  );
  check(
    file.subarray(0, 5).toString() === '%PDF-' && file.subarray(-16).toString('latin1').includes('%%EOF'),
    `${label}: starts with %PDF- and ends with %%EOF`,
  );
  check(
    path.basename(item.filename) === res.filename,
    `${label}: file name equals res.filename (${path.basename(item.filename)})`,
  );
  check(item.mime === 'application/pdf', `${label}: download mime is ${item.mime}`);
  check(
    item.url.startsWith(`blob:chrome-extension://${extensionId}/`),
    `${label}: downloaded from a blob: URL of this extension`,
  );
  return rec;
}

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

await test('large PDF downloads through the stream path', async () => {
  const { page, tabId } = await openTab(`${base}/big.html`);
  const tabs = context.pages().length;
  await withWrapped(recordPdfStream, async () => {
    const res = await saveToDisk(tabId, '{title}-{date}');
    const item = await waitForDownload(sw, (i) => /Big Fixture/.test(i.filename), 60000);
    const size = fs.statSync(item.filename).size;
    check(size > 3 * 1024 * 1024, `downloaded file is large (${(size / 1048576).toFixed(1)} MB)`);
    const rec = await checkSavedStream(res, item, 'large PDF');
    check(rec.reads.length >= 3, `read in several chunks (${rec.reads.length})`);
    check(context.pages().length === tabs, 'no tab opened during the save');
    check(await offscreenClosed(), 'no offscreen document is left open');
  });
  await page.close();
});

await test('PDF saved on a Chrome without Uint8Array.fromBase64 decodes the stream with atob', async () => {
  const { page, tabId } = await openTab(`${base}/big.html?atob=1`);
  await withWrapped(
    [
      recordPdfStream,
      () => {
        const orig = Uint8Array.fromBase64;
        Uint8Array.fromBase64 = undefined;
        (globalThis.__restore ||= []).push(() => {
          Uint8Array.fromBase64 = orig;
        });
      },
    ],
    async () => {
      check(
        await sw.evaluate(() => typeof Uint8Array.fromBase64 === 'undefined'),
        'fromBase64 is gone in the worker',
      );
      const res = await saveToDisk(tabId, 'p2-atob-{title}');
      const item = await waitForDownload(sw, (i) => /p2-atob-/.test(i.filename));
      await checkSavedStream(res, item, 'atob decoder');
    },
  );
  await page.close();
});

await test('a failed PDF save shows an error and opens nothing', async () => {
  const { page, tabId } = await openTab(`${articleUrl}?fail=1`);
  const tabs = context.pages().length;
  const named = (re) => sw.evaluate((r) => chrome.downloads.search({ filenameRegex: r }), re);
  await withWrapped(
    () => {
      const orig = chrome.offscreen.createDocument;
      chrome.offscreen.createDocument = async () => {
        throw new Error('simulated createDocument failure');
      };
      (globalThis.__restore ||= []).push(() => {
        chrome.offscreen.createDocument = orig;
      });
    },
    async () => {
      const error = await failureOf(saveToDisk(tabId, 'p2-fail-a'));
      check(error === 'Could not save the PDF.', `blob: URL failure is reported (${error})`);
      check(
        (await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)) === '!',
        'the toolbar badge shows !',
      );
      check((await named('p2-fail-a')).length === 0, 'no download started');
      check(context.pages().length === tabs, 'no tab opened');
      check(
        (await sw.evaluate((id) => globalThis.__websnap.pageState(id), tabId)).busy === false,
        'the tab is not busy',
      );
    },
  );
  await withWrapped(
    () => {
      const orig = chrome.downloads.download;
      chrome.downloads.download = async () => {
        chrome.downloads.download = orig;
        throw new Error('Invalid filename');
      };
      (globalThis.__restore ||= []).push(() => {
        chrome.downloads.download = orig;
      });
    },
    async () => {
      const error = await failureOf(saveToDisk(tabId, 'p2-fail-b'));
      check(error === 'Invalid filename', `download() rejection is reported as Chrome words it (${error})`);
      check(context.pages().length === tabs, 'no tab opened');
      check(await offscreenClosed(), 'no offscreen document is left open');
    },
  );
  const res = await saveToDisk(tabId, 'p2-fail-c');
  const [item] = await waitForFiles([res.filename]);
  check(res.ok && item.state === 'complete', 'a next save on the same tab succeeds');
  await page.close();
});

await test('the offscreen document is created while the page prints', async () => {
  const { page, tabId } = await openTab(`${articleUrl}?warm=1`);
  await withWrapped(
    () => {
      const orig = chrome.debugger.sendCommand;
      globalThis.__docBeforePrint = null;
      chrome.debugger.sendCommand = async function (target, method, params) {
        if (method === 'Page.printToPDF') {
          for (let i = 0; i < 100 && globalThis.__docBeforePrint !== true; i++) {
            const docs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
            globalThis.__docBeforePrint = docs.length > 0;
            if (!globalThis.__docBeforePrint) await new Promise((r) => setTimeout(r, 50));
          }
        }
        return orig.call(this, target, method, params);
      };
      (globalThis.__restore ||= []).push(() => {
        chrome.debugger.sendCommand = orig;
      });
    },
    async () => {
      const res = await saveToDisk(tabId, 'p2-warm');
      const [item] = await waitForFiles([res.filename]);
      check(
        (await sw.evaluate(() => globalThis.__docBeforePrint)) === true,
        'an offscreen document is open before Page.printToPDF starts',
      );
      check(
        res.ok && item.url.startsWith(`blob:chrome-extension://${extensionId}/`),
        'the save completes through a blob: URL',
      );
      check(await offscreenClosed(), 'no offscreen document is left open');
    },
  );
  await page.close();
});

await test('a failed warm-up does not fail the save, and a failed export leaves no document', async () => {
  const { page, tabId } = await openTab(`${articleUrl}?warmfail=1`);
  await withWrapped(
    () => {
      const orig = chrome.offscreen.createDocument;
      chrome.offscreen.createDocument = async () => {
        chrome.offscreen.createDocument = orig;
        throw new Error('simulated createDocument failure');
      };
      (globalThis.__restore ||= []).push(() => {
        chrome.offscreen.createDocument = orig;
      });
    },
    async () => {
      const res = await saveToDisk(tabId, 'p2-warmfail');
      const [item] = await waitForFiles([res.filename]);
      check(res.ok && item.state === 'complete', 'the save asks for the document again and completes');
    },
  );
  check(await offscreenClosed(), 'no offscreen document is left open after the save');
  await withWrapped(
    () => {
      const orig = chrome.debugger.sendCommand;
      chrome.debugger.sendCommand = async function (target, method, params) {
        if (method === 'Page.printToPDF') {
          chrome.debugger.sendCommand = orig;
          throw new Error('simulated print failure');
        }
        return orig.call(this, target, method, params);
      };
      (globalThis.__restore ||= []).push(() => {
        chrome.debugger.sendCommand = orig;
      });
    },
    async () => {
      const error = await failureOf(saveToDisk(tabId, 'p2-printfail'));
      check(error === 'simulated print failure', `the print failure is reported (${error})`);
      check(await offscreenClosed(), 'an export that failed before saving leaves no offscreen document');
    },
  );
  const res = await saveToDisk(tabId, 'p2-afterfail');
  const [item] = await waitForFiles([res.filename]);
  check(res.ok && item.state === 'complete', 'a next save on the same tab succeeds');
  await page.close();
});

await test('an offscreen page that never shows up or never answers fails the save', async () => {
  const { page, tabId } = await openTab(`${articleUrl}?silent=1`);
  const busy = async () => (await sw.evaluate((id) => globalThis.__websnap.pageState(id), tabId)).busy;
  await withWrapped(
    () => {
      const orig = self.clients.matchAll;
      self.clients.matchAll = async () => [];
      (globalThis.__restore ||= []).push(() => {
        self.clients.matchAll = orig;
      });
    },
    async () => {
      const error = await failureOf(saveToDisk(tabId, 'p2-nopage'), 15000);
      check(error === 'Could not save the PDF.', `a missing offscreen page fails the save (${error})`);
      check((await busy()) === false, 'the tab is not busy afterwards');
      check(await offscreenClosed(), 'the unused offscreen document is closed');
    },
  );
  await withWrapped(
    () => {
      const proto = self.Client.prototype;
      const orig = proto.postMessage;
      proto.postMessage = function () {
        proto.postMessage = orig;
      };
      (globalThis.__restore ||= []).push(() => {
        proto.postMessage = orig;
      });
    },
    async () => {
      const error = await failureOf(saveToDisk(tabId, 'p2-nopost'), 30000);
      check(
        error === 'Could not save the PDF.',
        `a silent offscreen page fails the save after its wait (${error})`,
      );
      check((await busy()) === false, 'the tab is not busy afterwards');
    },
  );
  const res = await saveToDisk(tabId, 'p2-afterwards');
  const [item] = await waitForFiles([res.filename]);
  check(res.ok && item.state === 'complete', 'a next save on the same tab succeeds');
  check(await offscreenClosed(), 'no offscreen document is left open');
  await page.close();
});

await test('two PDFs saved at the same time both complete', async () => {
  const small = await openTab(`${articleUrl}?two=1`);
  const big = await openTab(`${base}/big.html`);
  await withWrapped(
    () => {
      const gate = (globalThis.__gate = { held: [] });
      const orig = chrome.downloads.download;
      chrome.downloads.download = (opts) =>
        new Promise((resolve, reject) => {
          const hold = { filename: opts.filename, done: false };
          hold.go = () => {
            if (hold.done) return;
            hold.done = true;
            orig.call(chrome.downloads, opts).then(resolve, reject);
          };
          gate.held.push(hold);
        });
      (globalThis.__restore ||= []).push(() => {
        chrome.downloads.download = orig;
        gate.held.forEach((h) => h.go());
      });
    },
    async () => {
      const runs = [small, big].map((t) => saveToDisk(t.tabId, 'p2-two-{title}'));
      for (let i = 0; i < 600 && (await sw.evaluate(() => globalThis.__gate.held.length)) < 2; i++)
        await sleepMs(100);
      const held = await sw.evaluate(() => globalThis.__gate.held.map((h) => h.filename));
      check(held.length === 2, `both saves reached download() (${held.length})`);
      const release = (n) => sw.evaluate((k) => globalThis.__gate.held[k].go(), n);
      await release(0);
      await waitForFiles([held[0]]);
      const firstRes = (
        await Promise.all(runs.map((r) => Promise.race([r, sleepMs(5000).then(() => null)])))
      ).find((r) => r && r.filename === held[0]);
      check(!!firstRes && firstRes.ok, 'the first generate resolved ok');
      check((await offscreenOpen()) === 1, 'the offscreen document stays open for the save still waiting');
      await release(1);
      const results = await Promise.all(runs);
      const items = await waitForFiles(held);
      for (const [i, item] of items.entries()) {
        const res = results.find((r) => r.filename === held[i]);
        check(
          res && res.ok && fs.statSync(item.filename).size === res.bytes,
          `${held[i]}: size equals res.bytes`,
        );
        check(pdfInfo(item.filename).pages >= 1, `${held[i]}: pdfinfo reads it`);
      }
      check(await offscreenClosed(), 'no offscreen document is left open');
    },
  );
  await small.page.close();
  await big.page.close();
});

await test('PDFs saved back to back and three at once all complete', async () => {
  const one = await openTab(`${articleUrl}?seq=1`);
  const names = [0, 1, 2, 3, 4].map((i) => `p2-seq-${i}.pdf`);
  // A slow close and a slow download() make the next save start while the previous document is
  // still closing, and keep its blob: URL unused for a while.
  await withWrapped(
    () => {
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const close = chrome.offscreen.closeDocument;
      chrome.offscreen.closeDocument = async (...a) => {
        await pause(400);
        return close.apply(chrome.offscreen, a);
      };
      const download = chrome.downloads.download;
      chrome.downloads.download = async (...a) => {
        await pause(600);
        return download.apply(chrome.downloads, a);
      };
      (globalThis.__restore ||= []).push(() => {
        chrome.offscreen.closeDocument = close;
        chrome.downloads.download = download;
      });
    },
    async () => {
      const results = await sw.evaluate(async (tabId) => {
        const out = [];
        for (let i = 0; i < 5; i++) {
          out.push(
            await globalThis.__websnap.generate({
              tabId,
              output: 'download',
              settings: { filenameTemplate: `p2-seq-${i}`, loadLazy: false },
            }),
          );
        }
        return out;
      }, one.tabId);
      const items = await waitForFiles(names);
      results.forEach((res, i) => {
        check(
          res.ok && fs.statSync(items[i].filename).size === res.bytes,
          `save ${i + 1} of 5: file size equals res.bytes`,
        );
      });
      check(await offscreenClosed(), 'no offscreen document is left open after five saves');
    },
  );
  await one.page.close();

  const tabs = [];
  for (const n of [1, 2, 3]) tabs.push(await openTab(`${articleUrl}?three=${n}`));
  // The extra getContexts delay widens the window in which concurrent saves all see "no document".
  await withWrapped(
    () => {
      const orig = chrome.runtime.getContexts;
      chrome.runtime.getContexts = async (...a) => {
        await new Promise((r) => setTimeout(r, 150));
        return orig.apply(chrome.runtime, a);
      };
      (globalThis.__restore ||= []).push(() => {
        chrome.runtime.getContexts = orig;
      });
    },
    async () => {
      const results = await Promise.all(tabs.map((t, i) => saveToDisk(t.tabId, `p2-three-${i}`)));
      const items = await waitForFiles(results.map((r) => r.filename));
      results.forEach((res, i) => {
        check(
          res.ok && fs.statSync(items[i].filename).size === res.bytes,
          `save ${i + 1} of 3: file size equals res.bytes`,
        );
      });
    },
  );
  check(await offscreenClosed(), 'no offscreen document is left open after three saves');
  for (const t of tabs) await t.page.close();
});

await test('an offscreen document left open is reused and closed after the save', async () => {
  const { page, tabId } = await openTab(`${articleUrl}?leftover=1`);
  await sw.evaluate(() =>
    chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'test: a document left behind by an earlier worker',
    }),
  );
  check((await offscreenOpen()) === 1, 'a leftover document is open');
  const res = await saveToDisk(tabId, 'p2-leftover');
  const [item] = await waitForFiles([res.filename]);
  check(
    res.ok && item.url.startsWith(`blob:chrome-extension://${extensionId}/`),
    'the save completes through a blob: URL',
  );
  check(await offscreenClosed(), 'no offscreen document is left open');
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

await test('extension pages load without errors (popup, options, offscreen)', async () => {
  for (const p of ['src/popup/popup.html', 'src/options/options.html', 'src/offscreen/offscreen.html']) {
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
