#!/usr/bin/env node
// Timing gate for the page and article previews. Drives the real popup card against
// test/fixtures/preview-perf.html at device scale 2 and reports, per fixture, the median and spread
// of the card click to the finished preview, how much of that is the lazy pass, the largest
// ps:show-preview message, the preview scale, and the time from Download (PDF) to the file.
//   node scripts/preview-perf.mjs            headless
//   HEADED=1 node scripts/preview-perf.mjs   with Chrome's debugging bar (it shortens the viewport the pass steps through)
//   REPS=2 ONLY='noise30' node scripts/preview-perf.mjs   fewer repeats, a subset of fixtures
// Every page runs main's schedule (85 % of the viewport per step, at least 50 ms a position), so the
// pass is held to that schedule and the rest of the preview to 3 s up to 33,000 px, 6 s above.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension, tabIdForUrl, waitForDownload } from '../test/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test/out');
fs.mkdirSync(outDir, { recursive: true });
const REPS = Number(process.env.REPS || 5);
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
const PREVIEW_MAX_PIXELS = 32e6;
const MAX_MESSAGE = 32e6;

const FIXTURES = [
  { id: 'text4-article', q: 'paras=300&photos=4', card: '#act-article' },
  { id: 'text4-page', q: 'paras=300&photos=4', card: '#act-page' },
  { id: 'long-text-article', q: 'paras=450', card: '#act-article' },
  { id: 'noise30-article', q: 'paras=60&photos=30&noise=1', card: '#act-article' },
  { id: 'noise30-page', q: 'paras=60&photos=30&noise=1', card: '#act-page' },
  { id: 'dense-text-page', q: 'dense=6600', card: '#act-page' },
  { id: 'tall-76000-page', q: 'tall=76000&photos=20', card: '#act-page' },
].filter((f) => !ONLY || ONLY.test(f.id));

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const spread = (a) => `${Math.min(...a)}-${Math.max(...a)}`;

const { context, sw, base, downloadDir, close } = await launchExtension({
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 2,
});
await sw.evaluate(() => {
  globalThis.__log = [];
  const send = chrome.tabs.sendMessage.bind(chrome.tabs);
  chrome.tabs.sendMessage = async (tabId, msg, ...rest) => {
    const res = await send(tabId, msg, ...rest);
    if (msg.type === 'ps:show-preview') globalThis.__log.push({ bytes: JSON.stringify(msg).length });
    if (msg.type === 'ps:prepare')
      globalThis.__log.push({
        lazyComplete: res && res.lazy && res.lazy.complete,
        reused: res && res.reused,
      });
    return res;
  };
});

async function openPopup(tabId) {
  const tab = await sw.evaluate((id) => chrome.tabs.get(id), tabId);
  const url = `chrome-extension://${await sw.evaluate(() => chrome.runtime.id)}/src/popup/popup.html`;
  const [popup] = await Promise.all([
    context.waitForEvent('page', { predicate: (p) => p.url() === url, timeout: 10000 }),
    sw.evaluate(({ url, windowId }) => chrome.tabs.create({ url, windowId, active: false }), {
      url,
      windowId: tab.windowId,
    }),
  ]);
  await popup.waitForSelector('body[data-state="ready"]', { timeout: 10000 });
  await popup.waitForFunction(() => !document.documentElement.hasAttribute('data-boot'));
  await popup.evaluate(() => (window.close = () => {}));
  return popup;
}

async function once(fx) {
  const url = `${base}/preview-perf.html?${fx.q}`;
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  const tabId = await tabIdForUrl(sw, url);
  await page.bringToFront();
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.evaluate(() => {
    window.__sc = [];
    addEventListener('scroll', () => window.__sc.push({ t: performance.now(), y: scrollY, ih: innerHeight }));
  });
  const popup = await openPopup(tabId);
  await sw.evaluate(() => (globalThis.__log.length = 0));
  const t0 = Date.now();
  await popup.click(fx.card);
  await page.waitForFunction(
    () => {
      const h = document.querySelector('[data-websnap-ui="preview"]');
      const cs = h ? [...h.shadowRoot.querySelectorAll('.stage canvas')] : [];
      return (
        (cs.length && cs.every((c) => c.dataset.ready)) ||
        (h && h.shadowRoot.querySelector('.placeholder.error'))
      );
    },
    null,
    { timeout: 240000, polling: 100 },
  );
  const readyMs = Date.now() - t0;
  const info = await page.evaluate(() => {
    const sr = document.querySelector('[data-websnap-ui="preview"]').shadowRoot;
    const c = sr.querySelector('.stage canvas');
    return {
      error: sr.querySelector('.placeholder.error')?.textContent || '',
      caption: sr.querySelector('.caption').textContent,
      scale: c ? c.width / parseFloat(c.style.width) : 0,
      parts: sr.querySelectorAll('.stage canvas').length,
    };
  });
  const sc = await page.evaluate(() => window.__sc);
  const log = await sw.evaluate(() => globalThis.__log);
  const moving = sc.filter((e) => e.y > 0);
  const passMs = sc.length ? Math.round(sc[sc.length - 1].t - sc[0].t) : 0;
  const ih = sc.length ? sc[0].ih : 800;
  const positions = Math.ceil(scrollHeight / (0.85 * ih));
  const steps = moving.slice(1).map((e, i) => Math.round(e.y - moving[i].y));
  const [w, h] = (/(\d+)×(\d+) px/.exec(info.caption) || []).slice(1).map(Number);
  const lazyComplete = log.find((l) => 'lazyComplete' in l)?.lazyComplete;

  const t1 = Date.now();
  await page.evaluate(() => {
    const sr = document.querySelector('[data-websnap-ui="preview"]').shadowRoot;
    const sel = sr.querySelector('select.format');
    sel.value = 'pdf';
    sel.dispatchEvent(new Event('change'));
    sr.querySelector('.download').click();
  });
  const since = new Date(t1 - 1000).toISOString();
  const saved = await waitForDownload(
    sw,
    (i) => /\.pdf$/.test(i.filename) && i.startTime >= since,
    240000,
  ).then(
    () => true,
    () => false,
  );
  const downloadMs = saved ? Date.now() - t1 : null;
  const downloadWarning = await page.evaluate(() => {
    const h = document.querySelector('[data-websnap-ui="preview"]');
    const w = h && h.shadowRoot.querySelector('.warning');
    return w && !w.hidden ? w.textContent : '';
  });
  const prepares = (await sw.evaluate(() => globalThis.__log)).filter((l) => 'reused' in l);
  await popup.close();
  await page.close();
  return {
    scrollHeight,
    readyMs,
    passMs,
    restMs: readyMs - passMs,
    positions,
    ih,
    step: median(steps.length ? steps : [0]),
    maxMB: Math.max(0, ...log.filter((l) => l.bytes).map((l) => l.bytes)) / 1e6,
    scale: info.scale,
    scaleExpected: w && h && w * h * 4 <= PREVIEW_MAX_PIXELS ? 2 : null,
    lazyComplete,
    downloadMs,
    downloadWarning,
    reused: prepares.map((p) => p.reused),
    error: info.error,
  };
}

const rows = [];
let failed = false;
console.log(`preview-perf: ${process.env.HEADED ? 'headed' : 'headless'}, ${REPS} runs per fixture\n`);
for (const fx of FIXTURES) {
  const runs = [];
  for (let i = 0; i < REPS; i++) runs.push(await once(fx));
  const r0 = runs[0];
  const passes = runs.map((r) => r.passMs);
  const rests = runs.map((r) => r.restMs);
  const readies = runs.map((r) => r.readyMs);
  const restLimit = r0.scrollHeight <= 33000 ? 3000 : 6000;
  const passLimit = 1.1 * r0.positions * 50 + 1000;
  const problems = [];
  if (runs.some((r) => r.error)) problems.push(`preview error: ${runs.find((r) => r.error).error}`);
  if (median(passes) > passLimit) problems.push(`pass ${median(passes)} ms over ${Math.round(passLimit)} ms`);
  if (median(rests) > restLimit) problems.push(`rest ${median(rests)} ms over ${restLimit} ms`);
  if (runs.some((r) => r.maxMB * 1e6 >= MAX_MESSAGE)) problems.push('a message reached 32 MB');
  if (runs.some((r) => r.scaleExpected && Math.abs(r.scale - r.scaleExpected) > 0.01))
    problems.push(`preview scale ${r0.scale}, expected ${r0.scaleExpected}`);
  const budget = runs.some((r) => r.lazyComplete === false);
  if (
    budget &&
    !(fx.id.startsWith('tall') && runs.every((r) => r.lazyComplete !== false || r.downloadWarning))
  )
    problems.push('the pass ran out of its budget');
  if (problems.length) failed = true;
  const row = {
    fixture: fx.id,
    height: r0.scrollHeight,
    schedule: `${r0.step}px steps at innerHeight ${r0.ih}`,
    readyMedian: median(readies),
    readySpread: spread(readies),
    passMedian: median(passes),
    restMedian: median(rests),
    maxMessageMB: Number(Math.max(...runs.map((r) => r.maxMB)).toFixed(2)),
    scale: r0.scale,
    budgetRanOut: budget,
    downloadMs: runs.map((r) => r.downloadMs),
    reusedOnDownload: runs.map((r) => r.reused.at(-1)),
    problems,
  };
  rows.push(row);
  console.log(
    `${problems.length ? 'FAIL' : 'ok  '} ${fx.id}: ${r0.scrollHeight} px, ready ${row.readyMedian} ms (${row.readySpread}), pass ${row.passMedian} ms of ${Math.round(passLimit)}, rest ${row.restMedian} ms of ${restLimit}, ${row.maxMessageMB} MB, scale ${row.scale}, ${row.schedule}, Download ${row.downloadMs.join('/')} ms, reused ${row.reusedOnDownload.join('/')}${budget ? ', budget ran out' : ''}${problems.length ? ' :: ' + problems.join('; ') : ''}`,
  );
}
const file = path.join(outDir, `preview-perf-${process.env.HEADED ? 'headed' : 'headless'}.json`);
fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n');
console.log(`\nwrote ${path.relative(root, file)}; downloads in ${path.basename(downloadDir)}`);
await close();
process.exit(failed ? 1 : 0);
