// Probe for the resumable lazy pass: exports the same page twice in a row (the preview and its
// export under PR A) and reports how long each prepare took, and whether the PDF changed.
//
//   node scripts/lazy-resume-probe.mjs [--head <dir>]
//
// Not a gate. It prints a table. The cases that must NOT resume (the page shrank) are rows too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchExtension, tabIdForUrl } from '../test/harness.mjs';
import { DEFAULT_SETTINGS } from '../extension/src/lib/settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: { head: { type: 'string', default: path.join(root, 'extension') } },
});
const SETTINGS = { ...DEFAULT_SETTINGS, loadLazy: true };
const L = 'lazy/loader.html?';

const CASES = [
  { id: 'text-117', url: 'lazy/text.html' },
  { id: 'lodash100', url: L + 'ph=blur&loader=lodash&t=100' },
  { id: 'stuck-100', url: L + 'loader=none&n=0&stuck=100' },
  // Named lazy images that nothing ever fills, three exports in a row. Every one must warn.
  { id: 'never filled x3', url: L + 'loader=xyz&n=20&gap=900', runs: 3 },
  {
    id: 'text-117 shrinks',
    url: 'lazy/text.html',
    between: () => {
      for (const p of [...document.querySelectorAll('p')].slice(0, 700)) p.remove();
    },
  },
  {
    id: 'text-117 grows',
    url: 'lazy/text.html',
    between: () => {
      document.body.insertAdjacentHTML('beforeend', '<p>x</p>'.repeat(1400));
    },
  },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-resume-'));
const env = await launchExtension({ extDir: args.head, viewport: { width: 1200, height: 800 } });
const rows = [];
try {
  for (const c of CASES) {
    const url = `${env.base}/${c.url}`;
    const page = await env.context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(200);
    const tabId = await tabIdForUrl(env.sw, url);
    await page.bringToFront();
    const run = async (n) => {
      const r = await env.sw.evaluate(
        async ({ tabId, settings }) => {
          const t0 = performance.now();
          const res = await globalThis.__websnap.generate({ tabId, settings, output: 'return' });
          return { ms: Math.round(performance.now() - t0), warning: res.warning || '', base64: res.base64 };
        },
        { tabId, settings: SETTINGS },
      );
      const file = path.join(dir, `${c.id.replace(/\W+/g, '_')}-${n}.pdf`);
      fs.writeFileSync(file, Buffer.from(r.base64, 'base64'));
      const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
      const imgs = execFileSync('pdfimages', ['-list', file], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .slice(2).length;
      return {
        ms: r.ms,
        warned: !!r.warning,
        imgs,
        text: crypto.createHash('sha1').update(text).digest('hex').slice(0, 8),
      };
    };
    const results = [];
    for (let n = 1; n <= (c.runs || 2); n++) {
      if (n === 2 && c.between) await page.evaluate(c.between);
      results.push(await run(n));
    }
    const [first, ...rest] = results;
    rows.push({
      case: c.id,
      first: `${first.ms} ms`,
      later: rest.map((r) => `${r.ms} ms`).join(', '),
      imgs: results.map((r) => r.imgs).join('/'),
      warned: results.map((r) => r.warned).join('/'),
      'same text': c.between ? 'n/a' : String(results.every((r) => r.text === first.text)),
    });
    await page.close();
  }
} finally {
  await env.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.table(rows);
