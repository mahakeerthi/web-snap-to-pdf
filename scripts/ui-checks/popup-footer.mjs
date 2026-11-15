// The popup footer (Help, Shortcuts, language select, version) must fit its row in every language.
// Translations differ a lot in length: the Japanese "Shortcuts" label alone pushed the version
// label past the popup edge. This opens the real popup once per language at 360 px (Chrome's popup
// width) and at 345 px (the width left by a classic 15 px scrollbar on Windows and Linux), and
// checks that the row does not scroll and that each of its items sits inside the row.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const WIDTHS = [360, 345];
const ITEMS = ['#btn-help', '#btn-shortcuts', '.lang', '#version'];

export async function checkPopupFooter({ context, sw, extDir, problems }) {
  const { SUPPORTED_LANGUAGES } = await import(pathToFileURL(path.join(extDir, 'src/lib/i18n.js')).href);
  const extensionId = new URL(sw.url()).host;
  const results = [];

  for (const { code } of SUPPORTED_LANGUAGES.filter((l) => l.code !== 'auto')) {
    await sw.evaluate((language) => chrome.storage.sync.set({ settings: { language } }), code);
    const page = await context.newPage();
    const label = `popup-footer-${code}`;
    try {
      await page.setViewportSize({ width: 360, height: 700 });
      await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-boot'));
      await page.evaluate(() => document.fonts.ready);

      const lang = await page.evaluate(() => document.documentElement.lang);
      if (lang !== code.replace('_', '-'))
        problems.push(`[${label}] popup language is "${lang}", expected ${code.replace('_', '-')}`);

      for (const width of WIDTHS) {
        await page.evaluate((w) => (document.body.style.width = `${w}px`), width);
        const found = await page.evaluate((items) => {
          const row = document.querySelector('.foot-row');
          const rowBox = row.getBoundingClientRect();
          const out = { missing: [], overflow: [], scrolls: row.scrollWidth > row.clientWidth };
          for (const sel of items) {
            const el = document.querySelector(sel);
            if (!el || !el.getClientRects().length) {
              out.missing.push(sel);
              continue;
            }
            const r = el.getBoundingClientRect();
            // The Help link starts 4 px left of the row on purpose, so only its right edge is bound.
            if (r.left < -0.5 || r.right > rowBox.right + 0.5)
              out.overflow.push(`${sel} spans ${r.left.toFixed(1)}-${r.right.toFixed(1)}`);
          }
          out.rowRight = rowBox.right;
          out.versionText = document.querySelector('#version').textContent;
          return out;
        }, ITEMS);
        for (const sel of found.missing) problems.push(`[${label}] ${sel} not found or not visible`);
        for (const o of found.overflow)
          problems.push(`[${label}] at ${width}px ${o}, row ends at ${found.rowRight.toFixed(1)}`);
        if (found.scrolls) problems.push(`[${label}] at ${width}px the footer row scrolls sideways`);
        results.push({ code, width, ok: !found.missing.length && !found.overflow.length && !found.scrolls });
      }
    } finally {
      await page.close();
    }
  }
  await sw.evaluate(() => chrome.storage.sync.clear());
  console.log(
    `popup footer fits: ${results.filter((r) => r.ok).length} of ${results.length} language/width cases`,
  );
}
