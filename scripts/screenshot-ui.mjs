// Visual QA: renders the popup, options and viewer pages of the unpacked extension in light and
// dark mode (plus the popup's dynamic states) and saves PNG screenshots to test/out/ui/.
// Fails (exit code 1) on any uncaught page error or console error.
// Run with: node scripts/screenshot-ui.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const outDir = path.join(root, 'test/out/ui');
fs.mkdirSync(outDir, { recursive: true });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesnap-ui-'));
const context = await chromium.launchPersistentContext(tmpDir, {
  headless: true,
  channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const problems = [];
const shots = [];

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(sw.url()).host;
  const base = `chrome-extension://${extensionId}/src`;
  // Start from default settings so screenshots are reproducible.
  await sw.evaluate(() => chrome.storage.sync.clear());

  async function openPage(url, { width, height, colorScheme, label, init }) {
    const page = await context.newPage();
    page.on('pageerror', (err) => problems.push(`[${label}] pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`[${label}] console.error: ${msg.text()}`);
    });
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme });
    if (init) await page.addInitScript(init.fn, init.arg);
    await page.goto(url);
    await page.waitForLoadState('load');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    return page;
  }

  async function shot(page, name, fullPage = true) {
    const file = path.join(outDir, `${name}.png`);
    if (fullPage) {
      // Like Chrome's popup auto-sizing: grow the viewport to the content instead of using a
      // fullPage capture, which would paint the sticky popup footer mid-page.
      const size = page.viewportSize();
      const height = await page.evaluate(() => Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height)));
      await page.setViewportSize({ width: size.width, height: Math.max(size.height, height) });
      await page.screenshot({ path: file });
      await page.setViewportSize(size);
    } else {
      await page.screenshot({ path: file });
    }
    shots.push(file);
  }

  // Stub for the popup: pretend the active tab is an ordinary, printable web page so the full
  // form is enabled. Only the page-state query is answered here; the popup itself is unchanged.
  const printableStub = {
    fn: () => {
      // Init scripts also run in sub-frames; only patch the extension page itself.
      if (window !== window.top || !globalThis.chrome?.runtime?.sendMessage) return;
      const realQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (q) => {
        const tabs = await realQuery(q);
        return tabs.map((t) => ({ ...t, title: 'Example article – A long page title that should be truncated nicely', url: 'https://example.com/article' }));
      };
      // Record every message; never let an action reach the real worker (it would act on this tab).
      window.__sent = [];
      chrome.runtime.sendMessage = async (msg) => {
        window.__sent.push(msg && msg.type);
        if (msg && msg.type === 'ps:page-state') return { ok: true, printable: true, busy: false, removed: 0, hasPicked: false };
        return { ok: false, error: 'stubbed in screenshot-ui' };
      };
    },
  };

  const pdfPath = path.join(root, 'test/out/a4-default.pdf');
  const viewerStub = fs.existsSync(pdfPath)
    ? {
        fn: (base64) => {
          if (window !== window.top || !globalThis.chrome?.runtime?.sendMessage) return;
          const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = async (msg, ...rest) => {
            if (msg && msg.type === 'ps:get-job') return { ok: true, job: { base64, filename: 'Example article – example.com.pdf', autoDownload: false } };
            if (msg && msg.type === 'ps:discard-job') return { ok: true };
            return realSend(msg, ...rest);
          };
        },
        arg: fs.readFileSync(pdfPath).toString('base64'),
      }
    : null;

  for (const colorScheme of ['light', 'dark']) {
    const sfx = `-${colorScheme}`;
    await sw.evaluate(() => chrome.storage.sync.clear()); // each scheme starts from defaults

    // --- popup: real behaviour when opened as a tab (no printable active tab) --------------
    {
      const page = await openPage(`${base}/popup/popup.html`, { width: 360, height: 700, colorScheme, label: `popup-blocked${sfx}` });
      await page.waitForSelector('#blocked:not(.hidden)', { timeout: 5000 }).catch(() => problems.push(`[popup-blocked${sfx}] blocked notice never appeared`));
      await shot(page, `popup-blocked${sfx}`);
      await page.close();
    }

    // --- popup: enabled form and its dynamic states --------------------------------------
    {
      const label = `popup${sfx}`;
      await sw.evaluate(() => chrome.storage.sync.clear());
      const page = await openPage(`${base}/popup/popup.html`, { width: 360, height: 700, colorScheme, label, init: printableStub });
      await page.waitForFunction(() => !document.getElementById('main').classList.contains('disabled'));
      await shot(page, `popup-default${sfx}`);

      // Segmented-control labels must stay on one line.
      const wrapped = await page.evaluate(() =>
        [...document.querySelectorAll('.seg button')]
          .filter((b) => b.getBoundingClientRect().height > parseFloat(getComputedStyle(b).lineHeight) + parseFloat(getComputedStyle(b).paddingTop) * 2 + 2)
          .map((b) => b.textContent.trim()),
      );
      for (const w of wrapped) problems.push(`[${label}] segmented button wraps: ${w}`);

      // Clicking the "Orientation" caption must not toggle the segmented control.
      await page.click('.seg[data-key="orientation"] button[data-value="landscape"]');
      await page.click('#orientation-label');
      const orient = await page.getAttribute('.seg[data-key="orientation"] button[data-value="landscape"]', 'aria-pressed');
      if (orient !== 'true') problems.push(`[${label}] clicking the Orientation caption changed the orientation`);
      await page.click('.seg[data-key="orientation"] button[data-value="portrait"]');

      // Enter on a focused button must activate only that button, not also start a download.
      await page.focus('.seg[data-key="contentMode"] button[data-value="page"]');
      await page.keyboard.press('Enter');
      await page.focus('#btn-open');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      const sent = await page.evaluate(() => window.__sent.filter((t) => t === 'ps:generate').length);
      if (sent !== 1) problems.push(`[${label}] Enter on buttons sent ${sent} ps:generate messages, expected 1 (from Preview)`);
      await page.evaluate(() => { const s = document.getElementById('status'); s.textContent = ''; s.className = 'status'; });

      // Chrome caps popups at 600px: the footer actions must stay visible at that height.
      await page.setViewportSize({ width: 360, height: 600 });
      await page.selectOption('#marginPreset', 'custom');
      await page.check('#headerFooter');
      await shot(page, `popup-600px-sticky-footer${sfx}`, false);
      if (!(await page.locator('#btn-download').isVisible()) || (await page.evaluate(() => document.getElementById('btn-download').getBoundingClientRect().bottom)) > 600) {
        problems.push(`[${label}] Download button not visible in a 600px-high popup`);
      }
      await page.setViewportSize({ width: 360, height: 700 });
      await page.selectOption('#marginPreset', 'default');
      await page.uncheck('#headerFooter');

      // Custom margins + header/footer chips.
      await page.selectOption('#marginPreset', 'custom');
      await page.check('#headerFooter');
      await page.uncheck('#hfUrl');
      await page.waitForSelector('#custom-margins:not(.hidden)');
      await page.waitForSelector('#hf-options:not(.hidden)');
      await shot(page, `popup-custom-margins-hf${sfx}`);

      // Single page layout: page-ranges row must hide.
      await page.click('.seg[data-key="layout"] button[data-value="single"]');
      await page.click('.seg[data-key="contentMode"] button[data-value="article"]');
      if (await page.isVisible('#ranges-row')) problems.push(`[${label}] ranges row still visible in single-page layout`);
      await shot(page, `popup-single-article${sfx}`);

      // Fixed layout width: scale slider disabled, label shows auto.
      await page.click('.seg[data-key="layout"] button[data-value="paged"]');
      await page.selectOption('#layoutWidth', '1280');
      if (!(await page.isDisabled('#scale'))) problems.push(`[${label}] scale slider not disabled for layout width 1280`);
      const scaleText = await page.textContent('#scale-value');
      if (scaleText !== 'auto (fit width)') problems.push(`[${label}] scale label is "${scaleText}", expected "auto (fit width)"`);
      if (!(await page.isVisible('#ranges-row'))) problems.push(`[${label}] ranges row hidden in paged layout`);
      await shot(page, `popup-layout-1280${sfx}`);

      // Removed-elements reset button + keyboard focus ring.
      await page.evaluate(() => {
        document.getElementById('removed-count').textContent = '3';
        document.getElementById('tool-reset').classList.remove('hidden');
      });
      await page.focus('#btn-download');
      await page.keyboard.press('Shift+Tab'); // focus via keyboard so :focus-visible applies
      await shot(page, `popup-focus-reset${sfx}`);

      // Focus rings on the riskier controls: segmented button, chip checkbox, tool button.
      await page.focus('.seg[data-key="orientation"] button[data-value="landscape"]');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await shot(page, `popup-focus-seg${sfx}`, false);
      await page.focus('#hfDate');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await shot(page, `popup-focus-chip${sfx}`);
      await page.focus('#tool-select');
      await page.keyboard.press('Tab');
      await shot(page, `popup-focus-tool${sfx}`);

      // Status line: success and error colours.
      await page.evaluate(() => {
        const s = document.getElementById('status');
        s.className = 'status ok';
        s.textContent = 'Saved Example article – example.com.pdf';
      });
      await shot(page, `popup-status-ok${sfx}`);
      await page.evaluate(() => {
        const s = document.getElementById('status');
        s.className = 'status error';
        s.textContent = 'Could not attach to the tab: another debugger is already attached.';
      });
      await shot(page, `popup-status-error${sfx}`);
      await page.evaluate(() => {
        const s = document.getElementById('status');
        s.className = 'status';
        s.innerHTML = '<span class="spinner"></span>Rendering PDF…';
      });
      await shot(page, `popup-status-busy${sfx}`);

      // Layout sanity: nothing may overflow the 360px popup horizontally.
      const overflow = await page.evaluate(() => {
        const out = [];
        const vw = document.documentElement.clientWidth;
        if (document.documentElement.scrollWidth > vw) out.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
        for (const el of document.querySelectorAll('button, select, input, label')) {
          const r = el.getBoundingClientRect();
          if (r.width && (r.right > vw + 0.5 || r.left < -0.5)) out.push(`${el.tagName}#${el.id || el.textContent.trim().slice(0, 20)} spans ${r.left}-${r.right}`);
          if (el.matches('button') && el.scrollWidth > el.clientWidth + 1) out.push(`button text clipped: ${el.textContent.trim()}`);
        }
        return out;
      });
      for (const o of overflow) problems.push(`[${label}] overflow: ${o}`);

      // Windows/Linux popups get a ~15px classic scrollbar once the form exceeds 600px; headless
      // hides scrollbars, so simulate the narrower content box and check nothing wraps or clips.
      const narrow = await page.evaluate(() => {
        document.body.style.width = '345px';
        const out = [];
        for (const b of document.querySelectorAll('.seg button, .actions button, .tool')) {
          const cs = getComputedStyle(b);
          const oneLine = parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 2 + 2;
          if (b.offsetParent && (b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().height > oneLine)) out.push(b.textContent.trim());
        }
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push('horizontal overflow');
        document.body.style.width = '';
        return out;
      });
      for (const n of narrow) problems.push(`[${label}] at 345px (with scrollbar) clipped/wrapped: ${n}`);

      // Accessible names: every button must have one.
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll('button')]
          .filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim() || b.getAttribute('aria-labelledby')))
          .map((b) => b.outerHTML.slice(0, 80)),
      );
      for (const u of unnamed) problems.push(`[${label}] button without accessible name: ${u}`);
      await page.close();
    }

    // --- options ---------------------------------------------------------------------------
    {
      const page = await openPage(`${base}/options/options.html`, { width: 720, height: 900, colorScheme, label: `options${sfx}` });
      await shot(page, `options${sfx}`);
      await page.focus('#open-shortcuts');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await shot(page, `options-focus${sfx}`, false);
      await page.close();
    }

    // --- viewer ----------------------------------------------------------------------------
    {
      const page = await openPage(`${base}/viewer/viewer.html`, { width: 1100, height: 700, colorScheme, label: `viewer-error${sfx}` });
      await shot(page, `viewer-error${sfx}`, false);
      await page.close();
    }
    if (viewerStub) {
      const page = await openPage(`${base}/viewer/viewer.html?job=demo`, { width: 1100, height: 700, colorScheme, label: `viewer${sfx}`, init: viewerStub });
      await page.waitForFunction(() => !document.getElementById('btn-download').disabled);
      await shot(page, `viewer${sfx}`, false);
      await page.setViewportSize({ width: 420, height: 500 });
      await shot(page, `viewer-narrow${sfx}`, false);
      await page.close();
    }
  }
} catch (err) {
  problems.push(`script error: ${err.stack || err}`);
} finally {
  await context.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

for (const f of shots) console.log('saved', path.relative(root, f));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}
console.log(`\nOK: ${shots.length} screenshots, no page or console errors.`);
