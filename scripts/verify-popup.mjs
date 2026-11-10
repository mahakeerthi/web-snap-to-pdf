#!/usr/bin/env node
// Drives the real popup, picker, preview overlay and options page of the extension the way a user
// does, and keeps proof of each journey. See .claude/skills/verify-web-snap-pdf/SKILL.md.
//   node scripts/verify-popup.mjs doctor
//   node scripts/verify-popup.mjs drive <full-page|article|select-element-png|remove-reset|markdown|all>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchExtension, tabIdForUrl } from '../test/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 1200, height: 800 };
const POPUP_VIEWPORT = { width: 360, height: 640 };
const MARKS = ['ARTICLE-MARK', 'SIDEBAR-MARK', 'FIXED-HEADER-MARK', 'FOOTER-MARK'];

async function openFixture(ctx, file) {
  const url = `${ctx.base}/${file}`;
  const page = await ctx.context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.bringToFront();
  const tabId = await tabIdForUrl(ctx.sw, url);
  const tab = await ctx.sw.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    return { id: t.id, windowId: t.windowId, title: t.title };
  }, tabId);
  return { page, tab };
}

// The toolbar popup cannot be opened by automation, so popup.html is opened as a background tab in
// the fixture's window: popup.js then resolves the fixture as the active tab, as in the real popup.
async function openPopup(ctx, fixture) {
  const url = `chrome-extension://${ctx.extensionId}/src/popup/popup.html`;
  await fixture.page.bringToFront();
  const [popup] = await Promise.all([
    ctx.context.waitForEvent('page', { predicate: (p) => p.url() === url, timeout: 10000 }),
    ctx.sw.evaluate(({ url, windowId }) => chrome.tabs.create({ url, windowId, active: false }), {
      url,
      windowId: fixture.tab.windowId,
    }),
  ]);
  await popup.setViewportSize(POPUP_VIEWPORT);
  await popup.waitForSelector('body[data-state]', { timeout: 10000 });
  await popup.waitForFunction(() => !document.documentElement.hasAttribute('data-boot'));
  const state = await popup.getAttribute('body', 'data-state');
  const title = (await popup.textContent('#page-title')).trim();
  ctx.check(state === 'ready', 'popup reports the fixture as printable', `body[data-state]=${state}`);
  ctx.check(title === fixture.tab.title, 'popup targets the fixture tab', `#page-title="${title}"`);
  if (state !== 'ready' || title !== fixture.tab.title) throw new Error('popup is not driving the fixture');
  return popup;
}

async function click(ctx, page, selector) {
  await page.click(selector);
  ctx.controls.push(selector);
}

const downloadIds = (ctx) =>
  ctx.sw.evaluate(async () => (await chrome.downloads.search({})).map((d) => d.id));

// Resolves with the first download that started after `before` (ids from downloadIds) and completed.
async function waitForNewDownload(ctx, before, timeoutMs = 45000) {
  const seen = new Set(before);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = await ctx.sw.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'] }));
    const fresh = items.filter((d) => !seen.has(d.id));
    const failed = fresh.find((d) => d.state === 'interrupted');
    if (failed) throw new Error(`download interrupted: ${failed.error} (${failed.filename})`);
    const done = fresh.find((d) => d.state === 'complete');
    if (done) return done;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no new download completed within ${timeoutMs} ms`);
}

// Copies the downloaded file into the evidence dir before close() deletes the download dir.
function keepDownload(ctx, item, label) {
  const inDownloadDir = fs.realpathSync(path.dirname(item.filename)) === fs.realpathSync(ctx.downloadDir);
  ctx.check(inDownloadDir, `${label}: saved in the profile's download dir`, item.filename);
  const file = path.join(ctx.dir, path.basename(item.filename));
  fs.copyFileSync(item.filename, file);
  const record = { label, filename: path.basename(item.filename), bytes: fs.statSync(file).size };
  ctx.downloads.push(record);
  return { file, record };
}

function inspectPdf(ctx, file, record) {
  const isPdf = fs.readFileSync(file).subarray(0, 5).toString() === '%PDF-';
  ctx.check(isPdf, `${record.label}: file is a PDF`, record.filename);
  if (!isPdf) return '';
  const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  record.pdf = {
    pages: Number(/Pages:\s+(\d+)/.exec(info)?.[1] || 0),
    pageSize: /Page size:\s+(.+)/.exec(info)?.[1].trim(),
  };
  const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  record.marks = marksIn(text);
  ctx.check(record.pdf.pages >= 1, `${record.label}: pdfinfo reports pages`, `${record.pdf.pages} pages`);
  return text;
}

function marksIn(text) {
  return {
    found: MARKS.filter((m) => text.includes(m)),
    absent: MARKS.filter((m) => !text.includes(m)),
  };
}

function expectMarks(ctx, record, { present = [], absent = [] }) {
  for (const m of present) ctx.check(record.marks.found.includes(m), `${record.label}: ${m} present`);
  for (const m of absent) ctx.check(record.marks.absent.includes(m), `${record.label}: ${m} absent`);
}

function imageSize(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { type: 'jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return { type: 'unknown' };
}

async function shot(ctx, page, name) {
  const file = path.join(ctx.dir, name);
  await page.screenshot({ path: file });
  ctx.screenshots.push(name);
}

// Popup status after a popup export. Only meaningful for the first export of a popup: later
// exports in the same popup start from the previous "Saved" line.
async function expectSavedStatus(ctx, popup, filename) {
  await popup.waitForSelector('#status.ok', { timeout: 10000 }).catch(() => {});
  const status = (await popup.textContent('#status')).trim();
  ctx.check(status.includes(filename), 'popup status names the saved file', status);
}

const label = (ctx, key) => ctx.sw.evaluate((k) => chrome.i18n.getMessage(k), key);
const preview = (page) => page.locator('[data-websnap-ui="preview"]');
const pickerHost = (page) => page.locator('[data-websnap-ui=""]');

async function waitForPicker(ctx, fixture, popup) {
  await pickerHost(fixture.page).waitFor({ state: 'attached', timeout: 10000 });
  ctx.check(true, 'picker opened on the fixture page');
  await popup.waitForEvent('close', { timeout: 2000 }).catch(() => {});
  ctx.notes.push(`popup closed itself after starting the picker: ${popup.isClosed()}`);
  await fixture.page.bringToFront();
}

async function hoverAndClick(page, selector) {
  await page.evaluate(
    (s) => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }),
    selector,
  );
  const p = await page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + Math.min(20, r.height / 2) };
  }, selector);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(50);
  await page.mouse.click(p.x, p.y);
}

async function popupPdfExport(ctx, file, card, expect) {
  const fixture = await openFixture(ctx, file);
  const popup = await openPopup(ctx, fixture);
  await shot(ctx, popup, 'popup.png');
  const before = await downloadIds(ctx);
  await click(ctx, popup, card);
  const { file: pdf, record } = keepDownload(ctx, await waitForNewDownload(ctx, before), card);
  await expectSavedStatus(ctx, popup, record.filename);
  await shot(ctx, popup, 'popup-saved.png');
  inspectPdf(ctx, pdf, record);
  expectMarks(ctx, record, expect);
}

const JOURNEYS = {
  'full-page': {
    fixture: 'article.html',
    run: (ctx) =>
      popupPdfExport(ctx, 'article.html', '#act-page', { present: ['ARTICLE-MARK', 'SIDEBAR-MARK'] }),
  },

  article: {
    fixture: 'article.html',
    run: (ctx) =>
      popupPdfExport(ctx, 'article.html', '#act-article', {
        present: ['ARTICLE-MARK'],
        absent: ['SIDEBAR-MARK'],
      }),
  },

  'select-element-png': {
    fixture: 'element.html (#red, 400x300 CSS px)',
    async run(ctx) {
      const fixture = await openFixture(ctx, 'element.html');
      const popup = await openPopup(ctx, fixture);
      await shot(ctx, popup, 'popup.png');
      await click(ctx, popup, '#act-select');
      await waitForPicker(ctx, fixture, popup);
      await hoverAndClick(fixture.page, '#red');
      ctx.controls.push('picker: click #red');
      const overlay = preview(fixture.page);
      await overlay.locator('.stage canvas[data-ready]').first().waitFor({ timeout: 20000 });
      ctx.check(true, 'preview overlay rendered the element');
      const png = overlay.locator('.seg [data-format="png"]');
      await png.click();
      ctx.controls.push('overlay: .seg [data-format="png"]');
      await fixture.page.waitForFunction(
        () =>
          document
            .querySelector('[data-websnap-ui="preview"]')
            .shadowRoot.querySelector('.seg [data-format="png"]')
            .getAttribute('aria-checked') === 'true',
      );
      await shot(ctx, fixture.page, 'overlay-png.png');
      const before = await downloadIds(ctx);
      await overlay.locator('.download').click();
      ctx.controls.push('overlay: .download');
      const { file, record } = keepDownload(ctx, await waitForNewDownload(ctx, before), 'overlay PNG');
      record.image = imageSize(fs.readFileSync(file));
      ctx.check(record.image.type === 'png', 'download is a PNG', record.image.type);
      ctx.check(
        record.image.width === 800 && record.image.height === 600,
        'PNG is the element at imageScale 2 (800x600)',
        `${record.image.width}x${record.image.height}`,
      );
      await overlay.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      ctx.check((await overlay.count()) === 0, 'overlay closed after the download');
    },
  },

  'remove-reset': {
    fixture: 'article.html (#sidebar)',
    async run(ctx) {
      const fixture = await openFixture(ctx, 'article.html');
      const first = await openPopup(ctx, fixture);
      await click(ctx, first, '#act-remove');
      await waitForPicker(ctx, fixture, first);
      await hoverAndClick(fixture.page, '#sidebar');
      ctx.controls.push('picker: click #sidebar');
      const bar = pickerHost(fixture.page);
      await bar.locator('.count').waitFor({ timeout: 5000 });
      ctx.check((await bar.locator('.count').textContent()) === '1', 'picker bar counts 1 removed element');
      await shot(ctx, fixture.page, 'remove-picker.png');
      await bar.getByRole('button', { name: await label(ctx, 'picker_done'), exact: true }).click();
      ctx.controls.push('picker bar: Done');
      const sidebarDisplay = () =>
        fixture.page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).display);
      ctx.check((await sidebarDisplay()) === 'none', '#sidebar hidden on the page after removal');

      const popup = await openPopup(ctx, fixture);
      const resetShown = await popup.isVisible('#act-reset');
      const resetText = (await popup.textContent('#reset-label')).trim();
      ctx.check(resetShown && /\b1\b/.test(resetText), 'popup offers reset for 1 element', resetText);
      await shot(ctx, popup, 'popup-removed.png');

      let before = await downloadIds(ctx);
      await click(ctx, popup, '#act-page');
      const removed = keepDownload(ctx, await waitForNewDownload(ctx, before), 'after removal');
      await expectSavedStatus(ctx, popup, removed.record.filename);
      inspectPdf(ctx, removed.file, removed.record);
      expectMarks(ctx, removed.record, { present: ['ARTICLE-MARK'], absent: ['SIDEBAR-MARK'] });

      await click(ctx, popup, '#act-reset');
      await popup.waitForSelector('#act-reset.hidden', { state: 'attached', timeout: 5000 }).catch(() => {});
      ctx.check(!(await popup.isVisible('#act-reset')), 'reset card hides after reset');
      ctx.check((await sidebarDisplay()) !== 'none', '#sidebar visible on the page after reset');
      await shot(ctx, popup, 'popup-reset.png');

      before = await downloadIds(ctx);
      await click(ctx, popup, '#act-page');
      const restored = keepDownload(ctx, await waitForNewDownload(ctx, before), 'after reset');
      inspectPdf(ctx, restored.file, restored.record);
      expectMarks(ctx, restored.record, { present: ['ARTICLE-MARK', 'SIDEBAR-MARK'] });
    },
  },

  markdown: {
    fixture: 'article.html',
    async run(ctx) {
      const fixture = await openFixture(ctx, 'article.html');
      const gated = await openPopup(ctx, fixture);
      ctx.check(!(await gated.isVisible('#md-row')), 'Markdown cards hidden before opting in');
      await gated.close();

      const options = await ctx.context.newPage();
      await options.goto(`chrome-extension://${ctx.extensionId}/src/options/options.html`);
      await options.waitForFunction(() => !document.documentElement.hasAttribute('data-boot'));
      await click(ctx, options, '#markdownEnabled');
      await options.waitForSelector('#markdown-confirm:not(.hidden)', { timeout: 5000 });
      ctx.check(!(await options.isChecked('#markdownEnabled')), 'checkbox stays off until confirmed');
      await shot(ctx, options, 'options-confirm.png');
      await click(ctx, options, '#markdown-enable');
      await options.waitForFunction(() => document.getElementById('markdownEnabled').checked);
      const stored = await ctx.sw.evaluate(async () => {
        const { settings } = await chrome.storage.sync.get('settings');
        return !!(settings && settings.markdownEnabled);
      });
      ctx.check(stored, 'markdownEnabled saved after confirming');
      await options.close();

      const popup = await openPopup(ctx, fixture);
      ctx.check(await popup.isVisible('#md-row'), 'Markdown cards shown after opting in');
      await shot(ctx, popup, 'popup-markdown.png');
      const before = await downloadIds(ctx);
      await click(ctx, popup, '#md-article');
      const { file, record } = keepDownload(ctx, await waitForNewDownload(ctx, before), '#md-article');
      await expectSavedStatus(ctx, popup, record.filename);
      const md = fs.readFileSync(file, 'utf8');
      record.marks = marksIn(md);
      ctx.check(/\.md$/.test(record.filename), 'filename ends in .md', record.filename);
      ctx.check(/^# /m.test(md), 'Markdown has a level-1 heading');
      expectMarks(ctx, record, { present: ['ARTICLE-MARK'], absent: ['SIDEBAR-MARK'] });
    },
  },
};

async function driveOne(name, runDir) {
  const journey = JOURNEYS[name];
  const dir = path.join(runDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const result = { journey: name, fixture: journey.fixture, controls: [], downloads: [], screenshots: [] };
  const checks = [];
  const ctx = {
    dir,
    controls: result.controls,
    downloads: result.downloads,
    screenshots: result.screenshots,
    notes: [],
    check(ok, text, detail = '') {
      checks.push({ ok: !!ok, check: text, ...(detail && { detail: String(detail) }) });
      console.log(`  ${ok ? '✓' : '✗'} ${text}${detail ? ` (${detail})` : ''}`);
    },
  };
  console.log(`\n▶ ${name}`);
  const launched = await launchExtension({ viewport: VIEWPORT });
  Object.assign(ctx, launched);
  try {
    await journey.run(ctx);
  } catch (err) {
    ctx.check(false, 'journey completed', err && err.message ? err.message : err);
    const page = launched.context.pages().at(-1);
    if (page && !page.isClosed()) await shot(ctx, page, 'failure.png').catch(() => {});
  } finally {
    await launched.close();
  }
  const failures = checks.filter((c) => !c.ok).map((c) => c.check + (c.detail ? `: ${c.detail}` : ''));
  Object.assign(result, { notes: ctx.notes, checks, pass: failures.length === 0, failures });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

async function drive(which) {
  const names = which === 'all' ? Object.keys(JOURNEYS) : [which];
  if (!names.every((n) => JOURNEYS[n])) {
    console.error(`unknown journey "${which}"; one of: ${Object.keys(JOURNEYS).join(', ')}, all`);
    return 2;
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(root, 'test/out/verify', runId);
  const results = [];
  for (const name of names) results.push(await driveOne(name, runDir));
  const summary = results.map((r) => ({ journey: r.journey, pass: r.pass, failures: r.failures }));
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.journey}`);
  console.log(`evidence: ${runDir}`);
  return results.every((r) => r.pass) ? 0 : 1;
}

async function doctor() {
  const report = { ok: false };
  for (const tool of ['pdfinfo', 'pdftotext']) {
    try {
      execFileSync(tool, ['-v'], { stdio: 'ignore' });
      report[tool] = true;
    } catch {
      report[tool] = false;
    }
  }
  const launched = await launchExtension({ viewport: VIEWPORT });
  try {
    const ctx = { ...launched };
    const fixture = await openFixture(ctx, 'article.html');
    Object.assign(
      report,
      await launched.sw.evaluate(async (tabId) => {
        const m = chrome.runtime.getManifest();
        const state = await globalThis.__websnap.pageState(tabId);
        return {
          name: chrome.i18n.getMessage('extName'),
          version: m.version,
          userAgent: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0],
          pageState: state,
        };
      }, fixture.tab.id),
    );
    report.extensionId = launched.extensionId;
    report.fixtureOrigin = launched.base;
    report.ok = report.pageState?.printable === true && report.pdfinfo && report.pdftotext;
  } catch (err) {
    report.error = String(err && err.message ? err.message : err);
  } finally {
    await launched.close();
  }
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

const [cmd, arg] = process.argv.slice(2);
let code = 2;
if (cmd === 'doctor') code = await doctor();
else if (cmd === 'drive' && arg) code = await drive(arg);
else console.error('usage: node scripts/verify-popup.mjs doctor | drive <journey|all>');
process.exit(code);
