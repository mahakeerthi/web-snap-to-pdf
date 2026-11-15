// Builds the Chrome Web Store images in docs/store/images/: five 1280 x 800 screenshots and a
// 440 x 280 promo tile. The extension UI in them is the real thing. The script loads the unpacked
// extension through test/harness.mjs, opens the demo page test/fixtures/store/trail-guide.html,
// opens the real popup, the real preview overlay and the real element picker, and exports a real
// PDF whose first page it renders with pdftoppm (poppler, `brew install poppler`). A plain page of
// HTML then lays each capture under a caption band, in the same browser, and saves it.
// A native <select> menu is not part of a page screenshot, so screenshot 1 draws the open Format
// list itself from the options the real select holds.
// Run with: node scripts/store-images/build.mjs [--sheet <file.png>]
// --sheet also writes a contact sheet of every image to that path, outside the repository.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension, tabIdForUrl, waitForDownload } from '../../test/harness.mjs';
import { inspectPng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'docs/store/images');
const sheetArg = process.argv.indexOf('--sheet');
const sheetFile = sheetArg > 0 ? path.resolve(process.argv[sheetArg + 1]) : null;

const WIDTH = 1280;
const HEIGHT = 800;
const BAND = 88;
const AREA = HEIGHT - BAND;
const TOOLBAR = 40;
const FIXTURE = 'store/trail-guide.html';
const FAKE_ADDRESS = 'lanterntrails.example/quiet-coast';

const iconSvg = fs.readFileSync(path.join(root, 'extension/icons/icon.svg'), 'utf8');
const asDataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;

const FONT = `-apple-system, 'Segoe UI', system-ui, Roboto, sans-serif`;
const BASE_CSS = `
  html, body { margin: 0; padding: 0; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; position: relative; overflow: hidden; font-family: ${FONT}; }
  .band { position: absolute; left: 0; top: 0; width: ${WIDTH}px; height: ${BAND}px; display: flex; align-items: center; gap: 18px;
    padding: 0 40px; box-sizing: border-box; background: #111827; color: #fff; }
  .band svg { width: 46px; height: 46px; flex: none; }
  .band .caption { flex: 1; font-size: 36px; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
  .band .brand { font-size: 18px; font-weight: 600; color: #9ca3af; }
  .area { position: absolute; left: 0; top: ${BAND}px; width: ${WIDTH}px; height: ${AREA}px; overflow: hidden; }
  .area > img.full { display: block; width: ${WIDTH}px; height: ${AREA}px; }
  .shadow { box-shadow: 0 18px 48px rgba(15, 23, 42, 0.28), 0 0 0 1px rgba(15, 23, 42, 0.14); }
`;

function stageHtml(caption, body, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${extraCss}</style></head><body>
    <div class="band">${iconSvg}<span class="caption">${caption}</span><span class="brand">WebPage to PDF</span></div>
    <div class="area">${body}</div>
  </body></html>`;
}

const SHOTS = {};

async function waitForPreview(page) {
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-websnap-ui="preview"]');
      const canvases = host ? [...host.shadowRoot.querySelectorAll('.stage canvas')] : [];
      return canvases.length > 0 && canvases.every((c) => c.dataset.ready);
    },
    null,
    { timeout: 30000 },
  );
  await page.setViewportSize({ width: WIDTH, height: AREA });
  await page.mouse.move(0, AREA - 1);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(400);
}

async function openFixture(context, base, { colorScheme = 'light', height = AREA } = {}) {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize({ width: WIDTH, height });
  await page.goto(`${base}/${FIXTURE}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function startPagePreview(sw, base, page) {
  const tabId = await tabIdForUrl(sw, `${base}/${FIXTURE}`);
  await sw.evaluate((id) => globalThis.__websnap.command('save-pdf', id), tabId);
  await waitForPreview(page);
}

// The popup opens as a background tab in the fixture's window, as the toolbar popup would see the
// active tab, so it reads the real page state and title.
async function popupShot(context, sw, extensionId, fixturePage, { colorScheme, height }) {
  await fixturePage.bringToFront();
  const tab = await sw.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
  );
  const url = `chrome-extension://${extensionId}/src/popup/popup.html`;
  const opened = context.waitForEvent('page');
  await sw.evaluate(({ url, windowId }) => chrome.tabs.create({ url, windowId, active: false }), {
    url,
    windowId: tab.windowId,
  });
  const popup = await opened;
  try {
    await popup.emulateMedia({ colorScheme });
    await popup.setViewportSize({ width: 360, height: height ?? 700 });
    await popup.waitForSelector('body[data-state="ready"]', { timeout: 10000 });
    await popup.waitForFunction(() => !document.documentElement.hasAttribute('data-boot'));
    await popup.evaluate(() => document.fonts.ready);
    if (!height) {
      const fit = await popup.evaluate(() =>
        Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height)),
      );
      await popup.setViewportSize({ width: 360, height: fit });
    }
    await popup.mouse.move(0, 0);
    await popup.waitForTimeout(350);
    return await popup.screenshot();
  } finally {
    await popup.close();
  }
}

async function drawFormatMenu(page) {
  await page.evaluate(() => {
    const shadow = document.querySelector('[data-websnap-ui="preview"]').shadowRoot;
    const select = shadow.querySelector('select.format');
    const box = select.getBoundingClientRect();
    select.focus();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'listbox');
    Object.assign(menu.style, {
      position: 'fixed',
      left: `${box.left - 4}px`,
      top: `${box.bottom + 6}px`,
      minWidth: `${box.width + 8}px`,
      padding: '6px',
      boxSizing: 'border-box',
      background: '#ffffff',
      border: '1px solid rgba(15, 23, 42, 0.16)',
      borderRadius: '10px',
      boxShadow: '0 14px 34px rgba(15, 23, 42, 0.24)',
      font: `600 13px/1.3 ${getComputedStyle(select).fontFamily}`,
      color: '#0f172a',
      zIndex: '2147483647',
    });
    [...select.options].forEach((option, index) => {
      const item = document.createElement('div');
      item.textContent = option.textContent;
      Object.assign(item.style, {
        padding: '7px 12px',
        borderRadius: '6px',
        background: index === select.selectedIndex ? '#2563eb' : 'transparent',
        color: index === select.selectedIndex ? '#ffffff' : '#0f172a',
      });
      menu.append(item);
    });
    shadow.append(menu);
  });
  await page.waitForTimeout(150);
}

function renderPdfFirstPage(pdfFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websnap-store-pdf-'));
  try {
    execFileSync('pdftoppm', [
      '-png',
      '-r',
      '150',
      '-f',
      '1',
      '-l',
      '1',
      '-singlefile',
      pdfFile,
      path.join(dir, 'page'),
    ]);
    return fs.readFileSync(path.join(dir, 'page.png'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const resetStorage = (sw) =>
  sw.evaluate(() => Promise.all([chrome.storage.sync.clear(), chrome.storage.local.clear()]));

async function captureAll({ sw, context, extensionId, base }) {
  {
    await resetStorage(sw);

    {
      const page = await openFixture(context, base, { height: AREA - TOOLBAR });
      SHOTS.pageBackground = await page.screenshot();
      SHOTS.popupLight = await popupShot(context, sw, extensionId, page, { colorScheme: 'light' });
      await sw.evaluate(() => chrome.storage.local.set({ popupExportSettingsOpen: true }));
      SHOTS.popupExpanded = await popupShot(context, sw, extensionId, page, {
        colorScheme: 'light',
        height: 600,
      });
      await resetStorage(sw);
      await page.close();
    }

    {
      const page = await openFixture(context, base);
      await startPagePreview(sw, base, page);
      await drawFormatMenu(page);
      SHOTS.previewMenu = await page.screenshot();
      await page.close();
    }

    {
      const page = await openFixture(context, base);
      await startPagePreview(sw, base, page);
      await page.locator('.download').click();
      const item = await waitForDownload(sw, (i) => /\.pdf$/i.test(i.filename));
      SHOTS.pdfPage = renderPdfFirstPage(item.filename);
      await page.close();
    }

    {
      const page = await openFixture(context, base);
      await page.evaluate(() =>
        document.querySelector('#route-chart').scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      const tabId = await tabIdForUrl(sw, `${base}/${FIXTURE}`);
      const started = await sw.evaluate((id) => globalThis.__websnap.startPicker(id, 'print'), tabId);
      if (!started || !started.ok) throw new Error(`picker did not start: ${JSON.stringify(started)}`);
      const point = await page.evaluate(() => {
        const box = document.querySelector('#route-chart').getBoundingClientRect();
        return { x: box.left + 8, y: box.top + box.height * 0.5 };
      });
      await page.mouse.move(point.x - 60, point.y - 20);
      await page.mouse.move(point.x, point.y, { steps: 6 });
      await page.waitForTimeout(500);
      SHOTS.picker = await page.screenshot();
      await page.keyboard.press('Escape');
      await page.close();
    }

    {
      await sw.evaluate(() => chrome.storage.sync.set({ settings: { theme: 'dark' } }));
      const page = await openFixture(context, base, { colorScheme: 'dark' });
      await startPagePreview(sw, base, page);
      SHOTS.previewDark = await page.screenshot();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-websnap-ui="preview"]'));
      SHOTS.popupDark = await popupShot(context, sw, extensionId, page, { colorScheme: 'dark' });
      await page.close();
      await resetStorage(sw);
    }
  }
}

const css = String.raw;

const LAYOUTS = {
  '1-preview-format-menu.png': {
    caption: 'See it first, then pick PDF, PNG or JPEG',
    body: () => `<img class="full" src="${asDataUrl(SHOTS.previewMenu)}">`,
  },
  '2-three-ways-to-save.png': {
    caption: 'Save the page, the article or one part',
    css: css`
      .toolbar {
        position: absolute;
        left: 0;
        top: 0;
        width: ${WIDTH}px;
        height: ${TOOLBAR}px;
        background: #e8ebef;
        border-bottom: 1px solid #cfd5dc;
      }
      .dots {
        position: absolute;
        left: 16px;
        top: 14px;
        display: flex;
        gap: 8px;
      }
      .dots i {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #c3c9d1;
      }
      .address {
        position: absolute;
        left: 120px;
        right: 240px;
        top: 7px;
        height: 26px;
        border-radius: 13px;
        background: #fff;
        color: #4b5563;
        font-size: 13px;
        line-height: 26px;
        padding: 0 14px;
      }
      .ext {
        position: absolute;
        right: 28px;
        top: 6px;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.1);
        display: grid;
        place-items: center;
      }
      .ext svg {
        width: 20px;
        height: 20px;
      }
      .page {
        position: absolute;
        left: 0;
        top: ${TOOLBAR}px;
        width: ${WIDTH}px;
        height: ${AREA - TOOLBAR}px;
      }
      .popup {
        position: absolute;
        right: 16px;
        top: ${TOOLBAR + 6}px;
        width: 360px;
        border-radius: 12px;
        overflow: hidden;
      }
      .popup img {
        display: block;
        width: 360px;
      }
    `,
    body: () => `
      <div class="toolbar"><div class="dots"><i></i><i></i><i></i></div><div class="address">${FAKE_ADDRESS}</div><div class="ext">${iconSvg}</div></div>
      <img class="page" src="${asDataUrl(SHOTS.pageBackground)}">
      <div class="popup shadow"><img src="${asDataUrl(SHOTS.popupLight)}"></div>`,
  },
  '3-select-one-part.png': {
    caption: 'Click any part of a page to save just that',
    body: () => `<img class="full" src="${asDataUrl(SHOTS.picker)}">`,
  },
  '4-export-settings.png': {
    caption: 'Choose paper, margins and layout',
    css: css`
      .area {
        background: linear-gradient(135deg, #eaeff4, #d9e1e9);
      }
      .popup {
        position: absolute;
        left: 200px;
        top: 56px;
        width: 360px;
        height: 600px;
        border-radius: 12px;
        overflow: hidden;
      }
      .popup img {
        display: block;
        width: 360px;
        height: 600px;
      }
      .paper {
        position: absolute;
        left: 640px;
        top: 36px;
        height: 640px;
        background: #fff;
      }
      .paper img {
        display: block;
        height: 640px;
      }
    `,
    body: () => `
      <div class="popup shadow"><img src="${asDataUrl(SHOTS.popupExpanded)}"></div>
      <div class="paper shadow"><img src="${asDataUrl(SHOTS.pdfPage)}"></div>`,
  },
  '5-dark-mode.png': {
    caption: 'Follows your light or dark theme',
    css: css`
      .area {
        background: radial-gradient(circle at 30% 20%, #16213a, #0a0f1c 70%);
      }
      .preview {
        position: absolute;
        left: 40px;
        top: 133px;
        width: 800px;
        height: 445px;
        border-radius: 10px;
        overflow: hidden;
      }
      .preview img {
        display: block;
        width: 800px;
        height: 445px;
      }
      .popup {
        position: absolute;
        left: 880px;
        width: 360px;
        border-radius: 12px;
        overflow: hidden;
      }
      .popup img {
        display: block;
        width: 360px;
      }
    `,
    body: () => `
      <div class="preview shadow"><img src="${asDataUrl(SHOTS.previewDark)}"></div>
      <div class="popup shadow" id="popup-dark" style="top: 106px"><img src="${asDataUrl(SHOTS.popupDark)}"></div>`,
  },
};

const TILE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; }
  body { width: 440px; height: 280px; position: relative; overflow: hidden; font-family: ${FONT};
    background: linear-gradient(135deg, #ffffff 0%, #fee2e2 100%); }
  .icon { position: absolute; left: 30px; top: 30px; width: 76px; height: 76px; }
  .icon svg { width: 100%; height: 100%; }
  h1 { position: absolute; left: 30px; top: 124px; margin: 0; font-size: 33px; line-height: 1.1; font-weight: 800; color: #111827; letter-spacing: -0.02em; }
  p { position: absolute; left: 30px; top: 172px; width: 250px; margin: 0; font-size: 16px; line-height: 1.4; color: #4b5563; text-wrap: balance; }
  .paper { position: absolute; right: -14px; bottom: -34px; width: 170px; height: 220px; transform: rotate(8deg); border-radius: 10px; background: #fff;
    box-shadow: 0 14px 30px rgba(127, 29, 29, 0.25), 0 0 0 1px rgba(127, 29, 29, 0.12); overflow: hidden; }
  .paper::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 12px; background: #ef4444; }
  .paper::after { content: ''; position: absolute; left: 18px; right: 18px; top: 34px; bottom: 30px;
    background: repeating-linear-gradient(180deg, #e5e7eb 0 8px, transparent 8px 20px); }
</style></head><body>
  <div class="paper"></div>
  <div class="icon">${iconSvg}</div>
  <h1>WebPage to PDF</h1>
  <p>Preview any page, then save it as PDF, PNG or JPEG. All on your device.</p>
</body></html>`;

async function compose(context) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, file));
  const stage = await context.newPage();
  const written = [];
  const save = async (name, width, height) => {
    await stage.evaluate(() => document.fonts.ready);
    const file = path.join(outDir, name);
    fs.writeFileSync(file, await stage.screenshot({ scale: 'css' }));
    const info = inspectPng(file);
    if (info.width !== width || info.height !== height || info.hasAlphaType || !info.pixelBytesMatchRgb)
      throw new Error(
        `${name} is ${info.width} x ${info.height} ${info.colorName}, expected ${width} x ${height} RGB`,
      );
    written.push(file);
  };

  await stage.setViewportSize({ width: WIDTH, height: HEIGHT });
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    await stage.setContent(stageHtml(layout.caption, layout.body(), layout.css ?? ''));
    if (name.startsWith('5-')) {
      const popupHeight = await stage.evaluate(
        () => document.querySelector('#popup-dark').getBoundingClientRect().height,
      );
      await stage.evaluate((h) => {
        document.querySelector('#popup-dark').style.top = `${Math.round((712 - h) / 2)}px`;
      }, popupHeight);
    }
    await save(name, WIDTH, HEIGHT);
  }

  await stage.setViewportSize({ width: 440, height: 280 });
  await stage.setContent(TILE_HTML);
  await save('promo-tile-440x280.png', 440, 280);

  if (sheetFile) {
    const cells = written
      .map((file) => {
        const label = path.basename(file);
        return `<figure><img src="${asDataUrl(fs.readFileSync(file))}"><figcaption>${label}</figcaption></figure>`;
      })
      .join('');
    await stage.setViewportSize({ width: 2000, height: 1000 });
    await stage.setContent(`<!doctype html><meta charset="utf-8"><style>
      body { margin: 0; padding: 20px; width: 1960px; background: #1f2937; font-family: ${FONT}; color: #e5e7eb; }
      .grid { display: grid; grid-template-columns: repeat(3, 640px); gap: 20px; align-items: start; }
      figure { margin: 0; } img { display: block; max-width: 640px; border: 1px solid #374151; }
      figcaption { padding: 6px 2px; font-size: 14px; }
    </style><div class="grid">${cells}</div>`);
    const gridHeight = await stage.evaluate(() => document.body.scrollHeight);
    await stage.setViewportSize({ width: 2000, height: gridHeight });
    fs.mkdirSync(path.dirname(sheetFile), { recursive: true });
    fs.writeFileSync(sheetFile, await stage.screenshot({ scale: 'css' }));
    console.log(`  sheet ${sheetFile}`);
  }
  await stage.close();
  for (const file of written) console.log(`  ${path.relative(root, file)}`);
}

const browser = await launchExtension({ viewport: { width: WIDTH, height: AREA }, deviceScaleFactor: 2 });
let failed = false;
try {
  await captureAll(browser);
  await compose(browser.context);
} catch (err) {
  failed = true;
  console.error(err && err.stack ? err.stack : err);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
