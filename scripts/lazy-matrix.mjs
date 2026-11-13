// Lazy-load regression matrix: exports every row below with two builds of the extension, rounds
// interleaved, and fails on silent loss, a missing or false warning, a different time or changed
// text.
//
//   node scripts/lazy-matrix.mjs [--base <dir|ref>] [--head <dir|ref>] [--rounds N] [--only <regex>]
//
// --base defaults to origin/main and --head to the working tree's extension/. A ref is unpacked
// with `git archive`. Raw runs go to test/out/lazy-matrix/<time>.jsonl.
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

// lazy/loader.html query parameters:
//   loader   io | lodash (leading + trailing throttle) | echo (trailing poll) | debounce | raw (every
//            scroll event) | native (real src, loading="lazy") | none; a comma list rotates per block
//   t        throttle, poll or debounce ms (100)      thr     IntersectionObserver threshold (0)
//   ahead    px the loader looks past the viewport (0)
//   target   img | picture (<source> srcset) | bg (CSS background-image)   attr  data-echo | data-src | data-bg | data-k
//   ph       placeholder: none | empty | pixel (data: 1x1) | blur (data: 32x20 shown at 300x120) |
//            blob (blob: 32x20) | small (real-URL 16x16 preview) | lazy (same with loading="lazy") |
//            natural (40x40 preview shown at 40x40) | broken (404)
//   n gap    loader blocks (60) and their height (1500)  every  a loader image in every k-th block
//   stuck    blocks of 1000 px first, each with an <img> nothing fills
//   mixed    blocks of 2000 px with an <img> nothing fills after each loader block
//   dead     absolutely positioned dead images, one per 700 px   deadkind missing | pixel | svg
//   icons    the first N blocks hold an icon   iconkind upscaled (64 px shown at 200) | missing | pixel
//   top      header height   root article | section around the blocks   feed=1 endless feed after
//   fixedbar=1  a fixed bar with an image that never loads
//   keyed=1  the attribute holds a key and the URL lives in JavaScript
//   loader=cachedvh  throttled (t) handler that reads innerHeight once at load
//   loader=velocity  fills only when the scroll moved at most v (20) px/ms since the last event
// lazy/text.html: 1400 paragraphs, 117 pages; paras=<n> sets the count.
// lazy/scroll.html: content that appears on scroll without lazy markers (class backgrounds, text
// feeds, a list that grows at the document end, scroll reveal); its modes are listed in the file.
// lazy/shadow.html: images in an open shadow root on a plain div, filled by a debounced handler.
// lazy/adv.html: galleries that react to the viewport (orientation media queries, re-render on
// resize, vh-sized blocks, a hero sized from innerHeight); its parameters are listed in the file.
//
// Row fields: count is the rule (a) metric (pdf: 300 x 120 images in the PDF, filled: elements the
// page's loader filled, feed: FEED-n-MARK lines in the PDF text); warns says what the head's lazy
// warning must do (false: never warn, because the page ends within the stop rule; true: warn in
// every round, because the page does not end before it, and judge a loss against base even then;
// absent: a warning with everything loaded is false); beyond: true marks a row where the head goes
// further than base past position 250, so its time may differ; text: false skips rule (d); zoom:
// browser zoom for the row; rounds: at least this many rounds for a row whose count varies from run
// to run on any build.
const L = 'lazy/loader.html?';
const A = 'lazy/adv.html?';
const S = 'lazy/scroll.html?';
const H = 'lazy/shadow.html?';
// prettier-ignore
const ROWS = [
  { id: 'text-117', url: 'lazy/text.html', count: null, warns: false, from: 'p4 plain page' },
  { id: 'text-long', url: 'lazy/text.html?paras=7000', count: null, warns: true, beyond: true, from: 'build: 500,000 px page that does not grow ends at the 30 s cap' },
  { id: 'lazy-long', url: L + 'loader=io,lodash,native&n=100&gap=2000&t=100&fixedbar=1', count: 'pdf', warns: false, from: 'PR lazy-long.html' },
  { id: 'stuck-100', url: L + 'loader=none&n=0&stuck=100', count: null, warns: false, from: 'PR lazy-stuck.html' },
  { id: 'no-loader-dead100', url: L + 'loader=none&n=2&top=2000&dead=100', count: null, warns: false, from: 'r2 noloader-broken100' },
  { id: 'no-loader-icons', url: L + 'loader=none&gap=1200&icons=60', count: null, warns: false, from: 'r2 icons60' },
  { id: 'endless', url: L + 'n=0&feed=1', count: 'feed', text: false, warns: true, from: 'PR lazy-endless.html' },
  { id: 'endless-img', url: L + 'loader=io&n=5&feed=1', count: 'feed', text: false, warns: true, from: 'review: endless feed after images' },
  { id: 'textfeed-img-320', url: S + 'mode=feed&img=1&batches=30&lat=0', count: 'feed', text: false, warns: true, from: 'review: finite 320,000 px feed that keeps growing past position 250' },
  { id: 'article-feed', url: L + 'root=article&n=0&feed=1', prep: 'article', count: null, warns: true, from: 'PR lazy-article-feed.html' },
  { id: 'article-lodash50', url: L + 'root=article&top=3000&loader=lodash&t=50', prep: 'article', count: 'pdf', from: 'r3 opus article root' },
  { id: 'article-io', url: L + 'root=article&top=3000&loader=io', prep: 'article', count: 'pdf', from: 'r3 opus article root' },
  { id: 'element-feed-lodash50', url: L + 'root=section&top=3000&n=20&loader=lodash&t=50&feed=1', prep: 'element', count: 'pdf', warns: true, from: 'new: element root above a feed' },
  { id: 'blur-lodash100', url: L + 'ph=blur&loader=lodash&t=100', count: 'pdf', from: 'r1 sonnet blurred preview' },
  { id: 'blur-lodash250', url: L + 'ph=blur&loader=lodash&t=250', count: 'pdf', from: 'r1 sonnet blurred preview' },
  { id: 'blur-echo100', url: L + 'ph=blur&loader=echo&t=100', count: 'pdf', rounds: 5, from: 'r1 sonnet trailing poll' },
  { id: 'blur-io', url: L + 'ph=blur&loader=io', count: 'pdf', from: 'r1 sonnet control' },
  { id: 'blob-datasrc-lodash100', url: L + 'ph=blob&attr=data-src&loader=lodash&t=100', count: 'pdf', from: 'r1 sonnet blob: preview' },
  { id: 'data-datasrc-lodash100', url: L + 'ph=blur&attr=data-src&loader=lodash&t=100', count: 'pdf', from: 'r1 sonnet data: preview' },
  { id: 'pixel-lodash250', url: L + 'ph=pixel&loader=lodash&t=250', count: 'pdf', from: 'r1 sonnet 1x1 preview' },
  { id: 'broken-lodash100', url: L + 'ph=broken&loader=lodash&t=100', count: 'pdf', from: 'new: 404 preview' },
  { id: 'picture-lodash100', url: L + 'target=picture&loader=lodash&t=100', count: 'pdf', from: 'new: <picture><source>' },
  { id: 'stuck4-lodash50', url: L + 'stuck=4&gap=2000&loader=lodash&t=50', count: 'pdf', from: 'r1 opus silent probe' },
  { id: 'stuck4-lodash100', url: L + 'stuck=4&gap=2000&loader=lodash&t=100', count: 'pdf', from: 'r1 opus silent probe' },
  { id: 'stuck8-lodash100', url: L + 'stuck=8&gap=2000&loader=lodash&t=100', count: 'pdf', from: 'PR lazy-throttled stuck=8' },
  { id: 'dead4pixel-lodash100', url: L + 'top=3000&dead=4&deadkind=pixel&loader=lodash&t=100', count: 'pdf', from: 'r1 sonnet latch' },
  { id: 'mixed-lodash50', url: L + 'n=34&gap=2000&mixed=2&loader=lodash&t=50', count: 'pdf', from: 'PR lazy-throttled mixed=1' },
  { id: 'mixed-io', url: L + 'n=34&gap=2000&mixed=2&loader=io', count: 'pdf', from: 'r1 opus observer mix' },
  { id: 'io-dead100', url: L + 'loader=io&dead=100', count: 'pdf', from: 'r1 sonnet observer + 100 broken' },
  { id: 'io-thr50', url: L + 'loader=io&thr=0.5&n=100', count: 'pdf', from: 'r3 opus warning at 100/100' },
  { id: 'lazyph-lodash100', url: L + 'ph=lazy&loader=lodash&t=100', count: 'pdf', rounds: 5, from: 'r3 opus loading="lazy" preview' },
  { id: 'lazyph-lodash50', url: L + 'ph=lazy&loader=lodash&t=50', count: 'pdf', from: 'r3 opus loading="lazy" preview' },
  { id: 'smallph-lodash100', url: L + 'ph=small&loader=lodash&t=100', count: 'pdf', from: 'r3 opus control' },
  { id: 'bg-lodash50', url: L + 'target=bg&attr=data-bg&loader=lodash&t=50', count: 'filled', from: 'r3 opus + sonnet backgrounds' },
  { id: 'bg-lodash100', url: L + 'target=bg&attr=data-bg&loader=lodash&t=100', count: 'filled', from: 'r3 opus + sonnet backgrounds' },
  { id: 'bg-lodash125-ahead500', url: L + 'target=bg&attr=data-bg&loader=lodash&t=125&ahead=500', count: 'filled', from: 'r3 opus backgrounds' },
  { id: 'bg-io', url: L + 'target=bg&attr=data-bg&loader=io', count: 'filled', from: 'r3 control' },
  { id: 'debounce30-dead8', url: L + 'top=6000&dead=8&n=30&loader=debounce&t=30', count: 'pdf', from: 'r3 opus debounce after broken run' },
  { id: 'debounce30-dead4', url: L + 'top=6000&dead=4&n=30&loader=debounce&t=30', count: 'pdf', from: 'r3 opus control' },
  { id: 'icons10-lodash100', url: L + 'gap=1200&every=10&icons=10&loader=lodash&t=100', count: 'filled', from: 'r3 sonnet upscaled icons' },
  { id: 'deadicons10-lodash100', url: L + 'gap=1200&every=10&icons=10&iconkind=missing&loader=lodash&t=100', count: 'filled', from: 'r3 sonnet kind=dead' },
  { id: 'natural-every6-lodash100', url: L + 'gap=1200&every=6&ph=natural&loader=lodash&t=100', count: 'filled', from: 'r3 sonnet natural-size preview' },
  { id: 'short-io-n2', url: A + 'loader=io&n=2&gap=1000', count: 'pdf', from: 'interrogate short page' },
  { id: 'zoom50-lodash50-n5', url: L + 'loader=lodash&t=50&n=5', count: 'pdf', zoom: 0.5, from: 'interrogate browser zoom' },
  { id: 'zoom50-debounce30-n6', url: L + 'loader=debounce&t=30&n=6', count: 'pdf', zoom: 0.5, from: 'interrogate browser zoom' },
  { id: 'p-cachedvh-lodash100', url: L + 'loader=cachedvh&t=100', count: 'pdf', from: 'interrogate innerHeight read once' },
  { id: 'p-velocity20', url: L + 'loader=velocity&v=20', count: 'pdf', from: 'interrogate scroll speed' },
  { id: 'ahead1000-lodash200', url: L + 'target=bg&attr=data-bg&loader=lodash&t=200&ahead=1000', count: 'filled', from: 'interrogate look-ahead' },
  { id: 'ahead1500-lodash250', url: L + 'target=bg&attr=data-bg&loader=lodash&t=250&ahead=1500', count: 'filled', from: 'interrogate look-ahead' },
  { id: 'img-ahead1500-lodash250', url: L + 'ph=blur&loader=lodash&t=250&ahead=1500', count: 'pdf', from: 'interrogate look-ahead' },
  { id: 'orient-mq-io', url: A + 'loader=io&mode=mq', count: 'pdf', from: 'interrogate orientation media query' },
  { id: 'orient-js-io', url: A + 'loader=io&mode=js', count: 'pdf', from: 'interrogate orientation matchMedia' },
  { id: 'orient-js-io-datasrc', url: A + 'loader=io&mode=js&attr=data-src', count: 'pdf', from: 'interrogate orientation matchMedia' },
  { id: 'reset0-io', url: A + 'loader=io&mode=reset&rd=0', count: 'pdf', from: 'interrogate re-render on resize' },
  { id: 'vh100-n20-io', url: A + 'loader=io&vh=100&n=20', count: 'pdf', from: 'interrogate vh blocks' },
  { id: 'vh100-n40-io', url: A + 'loader=io&vh=100&n=40', count: 'pdf', from: 'interrogate vh blocks' },
  { id: 'vh100-n60-io', url: A + 'loader=io&vh=100&n=60', count: 'pdf', from: 'interrogate vh blocks' },
  { id: 'hero-db100', url: A + 'loader=io&n=20&hero=1&herodb=100', count: 'pdf', from: 'interrogate hero from innerHeight' },
  { id: 'hero-db250', url: A + 'loader=io&n=20&hero=1&herodb=250', count: 'pdf', from: 'interrogate hero from innerHeight' },
  { id: 'keyed-natural-lodash100', url: L + 'ph=natural&attr=data-k&keyed=1&loader=lodash&t=100', count: 'filled', rounds: 5, from: 'arch candidate 2: URL kept in JavaScript, no marker' },
  { id: 'bg-keyed-lodash100', url: L + 'target=bg&attr=data-k&keyed=1&top=1600&loader=lodash&t=100', count: 'filled', from: 'backgrounds set from JavaScript on scroll, no marker' },
  { id: 'bg-datattr-debounce30', url: L + 'target=bg&attr=data-bg&top=1600&loader=debounce&t=30', count: 'filled', from: 'review: lazy only through a data-* attribute' },
  { id: 'classbg-lodash100', url: S + 'mode=classbg&loader=lodash&t=100', count: 'filled', from: 'review: backgrounds from a class set on scroll' },
  { id: 'classbg-lodash50', url: S + 'mode=classbg&loader=lodash&t=50', count: 'filled', rounds: 5, from: 'review: backgrounds from a class set on scroll' },
  { id: 'classbg-logo-lodash100', url: S + 'mode=classbg&loader=lodash&t=100&logo=1', count: 'filled', from: 'review control' },
  { id: 'textfeed-lat100', url: S + 'mode=feed&lat=100', count: 'feed', text: false, warns: false, from: 'review: text feed that grows on scroll' },
  { id: 'textfeed-lat60', url: S + 'mode=feed&lat=60', count: 'feed', text: false, warns: false, from: 'review: text feed that grows on scroll' },
  { id: 'textfeed-img-lat100', url: S + 'mode=feed&lat=100&img=1', count: 'feed', text: false, warns: false, from: 'review control' },
  { id: 'rootfeed-element', url: S + 'mode=rootfeed', prep: 'element', count: 'feed', text: false, warns: false, from: 'review: list that grows at the document end' },
  { id: 'reveal-lodash99', url: S + 'mode=reveal&n=90&gap=1200&t=99', count: 'filled', text: false, rounds: 5, from: 'text revealed by a scroll handler, no marker' },
  { id: 'bg-keyed-debounce30', url: L + 'target=bg&attr=data-k&keyed=1&top=1600&loader=debounce&t=30', count: 'filled', from: 'backgrounds set from JavaScript after a 30 ms pause, no marker' },
  { id: 'shadowdiv-debounce30', url: H + 't=30', count: 'filled', from: 'review: images in a shadow root on a plain div' },
  { id: 'slowfeed-lat500-m9000', url: S + 'mode=feed&lat=500&margin=9000', count: 'feed', text: false, warns: false, from: 'review: text feed that answers 500 ms late' },
  { id: 'slowfeed-lat400-m6000', url: S + 'mode=feed&lat=400&margin=6000', count: 'feed', text: false, warns: false, from: 'review: text feed that answers 400 ms late' },
  { id: 'rootfeed-text-element', url: S + 'mode=rootfeed&img=0&foot=3000', prep: 'element', count: 'feed', text: false, warns: false, from: 'review: text list that grows at the document end' },
  { id: 'finite-grow-before-250', url: S + 'mode=feed&img=1&init=25&batches=15&lat=0', count: 'feed', text: false, warns: false, beyond: true, from: 'review: feed that stops growing at position 240 of 258, scrolled to its end' },
  { id: 'finite-grow-after-250', url: S + 'mode=feed&img=1&init=33&batches=15&lat=0', count: 'feed', text: false, warns: true, from: 'review: feed whose last batch arrives after position 250' },
];

const SLOWER = 0.1;
const slack = (baseMedian) => Math.max(2, Math.ceil(baseMedian * 0.1));
const VIEWPORT = { width: 1200, height: 800 };
const SETTINGS = { ...DEFAULT_SETTINGS, loadLazy: true };

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/main' },
    head: { type: 'string', default: path.join(root, 'extension') },
    rounds: { type: 'string', default: '3' },
    only: { type: 'string' },
  },
});

const tmpDirs = [];
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

function resolveSide(name, spec) {
  if (fs.existsSync(path.join(spec, 'manifest.json'))) {
    const dir = path.resolve(spec);
    let state;
    try {
      state = git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain', '--', dir) ? '+dirty' : '');
    } catch {
      state = 'outside the repository';
    }
    return { name, dir, label: `${spec} (${state})` };
  }
  let sha;
  try {
    sha = git('rev-parse', '--quiet', '--verify', '--short', `${spec}^{commit}`);
  } catch {
    throw new Error(`--${name} ${spec} is neither an extension folder nor a git ref`);
  }
  const dir = tempDir(`lazy-matrix-${name}-`);
  const tar = execFileSync('git', ['-C', root, 'archive', sha, 'extension'], { maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return { name, dir: path.join(dir, 'extension'), label: `${spec} (${sha})` };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mode = (xs) => {
  const n = new Map();
  for (const x of xs) n.set(x, (n.get(x) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const run = (tool, ...a) => execFileSync(tool, a, { encoding: 'utf8', maxBuffer: 1 << 26 });

async function pickRoot(page, sw, tabId) {
  await page.evaluate(() =>
    document.getElementById('root').scrollIntoView({ block: 'start', behavior: 'instant' }),
  );
  await sw.evaluate((id) => globalThis.__websnap.startPicker(id, 'print'), tabId);
  const at = await page.evaluate(() => {
    const r = document.getElementById('root').getBoundingClientRect();
    return { x: r.left + 12, y: Math.max(r.top, 0) + 200 };
  });
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(50);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(
    () => {
      const sr = document.querySelector('[data-websnap-ui="preview"]')?.shadowRoot;
      const canvases = sr ? [...sr.querySelectorAll('.stage canvas')] : [];
      return (
        sr?.querySelector('.placeholder.error') || (canvases.length && canvases.every((c) => c.dataset.ready))
      );
    },
    null,
    { timeout: 120000 },
  );
}

async function runRow(env, row, outDir) {
  const url = `${env.base}/${row.url}`;
  const page = await env.context.newPage();
  let tabId = null;
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(200);
    tabId = await tabIdForUrl(env.sw, url);
    await page.bringToFront();
    if (row.zoom) {
      await env.sw.evaluate(({ tabId, zoom }) => chrome.tabs.setZoom(tabId, zoom), { tabId, zoom: row.zoom });
      await page.waitForTimeout(400);
    }
    if (row.prep === 'element') await pickRoot(page, env.sw, tabId);
    const r = await env.sw.evaluate(
      async ({ tabId, prep, settings }) => {
        const t0 = performance.now();
        const res = await globalThis.__websnap
          .generate({ tabId, prep, settings, output: 'return' })
          .catch((e) => ({ error: String(e && e.message) }));
        return { ...res, ms: performance.now() - t0 };
      },
      { tabId, prep: row.prep || 'none', settings: SETTINGS },
    );
    const dom = await page.evaluate(() => ({
      filled: window.__filled ? window.__filled() : null,
      total: window.__total ?? null,
      expected: window.__expected ?? null,
    }));
    const out = {
      ms: Math.round(r.ms),
      warning: r.warning || '',
      error: r.error || (r.base64 ? '' : 'no PDF'),
      ...dom,
    };
    if (!r.base64) return out;
    const file = path.join(outDir, `${row.id}.pdf`);
    fs.writeFileSync(file, Buffer.from(r.base64, 'base64'));
    const images = run('pdfimages', '-list', file)
      .trim()
      .split('\n')
      .slice(2)
      .map((l) => l.trim().split(/\s+/));
    const text = run('pdftotext', file, '-');
    return {
      ...out,
      pdf: images.filter((c) => c[2] === 'image' && c[3] === '300' && c[4] === '120').length,
      feed: (text.match(/FEED-\d+-MARK/g) || []).length,
      pages: Number(/Pages:\s+(\d+)/.exec(run('pdfinfo', file))[1]),
      textHash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 10),
    };
  } catch (err) {
    return { error: String(err && err.message).split('\n')[0] };
  } finally {
    // Chrome keeps zoom per origin: put it back so later rows run at 100%.
    if (row.zoom && tabId != null)
      await env.sw.evaluate((id) => chrome.tabs.setZoom(id, 0), tabId).catch(() => {});
    await page.close();
  }
}

// Returns the rules the row fails.
function judge(row, runs) {
  const base = runs.filter((r) => r.side === 'base');
  const head = runs.filter((r) => r.side === 'head');
  const fails = [];
  for (const r of runs.filter((x) => x.error)) fails.push(`error on ${r.side} round ${r.round}: ${r.error}`);
  if (fails.length) return fails;
  const count = (r) => r[row.count];
  const total = (r) => (row.count === 'pdf' ? r.expected : r.total);
  const baseWarnings = new Set(base.map((r) => r.warning));
  const newWarning = (r) => r.warning && !baseWarnings.has(r.warning);

  if (row.count) {
    const b = median(base.map(count));
    if (!(b >= 1)) fails.push(`no signal: base median ${b} for ${row.count}, the row cannot detect a loss`);
    const h = median(head.map(count));
    const excused = (r) => row.warns !== true && newWarning(r);
    const silent = head.filter((r) => count(r) < b - slack(b) && !excused(r)).map((r) => r.round);
    if (h < b - slack(b) && silent.length > 0)
      fails.push(
        `(a) ${row.warns === true ? 'loss' : 'silent loss'}: head median ${h}, base median ${b} (slack ${slack(b)}), rounds ${silent}${row.warns === true ? '' : ' did not warn'}`,
      );
  }
  for (const r of head) {
    if (row.warns === true) {
      if (!newWarning(r))
        fails.push(`(b) no warning on a page that does not end before the stop, round ${r.round}`);
    } else if (row.warns === false) {
      if (newWarning(r)) fails.push(`(b) false warning on a page that ends, round ${r.round}: ${r.warning}`);
    } else if (newWarning(r) && row.count && row.count !== 'feed' && count(r) >= total(r)) {
      fails.push(`(b) false warning with ${count(r)}/${total(r)} loaded, round ${r.round}: ${r.warning}`);
    }
  }
  const bMs = median(base.map((r) => r.ms));
  const hMs = median(head.map((r) => r.ms));
  const loadsMore = row.count && median(head.map(count)) > median(base.map(count));
  if (!row.beyond) {
    if (hMs > bMs * (1 + SLOWER) && !loadsMore)
      fails.push(
        `(c) ${Math.round((hMs / bMs - 1) * 100)}% slower without loading more: head ${hMs} ms vs base ${bMs} ms`,
      );
    if (hMs < bMs * (1 - SLOWER))
      fails.push(
        `(c) ${Math.round((1 - hMs / bMs) * 100)}% faster than base, so the scroll schedule differs: head ${hMs} ms vs base ${bMs} ms`,
      );
  }
  if (row.text !== false && mode(head.map((r) => r.textHash)) !== mode(base.map((r) => r.textHash)))
    fails.push(
      `(d) PDF text differs: head ${[...new Set(head.map((r) => r.textHash))]} vs base ${[...new Set(base.map((r) => r.textHash))]}`,
    );
  return fails;
}

function report(rows, results, sides) {
  const stat = (xs) => {
    const v = xs.filter((x) => x != null);
    if (!v.length) return '-';
    const m = median(v);
    return `${m} [${Math.min(...v)}-${Math.max(...v)}]`;
  };
  const secs = (xs) =>
    `${(median(xs) / 1000).toFixed(1)}s [${(Math.min(...xs) / 1000).toFixed(1)}-${(Math.max(...xs) / 1000).toFixed(1)}]`;
  const table = rows.map((row) => {
    const runs = results.filter((r) => r.id === row.id);
    const side = (s) => runs.filter((r) => r.side === s && !r.error);
    const cell = (s) => (row.count ? stat(side(s).map((r) => r[row.count])) : '-');
    const warned = (s) =>
      `${side(s).filter((r) => r.warning).length}/${runs.filter((r) => r.side === s).length}`;
    const ms = (s) => (side(s).length ? secs(side(s).map((r) => r.ms)) : '-');
    const fails = judge(row, runs);
    return {
      row: row.id,
      metric: !row.count
        ? '-'
        : row.count === 'feed'
          ? 'feed'
          : `${row.count}/${side('base')[0]?.[row.count === 'pdf' ? 'expected' : 'total'] ?? '?'}`,
      base: cell('base'),
      head: cell('head'),
      warned: `${warned('base')} ${warned('head')}`,
      'base time': ms('base'),
      'head time': ms('head'),
      pages: `${stat(side('base').map((r) => r.pages))} ${stat(side('head').map((r) => r.pages))}`,
      result: fails.length ? 'FAIL' : 'pass',
      fails,
    };
  });
  const cols = Object.keys(table[0]).filter((c) => c !== 'fails');
  const width = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...table.map((t) => t[c].length))]),
  );
  const line = (t) => cols.map((c) => t[c].padEnd(width[c])).join('  ');
  console.log(`\nbase: ${sides.base.label}\nhead: ${sides.head.label}\n`);
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  for (const t of table) console.log(line(t));
  const failed = table.filter((t) => t.fails.length);
  for (const t of failed) for (const f of t.fails) console.log(`FAIL ${t.row}: ${f}`);
  console.log(`\n${table.length - failed.length} rows passed, ${failed.length} failed`);
  return failed.length;
}

async function main() {
  for (const tool of ['pdfimages', 'pdftotext', 'pdfinfo']) {
    try {
      execFileSync(tool, ['-v'], { stdio: 'ignore' });
    } catch {
      throw new Error(`${tool} not found; install poppler (see CONTRIBUTING.md)`);
    }
  }
  const only = args.only ? new RegExp(args.only, 'i') : null;
  const rows = ROWS.filter((r) => !only || only.test(r.id));
  if (!rows.length) throw new Error(`--only ${args.only} matches no row`);
  const rounds = Number(args.rounds);
  if (!(rounds >= 1)) throw new Error('--rounds must be at least 1');
  const roundsOf = (row) => Math.max(rounds, row.rounds || 0);
  const maxRounds = Math.max(...rows.map(roundsOf));
  const sides = { base: resolveSide('base', args.base), head: resolveSide('head', args.head) };

  const logDir = path.join(root, 'test/out/lazy-matrix');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  console.log(`base ${sides.base.label}\nhead ${sides.head.label}`);
  console.log(
    `${rows.length} rows x ${rounds} rounds (up to ${maxRounds} for noisy rows), viewport ${VIEWPORT.width}x${VIEWPORT.height}, load${execFileSync('uptime', { encoding: 'utf8' }).split('load')[1].trim()}`,
  );
  console.log(`raw runs: ${path.relative(root, log)}`);

  const results = [];
  const started = Date.now();
  for (let round = 0; round < maxRounds; round++) {
    const rowsNow = rows.filter((row) => round < roundsOf(row));
    for (const side of round % 2 ? [sides.head, sides.base] : [sides.base, sides.head]) {
      const env = await launchExtension({ extDir: side.dir, viewport: VIEWPORT });
      const outDir = tempDir('lazy-matrix-pdf-');
      try {
        for (const row of rowsNow) {
          const res = { id: row.id, side: side.name, round, ...(await runRow(env, row, outDir)) };
          results.push(res);
          fs.appendFileSync(log, JSON.stringify(res) + '\n');
          const metric = row.count ? ` ${row.count} ${res[row.count]}` : '';
          console.log(
            `  r${round} ${side.name} ${row.id}:${metric} ${res.ms} ms${res.warning ? ' warned' : ''}${res.error ? ' ERROR ' + res.error : ''}`,
          );
        }
      } finally {
        await env.close();
      }
    }
  }
  const failed = report(rows, results, sides);
  console.log(`total ${((Date.now() - started) / 60000).toFixed(1)} min`);
  return failed;
}

try {
  process.exitCode = (await main()) ? 1 : 0;
} catch (err) {
  console.error(String(err && err.message));
  process.exitCode = 2;
} finally {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
}
