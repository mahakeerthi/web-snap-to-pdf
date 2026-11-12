// Probe for the lazy pass's abort handling (what PR A's Esc will use): aborts the pass at several
// moments, including inside the tail where the 6 s image wait runs, and reports how long the pass
// took to return after the abort.
//
//   node scripts/lazy-abort-probe.mjs [--src <extension dir>]
//
// The pass is private to content.js, so the probe loads a copy of the extension whose content
// script also exposes `window.__lazyTest = loadLazyContent` in its own isolated world. The
// shipped file has no such hook. A hanging image keeps the pass in its image wait.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchExtension, tabIdForUrl } from '../test/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: { src: { type: 'string', default: path.join(root, 'extension') } },
});

const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-abort-ext-'));
fs.cpSync(args.src, copy, { recursive: true });
const contentFile = path.join(copy, 'src/content.js');
const source = fs.readFileSync(contentFile, 'utf8');
const end = source.lastIndexOf('})();');
fs.writeFileSync(
  contentFile,
  source.slice(0, end) + 'window.__lazyTest = loadLazyContent;\n' + source.slice(end),
);

const hang = net.createServer((socket) => socket.on('error', () => {}));
await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
const hangUrl = `http://127.0.0.1:${hang.address().port}/hang.png`;

const env = await launchExtension({ extDir: copy, viewport: { width: 1200, height: 800 } });

async function open(url) {
  const page = await env.context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(
    (src) => document.body.insertAdjacentHTML('beforeend', `<img src="${src}" alt="">`),
    hangUrl,
  );
  await page.waitForTimeout(200);
  const tabId = await tabIdForUrl(env.sw, url);
  await page.bringToFront();
  await env.sw.evaluate(
    (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content.js'] }),
    tabId,
  );
  return { page, tabId };
}

// Runs the pass in the content script's world. `abortAt` is ms after the start, or null for none.
function pass(tabId, abortAt) {
  return env.sw.evaluate(
    async ({ tabId, abortAt }) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        args: [abortAt],
        func: async (abortAt) => {
          const ac = new AbortController();
          if (abortAt === 0) ac.abort();
          else if (abortAt !== null) setTimeout(() => ac.abort(), abortAt);
          const t0 = performance.now();
          const complete = await window.__lazyTest(null, ac.signal);
          return { complete, ms: Math.round(performance.now() - t0) };
        },
      });
      return result;
    },
    { tabId, abortAt },
  );
}

const url = `${env.base}/lazy/text.html?paras=300`;
const rows = [];
try {
  const calibration = await open(url);
  const whole = await pass(calibration.tabId, null);
  await calibration.page.close();
  const loopEnd = whole.ms - 6000 - 150 - 100;
  console.log(
    `unaborted pass: ${whole.ms} ms, scroll loop ends near ${loopEnd} ms, then 150 ms, the image wait (6 s), 100 ms`,
  );

  const moments = [
    ['already aborted', 0],
    ['during the scroll', Math.round(loopEnd / 2)],
    ['at the end of the scroll', loopEnd],
    ['in the 150 ms at the bottom (+30)', loopEnd + 30],
    ['in the 150 ms at the bottom (+80)', loopEnd + 80],
    ['in the 150 ms at the bottom (+130)', loopEnd + 130],
    ['just after it (+190)', loopEnd + 190],
    ['in the image wait (+1500)', loopEnd + 1500],
  ];
  for (const [label, at] of moments) {
    const t = await open(url);
    const r = await pass(t.tabId, at);
    await t.page.close();
    rows.push({
      aborted: label,
      'abort at': `${at} ms`,
      'returned at': `${r.ms} ms`,
      'after abort': `${Math.max(0, r.ms - at)} ms`,
      complete: r.complete,
    });
  }
} finally {
  await env.close();
  hang.close();
  fs.rmSync(copy, { recursive: true, force: true });
}
console.table(rows);
