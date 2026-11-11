// Visual QA: renders the popup, options and viewer pages of the unpacked extension in light and
// dark mode (plus the popup's dynamic states) and saves PNG screenshots to test/out/ui/.
// Fails (exit code 1) on any uncaught page error or console error.
// Run with: node scripts/screenshot-ui.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const outDir = path.join(root, 'test/out/ui');
fs.mkdirSync(outDir, { recursive: true });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'websnap-ui-'));
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
      const height = await page.evaluate(() =>
        Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height)),
      );
      await page.setViewportSize({ width: size.width, height });
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
        return tabs.map((t) => ({
          ...t,
          title: 'Example article – A long page title that should be truncated nicely',
          url: 'https://example.com/article',
        }));
      };
      // Record every message; never let an action reach the real worker (it would act on this tab).
      window.__sent = [];
      chrome.runtime.sendMessage = async (msg) => {
        window.__sent.push(JSON.parse(JSON.stringify(msg || {})));
        if (msg && msg.type === 'ps:page-state')
          return { ok: true, printable: true, busy: false, removed: 0, hasPicked: false };
        return { ok: false, error: 'stubbed in screenshot-ui' };
      };
      // Keep the popup open when an action would close it.
      window.close = () => {
        window.__closed = true;
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
            if (msg && msg.type === 'ps:get-job')
              return {
                ok: true,
                job: { base64, filename: 'Example article – example.com.pdf', autoDownload: false },
              };
            if (msg && msg.type === 'ps:discard-job') return { ok: true };
            return realSend(msg, ...rest);
          };
        },
        arg: fs.readFileSync(pdfPath).toString('base64'),
      }
    : null;

  // Static i18n check: every key referenced by the popup/options markup or code must exist in the
  // English dictionary, otherwise users would see the HTML fallback or the raw key.
  {
    const en = JSON.parse(fs.readFileSync(path.join(extDir, '_locales/en/messages.json'), 'utf8'));
    const refs = new Set();
    for (const f of ['src/popup/popup.html', 'src/options/options.html']) {
      const html = fs.readFileSync(path.join(extDir, f), 'utf8');
      for (const m of html.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g))
        refs.add(m[1]);
    }
    for (const f of ['src/popup/popup.js', 'src/options/options.js']) {
      const js = fs.readFileSync(path.join(extDir, f), 'utf8');
      for (const m of js.matchAll(/\b(?:tr|t)\((?:messages, )?'([A-Za-z0-9_]+)'/g)) refs.add(m[1]);
      for (const m of js.matchAll(/(?:flash)\('([A-Za-z0-9_]+)'/g)) refs.add(m[1]);
    }
    const { PAPER_SIZES } = await import(pathToFileURL(path.join(extDir, 'src/lib/paper-sizes.js')).href);
    const { LAYOUT_WIDTHS } = await import(pathToFileURL(path.join(extDir, 'src/lib/settings.js')).href);
    for (const p of PAPER_SIZES) refs.add(`paper_${p.id}`);
    for (const w of LAYOUT_WIDTHS) refs.add(`layoutWidth_${w.id}`);
    for (const k of [
      'theme_system',
      'theme_light',
      'theme_dark',
      'summary_portrait',
      'summary_landscape',
      'summary_backgroundsOn',
      'summary_backgroundsOff',
    ])
      refs.add(k);
    for (const k of refs)
      if (!en[k]) problems.push(`[i18n] key "${k}" is used but missing from _locales/en/messages.json`);
    for (const k of Object.keys(en))
      if (!/^[A-Za-z0-9_@]+$/.test(k)) problems.push(`[i18n] invalid message key "${k}"`);
  }

  const DEFAULT_SUMMARY = 'A4 · Portrait · 10 mm margins · Backgrounds on';
  const summary = (page) => page.textContent('#summary');
  const sent = (page) => page.evaluate(() => window.__sent.filter((m) => m.type !== 'ps:page-state'));
  const clearSent = (page) => page.evaluate(() => (window.__sent.length = 0));
  const resetStatus = (page) =>
    page.evaluate(() => {
      const s = document.getElementById('status');
      s.textContent = '';
      s.className = 'status';
    });
  const openPopup = async (label, colorScheme, height = 700) => {
    const page = await openPage(`${base}/popup/popup.html`, {
      width: 360,
      height,
      colorScheme,
      label,
      init: printableStub,
    });
    await page.waitForSelector('body[data-state="ready"]', { timeout: 5000 });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-boot'));
    return page;
  };

  for (const colorScheme of ['light', 'dark']) {
    const sfx = `-${colorScheme}`;
    const other = colorScheme === 'light' ? 'dark' : 'light';
    // Each scheme starts from defaults (sync = settings, local = disclosure state).
    await sw.evaluate(() => Promise.all([chrome.storage.sync.clear(), chrome.storage.local.clear()]));

    // --- popup: real behaviour when opened as a tab (no printable active tab) --------------
    {
      const label = `popup-blocked${sfx}`;
      const page = await openPage(`${base}/popup/popup.html`, {
        width: 360,
        height: 700,
        colorScheme,
        label,
      });
      await page
        .waitForSelector('#blocked:not(.hidden)', { timeout: 5000 })
        .catch(() => problems.push(`[${label}] blocked notice never appeared`));
      if (!(await page.evaluate(() => document.getElementById('actions').inert)))
        problems.push(`[${label}] action cards are not inert on a blocked page`);
      await shot(page, label);
      await page.close();
    }

    // --- popup: home screen and its dynamic states ---------------------------------------
    {
      const label = `popup${sfx}`;
      let page = await openPopup(label, colorScheme);

      // Collapsed by default, nothing Markdown-related while the experimental flag is off.
      if ((await page.getAttribute('#toggle-advanced', 'aria-expanded')) !== 'false')
        problems.push(`[${label}] export settings not collapsed by default`);
      if (await page.isVisible('#advanced')) problems.push(`[${label}] #advanced visible while collapsed`);
      if (await page.isVisible('#md-row'))
        problems.push(`[${label}] Markdown action visible although markdownEnabled is false`);
      if ((await summary(page)) !== DEFAULT_SUMMARY)
        problems.push(`[${label}] summary is "${await summary(page)}", expected "${DEFAULT_SUMMARY}"`);
      if (await page.isVisible('#act-reset'))
        problems.push(`[${label}] reset link visible with 0 removed elements`);
      if ((await page.locator('.card-alt, #act-page-preview, #act-article-preview').count()) !== 0)
        problems.push(`[${label}] popup still has preview (eye) buttons on the cards`);
      if ((await page.locator('.card').count()) !== 3)
        problems.push(`[${label}] expected 3 action cards, got ${await page.locator('.card').count()}`);
      const langCount = await page.locator('#language option').count();
      if (langCount < 2) problems.push(`[${label}] language select has ${langCount} options`);
      const version = await page.textContent('#version');
      const { version: expected } = JSON.parse(
        fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'),
      );
      if (version !== `v${expected}`)
        problems.push(`[${label}] version label is "${version}", expected "v${expected}"`);
      const rawKeys = await page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((e) => !e.children.length && /^[a-z]+_[A-Za-z0-9_]+$/.test(e.textContent.trim()))
          .map((e) => e.textContent.trim()),
      );
      for (const k of rawKeys) problems.push(`[${label}] untranslated key shown: ${k}`);
      await shot(page, `popup-default${sfx}`);

      // Segmented-control labels must stay on one line.
      const wrapped = await page.evaluate(() =>
        [...document.querySelectorAll('.seg button')]
          .filter(
            (b) =>
              b.offsetParent &&
              b.getBoundingClientRect().height > parseFloat(getComputedStyle(b).lineHeight) * 1.5 + 4,
          )
          .map((b) => b.textContent.trim()),
      );
      for (const w of wrapped) problems.push(`[${label}] segmented button wraps: ${w}`);

      // Enter on a focused card fires exactly one action with the right payload.
      await page.focus('#act-page');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      let msgs = await sent(page);
      if (
        msgs.length !== 1 ||
        msgs[0].type !== 'ps:generate' ||
        msgs[0].prep !== 'none' ||
        msgs[0].output !== 'download' ||
        !msgs[0].settings
      ) {
        problems.push(
          `[${label}] Enter on Full page sent ${JSON.stringify(msgs.map((m) => [m.type, m.prep, m.output]))}, expected one ps:generate none/download`,
        );
      }
      await clearSent(page);
      for (const [sel, expect] of [
        ['#act-article', ['ps:generate', 'article', 'download']],
        ['#act-select', ['ps:start-picker', 'print']],
        ['#act-remove', ['ps:start-picker', 'remove']],
      ]) {
        await page.click(sel);
        await page.waitForTimeout(100);
        msgs = await sent(page);
        const got =
          msgs.length === 1
            ? [msgs[0].type, msgs[0].prep ?? msgs[0].mode, msgs[0].output].filter((x) => x !== undefined)
            : msgs.map((m) => m.type);
        if (JSON.stringify(got) !== JSON.stringify(expect))
          problems.push(`[${label}] ${sel} sent ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`);
        await clearSent(page);
      }
      const errText = await page.textContent('#status');
      if (!errText.includes('stubbed in screenshot-ui'))
        problems.push(`[${label}] error from a failed action not shown in the status line ("${errText}")`);

      // Worst case for Chrome's 600px popup cap with the disclosure collapsed: reset link visible
      // and a long error in the status line.
      await page.evaluate(() => {
        document.getElementById('reset-label').textContent = 'Reset page (3)';
        document.getElementById('act-reset').classList.remove('hidden');
        const s = document.getElementById('status');
        s.className = 'status error';
        s.innerHTML =
          '<span>Could not attach to the tab: another debugger is already attached. Close DevTools and try again.</span>';
      });
      await page.setViewportSize({ width: 360, height: 600 });
      const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      if (docHeight > 600)
        problems.push(`[${label}] collapsed popup is ${docHeight}px high, over Chrome's 600px cap`);
      await shot(page, `popup-600px-collapsed${sfx}`, false);
      await page.setViewportSize({ width: 360, height: 700 });
      await page.evaluate(() => document.getElementById('act-reset').classList.add('hidden'));
      await resetStatus(page);

      // Expand the export settings; state is remembered in chrome.storage.local.
      await page.click('#toggle-advanced');
      if (
        (await page.getAttribute('#toggle-advanced', 'aria-expanded')) !== 'true' ||
        !(await page.isVisible('#advanced'))
      )
        problems.push(`[${label}] disclosure did not expand`);
      await page.waitForTimeout(100);
      const stored = await sw.evaluate(() => chrome.storage.local.get('popupExportSettingsOpen'));
      if (stored.popupExportSettingsOpen !== true)
        problems.push(`[${label}] expanded state not stored in chrome.storage.local`);
      await shot(page, `popup-expanded${sfx}`);

      // Footer stays visible (sticky) in a 600px popup with the settings expanded.
      await page.setViewportSize({ width: 360, height: 600 });
      const footBottom = await page.evaluate(
        () => document.querySelector('.foot').getBoundingClientRect().bottom,
      );
      if (footBottom > 600.5) problems.push(`[${label}] footer not visible in a 600px popup when expanded`);
      await shot(page, `popup-600px-expanded${sfx}`, false);
      await page.setViewportSize({ width: 360, height: 700 });

      // The summary line follows every change instantly.
      await page.selectOption('#format', 'Letter');
      if (!(await summary(page)).startsWith('Letter · Portrait'))
        problems.push(`[${label}] summary did not update for Letter: "${await summary(page)}"`);
      await page.click('.seg[data-key="orientation"] button[data-value="landscape"]');
      if (!(await summary(page)).includes('Landscape'))
        problems.push(`[${label}] summary did not update for landscape`);
      // Clicking the "Orientation" caption must not toggle the segmented control.
      await page.click('#orientation-label');
      if (
        (await page.getAttribute(
          '.seg[data-key="orientation"] button[data-value="landscape"]',
          'aria-pressed',
        )) !== 'true'
      )
        problems.push(`[${label}] clicking the Orientation caption changed the orientation`);
      await page.click('.seg[data-key="orientation"] button[data-value="portrait"]');
      await page.selectOption('#format', 'A4');
      await page.selectOption('#marginPreset', 'custom');
      await page.waitForSelector('#custom-margins:not(.hidden)');
      await page.fill('#m-left', '25');
      if (!(await summary(page)).includes('10/10/10/25 mm'))
        problems.push(`[${label}] summary did not update for custom margins: "${await summary(page)}"`);
      await page.check('#headerFooter');
      await page.uncheck('#hfUrl');
      await page.waitForSelector('#hf-options:not(.hidden)');
      const hfSummary = await summary(page);
      if (!hfSummary.includes('13/10/13/25 mm') || !hfSummary.includes('Header & footer'))
        problems.push(`[${label}] summary misses header/footer minimum margins: "${hfSummary}"`);
      await page.uncheck('#printBackground');
      if (!(await summary(page)).includes('Backgrounds off'))
        problems.push(`[${label}] summary did not update for backgrounds`);
      await page.check('#printBackground');
      await page.fill('#pageRanges', '1-3');
      if (!(await summary(page)).includes('Pages 1-3'))
        problems.push(`[${label}] summary misses page ranges`);
      await shot(page, `popup-custom-margins-hf${sfx}`);

      // Single page layout: page-ranges group must hide (and leave the summary).
      await page.click('.seg[data-key="layout"] button[data-value="single"]');
      if (await page.isVisible('#ranges-row'))
        problems.push(`[${label}] ranges row still visible in single-page layout`);
      if ((await summary(page)).includes('Pages'))
        problems.push(`[${label}] summary still lists page ranges in single-page layout`);
      if (
        (await page.getAttribute('.seg[data-key="layout"] button[data-value="single"]', 'aria-pressed')) !==
        'true'
      )
        problems.push(`[${label}] aria-pressed not set on Single page`);
      await shot(page, `popup-single${sfx}`);

      // Fixed layout width: scale slider hidden, summary shows the width.
      await page.click('.seg[data-key="layout"] button[data-value="paged"]');
      await page.fill('#pageRanges', '');
      await page.selectOption('#marginPreset', 'default');
      await page.uncheck('#headerFooter');
      await page.selectOption('#layoutWidth', '1280');
      if (await page.isVisible('#scale'))
        problems.push(`[${label}] scale slider visible for layout width 1280`);
      if (!(await summary(page)).includes('1280 px layout'))
        problems.push(`[${label}] summary misses layout width`);
      if (!(await page.isVisible('#ranges-row')))
        problems.push(`[${label}] ranges row hidden in paged layout`);
      await shot(page, `popup-layout-1280${sfx}`);
      await page.selectOption('#layoutWidth', 'auto');
      if (!(await page.isVisible('#scale')))
        problems.push(`[${label}] scale slider hidden for auto layout width`);
      if ((await summary(page)) !== DEFAULT_SUMMARY)
        problems.push(`[${label}] summary did not return to default: "${await summary(page)}"`);

      // Focus rings on the riskier controls.
      await page.focus('#act-article');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await shot(page, `popup-focus-card${sfx}`, false);
      await page.focus('.seg[data-key="layout"] button[data-value="single"]');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await shot(page, `popup-focus-seg${sfx}`, false);
      await page.focus('#hfDate').catch(() => {});

      // Status line: success and busy.
      await page.evaluate(() => {
        const s = document.getElementById('status');
        s.className = 'status ok';
        s.textContent = 'Saved Example article – example.com.pdf';
      });
      await shot(page, `popup-status-ok${sfx}`, false);
      await page.evaluate(() => {
        const s = document.getElementById('status');
        s.className = 'status';
        s.innerHTML = '<span class="spinner"></span><span>Rendering PDF…</span>';
      });
      await shot(page, `popup-status-busy${sfx}`, false);
      await resetStatus(page);

      // Layout sanity: nothing may overflow the 360px popup horizontally.
      const overflow = await page.evaluate(() => {
        const out = [];
        const vw = document.documentElement.clientWidth;
        if (document.documentElement.scrollWidth > vw)
          out.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
        for (const el of document.querySelectorAll('button, select, input, label')) {
          if (el.closest('dialog')) continue;
          const r = el.getBoundingClientRect();
          if (r.width && (r.right > vw + 0.5 || r.left < -0.5))
            out.push(
              `${el.tagName}#${el.id || el.textContent.trim().slice(0, 20)} spans ${r.left}-${r.right}`,
            );
          if (el.matches('button') && el.scrollWidth > el.clientWidth + 1)
            out.push(`button text clipped: ${el.textContent.trim()}`);
        }
        return out;
      });
      for (const o of overflow) problems.push(`[${label}] overflow: ${o}`);

      // Windows/Linux popups get a ~15px classic scrollbar once the form exceeds 600px; headless
      // hides scrollbars, so simulate the narrower content box and check nothing wraps or clips.
      const narrow = await page.evaluate(() => {
        document.body.style.width = '345px';
        const out = [];
        for (const b of document.querySelectorAll('.seg button, .ghost, .foot-link, .card-title')) {
          if (b.offsetParent && b.scrollWidth > b.clientWidth + 1) out.push(b.textContent.trim());
        }
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth)
          out.push('horizontal overflow');
        document.body.style.width = '';
        return out;
      });
      for (const n of narrow) problems.push(`[${label}] at 345px (with scrollbar) clipped/wrapped: ${n}`);

      // Accessible names: every button must have one.
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll('button')]
          .filter(
            (b) =>
              !(b.getAttribute('aria-label') || b.textContent.trim() || b.getAttribute('aria-labelledby')),
          )
          .map((b) => b.outerHTML.slice(0, 80)),
      );
      for (const u of unnamed) problems.push(`[${label}] button without accessible name: ${u}`);

      // Help panel.
      await page.click('#btn-help');
      if (!(await page.evaluate(() => document.getElementById('help').open)))
        problems.push(`[${label}] help dialog did not open`);
      await shot(page, `popup-help${sfx}`, false);
      await page.keyboard.press('Escape');
      if (await page.evaluate(() => document.getElementById('help').open))
        problems.push(`[${label}] Esc did not close the help dialog`);

      // Theme toggle cycles system -> light -> dark -> system and sets data-theme on <html>.
      const themeAttr = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if ((await themeAttr()) !== null) problems.push(`[${label}] data-theme set for the system theme`);
      await page.click('#theme-toggle');
      if ((await themeAttr()) !== 'light')
        problems.push(`[${label}] first theme toggle gave ${await themeAttr()}, expected light`);
      await page.click('#theme-toggle');
      if ((await themeAttr()) !== 'dark')
        problems.push(`[${label}] second theme toggle gave ${await themeAttr()}, expected dark`);
      if ((await page.getAttribute('#theme-toggle', 'aria-label')) !== 'Theme: Dark')
        problems.push(`[${label}] theme toggle label not updated`);
      await page.waitForTimeout(300); // debounced save
      const savedTheme = await sw.evaluate(() =>
        chrome.storage.sync.get('settings').then((r) => r.settings && r.settings.theme),
      );
      if (savedTheme !== 'dark') problems.push(`[${label}] theme not saved (got ${savedTheme})`);
      await page.click('#theme-toggle');
      if ((await themeAttr()) !== null)
        problems.push(`[${label}] third theme toggle did not return to system`);
      await page.waitForTimeout(300);
      await page.close();

      // Reopen: the expanded state is remembered; forcing the opposite theme overrides the OS.
      await sw.evaluate(
        (t) =>
          chrome.storage.sync
            .get('settings')
            .then((r) => chrome.storage.sync.set({ settings: { ...(r.settings || {}), theme: t } })),
        other,
      );
      page = await openPopup(label, colorScheme);
      if ((await page.getAttribute('#toggle-advanced', 'aria-expanded')) !== 'true')
        problems.push(`[${label}] expanded state not restored on reopen`);
      const forced = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (forced !== other)
        problems.push(`[${label}] forced ${other} theme not applied on open (got ${forced})`);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const isDarkBg = (c) => {
        const [r, g, b] = c.match(/\d+/g).map(Number);
        return r + g + b < 200;
      };
      if (isDarkBg(bg) !== (other === 'dark'))
        problems.push(`[${label}] forced ${other} theme has background ${bg}`);
      await page.click('#toggle-advanced'); // collapse again for the shot
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250); // chevron transition
      await shot(page, `popup-forced-${other}-on-${colorScheme}-os`);
      await page.close();

      // Experimental Markdown action appears only when the flag is on.
      await sw.evaluate(() => chrome.storage.sync.set({ settings: { markdownEnabled: true } }));
      page = await openPopup(`${label}-markdown`, colorScheme);
      if (!(await page.isVisible('#md-row')))
        problems.push(`[${label}] Markdown action hidden although markdownEnabled is true`);
      await page.click('#md-article');
      await page.waitForTimeout(100);
      msgs = await sent(page);
      if (msgs.length !== 1 || msgs[0].type !== 'ps:export-markdown' || msgs[0].prep !== 'article')
        problems.push(`[${label}] Markdown article sent ${JSON.stringify(msgs)}`);
      await resetStatus(page);
      await page.setViewportSize({ width: 360, height: 600 });
      const mdHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      if (mdHeight > 600) problems.push(`[${label}] popup with Markdown row is ${mdHeight}px high`);
      await page.setViewportSize({ width: 360, height: 700 });
      await shot(page, `popup-markdown${sfx}`);
      await page.close();
      await sw.evaluate(() => Promise.all([chrome.storage.sync.clear(), chrome.storage.local.clear()]));
    }

    // --- options ---------------------------------------------------------------------------
    {
      const label = `options${sfx}`;
      const page = await openPage(`${base}/options/options.html`, {
        width: 720,
        height: 900,
        colorScheme,
        label,
      });
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-boot'));
      for (const sel of [
        '#theme',
        '#language',
        '#filenameTemplate',
        '#saveAs',
        '#expandScroll',
        '#preferCssPageSize',
        '#open-shortcuts',
        '#markdownEnabled',
      ]) {
        if (!(await page.isVisible(sel))) problems.push(`[${label}] ${sel} missing`);
      }
      if ((await page.locator('#output').count()) !== 0)
        problems.push(`[${label}] options page still has the Default action select`);
      await shot(page, `options${sfx}`);
      await page.focus('#open-shortcuts');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await shot(page, `options-focus${sfx}`, false);

      // Markdown: turning it on needs the inline confirmation; Cancel keeps it off.
      const mdSaved = () =>
        sw.evaluate(() =>
          chrome.storage.sync.get('settings').then((r) => !!(r.settings && r.settings.markdownEnabled)),
        );
      await page.click('#markdownEnabled');
      if (!(await page.isVisible('#markdown-confirm')))
        problems.push(`[${label}] Markdown confirmation not shown`);
      if (await page.isChecked('#markdownEnabled'))
        problems.push(`[${label}] Markdown checkbox checked before confirmation`);
      await page.locator('#markdown-confirm').scrollIntoViewIfNeeded();
      await shot(page, `options-markdown-confirm${sfx}`, false);
      await page.click('#markdown-cancel');
      if ((await page.isVisible('#markdown-confirm')) || (await mdSaved()))
        problems.push(`[${label}] Cancel did not keep Markdown off`);
      await page.click('#markdownEnabled');
      await page.click('#markdown-enable');
      await page.waitForTimeout(100);
      if (!(await mdSaved()) || !(await page.isChecked('#markdownEnabled')))
        problems.push(`[${label}] Enable did not turn Markdown on`);
      await page.click('#markdownEnabled'); // off: no confirmation needed
      await page.waitForTimeout(100);
      if ((await mdSaved()) || (await page.isVisible('#markdown-confirm')))
        problems.push(`[${label}] turning Markdown off failed or asked for confirmation`);

      // Theme select applies immediately.
      await page.selectOption('#theme', other);
      if ((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) !== other)
        problems.push(`[${label}] theme select did not apply ${other}`);
      await shot(page, `options-forced-${other}-on-${colorScheme}-os`);
      await page.selectOption('#theme', 'system');
      await page.close();
      await sw.evaluate(() => Promise.all([chrome.storage.sync.clear(), chrome.storage.local.clear()]));
    }

    // --- viewer ----------------------------------------------------------------------------
    {
      const page = await openPage(`${base}/viewer/viewer.html`, {
        width: 1100,
        height: 700,
        colorScheme,
        label: `viewer-error${sfx}`,
      });
      if (/preview/i.test(await page.evaluate(() => `${document.title} ${document.body.innerText}`)))
        problems.push(`[viewer-error${sfx}] viewer text mentions "preview"`);
      await shot(page, `viewer-error${sfx}`, false);
      await page.close();
    }
    if (viewerStub) {
      const page = await openPage(`${base}/viewer/viewer.html?job=demo`, {
        width: 1100,
        height: 700,
        colorScheme,
        label: `viewer${sfx}`,
        init: viewerStub,
      });
      await page.waitForFunction(() => !document.getElementById('btn-download').disabled);
      if (/preview/i.test(await page.evaluate(() => `${document.title} ${document.body.innerText}`)))
        problems.push(`[viewer${sfx}] viewer text mentions "preview"`);
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
