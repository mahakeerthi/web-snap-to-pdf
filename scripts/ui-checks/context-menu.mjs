// Context-menu titles come from chrome.i18n, so they follow the browser's UI language.
// chrome.contextMenus has no read API and Playwright cannot capture a native menu, so this records
// what the worker passes to contextMenus.create when it installs the menus on first run.
// macOS ignores --lang, so each language runs from a temp copy of the extension whose
// default_locale is that language and whose other locales are removed. chrome.i18n then resolves it on
// every OS, and --lang is passed as well for platforms where it does switch the UI language.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MENU_IDS = ['page', 'article', 'selectElement', 'removeElements', 'reset'];
const JAPANESE = /[぀-ヿ一-鿿]/;

const RECORDER = `globalThis.__menuLog = [];
const __createMenu = chrome.contextMenus.create.bind(chrome.contextMenus);
chrome.contextMenus.create = (props, callback) => {
  globalThis.__menuLog.push({ id: props.id, title: props.title });
  return __createMenu(props, callback);
};
`;

const readDict = (extDir, code) =>
  JSON.parse(fs.readFileSync(path.join(extDir, '_locales', code, 'messages.json'), 'utf8'));

async function recordMenus(extDir, code) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `websnap-menu-${code}-`));
  const copy = path.join(tmp, 'ext');
  fs.cpSync(extDir, copy, { recursive: true });
  const manifestPath = path.join(copy, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.default_locale = code;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  for (const dir of fs.readdirSync(path.join(copy, '_locales')))
    if (dir !== code) fs.rmSync(path.join(copy, '_locales', dir), { recursive: true });
  const backgroundPath = path.join(copy, 'src/background.js');
  fs.writeFileSync(backgroundPath, RECORDER + fs.readFileSync(backgroundPath, 'utf8'));

  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true,
    channel: 'chromium',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`, `--lang=${code}`],
  });
  try {
    const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const actionTitle = await sw.evaluate(() => chrome.i18n.getMessage('actionTitle'));
    for (let i = 0; i < 100; i++) {
      if ((await sw.evaluate(() => globalThis.__menuLog.length)) >= MENU_IDS.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500));
    return { actionTitle, menus: await sw.evaluate(() => globalThis.__menuLog) };
  } finally {
    await context.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function checkContextMenus({ extDir, outDir, problems }) {
  const en = readDict(extDir, 'en');
  const codes = fs
    .readdirSync(path.join(extDir, '_locales'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'en')
    .map((d) => d.name);
  for (const code of codes) {
    const dict = readDict(extDir, code);
    for (const id of MENU_IDS) {
      const text = dict[`menu_${id}`]?.message;
      if (!text || text === en[`menu_${id}`]?.message)
        problems.push(`[menus-${code}] menu_${id} is missing or still the English text`);
    }
  }

  const recorded = {};
  for (const code of ['en', 'ja']) {
    const label = `menus-${code}`;
    const dict = readDict(extDir, code);
    const { actionTitle, menus } = await recordMenus(extDir, code);
    recorded[code] = menus;
    if (actionTitle !== dict.actionTitle.message) {
      problems.push(`[${label}] chrome.i18n did not resolve ${code}: actionTitle is "${actionTitle}"`);
      continue;
    }
    const ids = menus.map((m) => m.id);
    if (ids.join() !== MENU_IDS.join())
      problems.push(`[${label}] created menu ids [${ids}], expected [${MENU_IDS}]`);
    for (const { id, title } of menus) {
      const expected = dict[`menu_${id}`]?.message;
      if (title !== expected)
        problems.push(`[${label}] "${id}" title is "${title}", expected the ${code} text "${expected}"`);
      if (code === 'ja' && !JAPANESE.test(title))
        problems.push(`[${label}] "${id}" title "${title}" has no Japanese characters`);
    }
  }
  const file = path.join(outDir, 'context-menu-titles.json');
  fs.writeFileSync(file, JSON.stringify(recorded, null, 2) + '\n');
  console.log('saved', path.relative(process.cwd(), file));
}
