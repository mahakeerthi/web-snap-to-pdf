// Perf probe for the PDF save step: time from the worker's generate() call to the download's
// "complete" state, for extension builds you name. Build the folders first, for example
//   git archive origin/main extension | tar -x -C /tmp/perf-main
//   git archive <merge base> extension | tar -x -C /tmp/perf-base
// and run
//   node scripts/pdf-save-perf.mjs --main /tmp/perf-main/extension --base /tmp/perf-base/extension \
//     --head extension --fixture big
//   node scripts/pdf-save-perf.mjs --main ... --base ... --head extension --fixture typical
// The gate (head against main) and the load rules are in docs/ARCHITECTURE.md's perf note and the
// PR body. This script changes no production code.
//
// big: 12 noise canvases, about 70 MB. One fresh browser and one export per run, 5 runs per side,
//   gated on head median <= 0.70 x main median.
// typical: a 10-page text page. One launch is the unit: 1 untimed export, then 5 timed ones, 8
//   launches per side. The ratio is the median of head launch medians over the median of main launch
//   medians, with a bootstrap 95 % interval over launches. Pass when the upper bound is <= 1.10,
//   fail when the lower bound is > 1.10, otherwise inconclusive. `--append <results.json>` adds
//   launches to an earlier run.
// A run only starts when the 1-minute load average is at most --max-load. Otherwise the probe
// waits and retries up to 3 times, then reports the slot as not run, which is never a pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { launchExtension, tabIdForUrl } from '../test/harness.mjs';

const { values: args } = parseArgs({
  options: {
    main: { type: 'string' },
    base: { type: 'string' },
    head: { type: 'string' },
    fixture: { type: 'string', default: 'big' },
    runs: { type: 'string', default: '5' },
    launches: { type: 'string', default: '8' },
    timed: { type: 'string', default: '5' },
    lazy: { type: 'boolean', default: false },
    'max-load': { type: 'string', default: '8' },
    wait: { type: 'string', default: '45' },
    'expect-pages': { type: 'string' },
    out: { type: 'string' },
    append: { type: 'string' },
  },
});

const FIXTURES = {
  big: { path: 'big.html?n=12&s=1400', gated: 'ratio70' },
  typical: { path: 'typical.html', gated: 'bootstrap' },
};
const spec = FIXTURES[args.fixture];
if (!spec || !args.main || !args.head) {
  console.error('usage: pdf-save-perf.mjs --main <dir> [--base <dir>] --head <dir> --fixture big|typical');
  process.exit(2);
}
const sides = [['main', args.main], ...(args.base ? [['base', args.base]] : []), ['head', args.head]];
const maxLoad = Number(args['max-load']);
const settingsOver = args.lazy ? { loadLazy: true } : { loadLazy: false };
const nTimed = args.fixture === 'big' ? 1 : Number(args.timed);
const untimed = args.fixture === 'big' ? 0 : 1;
const slotsPerSide = Number(args.fixture === 'big' ? args.runs : args.launches);

// --- statistics ---------------------------------------------------------------------------
const sorted = (a) => [...a].sort((x, y) => x - y);
function quantile(a, q) {
  const s = sorted(a);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}
const median = (a) => quantile(a, 0.5);
function bootstrapRatio(head, main, n = 2000) {
  let seed = 20261115;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const draw = (a) => a.map(() => a[Math.floor(rnd() * a.length)]);
  const r = [];
  for (let i = 0; i < n; i++) r.push(median(draw(head)) / median(draw(main)));
  r.sort((x, y) => x - y);
  return [r[Math.floor(0.025 * n)], r[Math.ceil(0.975 * n) - 1]];
}
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

// --- memory sampler -----------------------------------------------------------------------
function psRows(profile) {
  return new Promise((resolve) => {
    execFile('ps', ['-axww', '-o', 'pid=,rss=,command='], { maxBuffer: 1 << 24 }, (err, out) => {
      if (err) return resolve(null);
      const sums = { extension: 0, browser: 0, profile: 0 };
      for (const line of out.split('\n')) {
        if (!line.includes(profile)) continue;
        const rss = Number(/^\s*\d+\s+(\d+)\s/.exec(line)?.[1] || 0);
        sums.profile += rss;
        if (line.includes('--extension-process')) sums.extension += rss;
        if (!line.includes('--type=')) sums.browser += rss;
      }
      resolve(sums);
    });
  });
}
function startSampler(profile) {
  const peak = { extension: 0, browser: 0, profile: 0 };
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const s = await psRows(profile);
      if (s) for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], s[k]);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return async () => {
    stop = true;
    await loop;
    return peak;
  };
}

// --- one export, timed inside the worker --------------------------------------------------
// Wraps sendCommand and downloads.download for phase timestamps and listens for the download's end.
const installTiming = () => {
  const P = (globalThis.__perf = { cur: null, ended: new Map(), waiters: new Map() });
  chrome.downloads.onChanged.addListener((d) => {
    const state = d.state && d.state.current;
    if (state !== 'complete' && state !== 'interrupted') return;
    const rec = { state, at: performance.now() };
    P.ended.set(d.id, rec);
    P.waiters.get(d.id)?.(rec);
  });
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async function (target, method, params) {
    const cur = P.cur;
    const t0 = performance.now();
    try {
      return await send.call(this, target, method, params);
    } finally {
      const t1 = performance.now();
      if (cur && method === 'Page.printToPDF') Object.assign(cur, { print0: t0, print1: t1 });
      if (cur && (method === 'IO.read' || method === 'IO.close')) cur.read1 = t1;
    }
  };
  const download = chrome.downloads.download;
  chrome.downloads.download = async function (opts) {
    const cur = P.cur;
    if (cur) {
      cur.dl0 = performance.now();
      cur.scheme = String(opts.url).split(':')[0];
    }
    const id = await download.call(this, opts);
    if (cur) Object.assign(cur, { dl1: performance.now(), id });
    return id;
  };
};
const timedExport = ({ tabId, template, settings }) => {
  const P = globalThis.__perf;
  const cur = (P.cur = {});
  cur.t0 = performance.now();
  return globalThis.__websnap
    .generate({ tabId, output: 'download', settings: { filenameTemplate: template, ...settings } })
    .then(async (res) => {
      cur.genDone = performance.now();
      const ended = P.ended.get(cur.id) ?? (await new Promise((resolve) => P.waiters.set(cur.id, resolve)));
      const [item] = await chrome.downloads.search({ id: cur.id });
      const t = (x) => (x == null ? null : x - cur.t0);
      return {
        res,
        state: ended.state,
        error: item.error,
        filename: item.filename,
        scheme: cur.scheme,
        ms: ended.at - cur.t0,
        marks: {
          print0: t(cur.print0),
          print1: t(cur.print1),
          read1: t(cur.read1),
          dl0: t(cur.dl0),
          dl1: t(cur.dl1),
          done: ended.at - cur.t0,
        },
      };
    });
};
// Before print / print / read / restore, Blob and offscreen to download() / download() call / to complete.
function phasesOf(m) {
  const printEnd = m.print1;
  const readEnd = m.read1 ?? m.print1;
  return {
    beforePrint: m.print0,
    print: m.print1 - m.print0,
    read: readEnd - printEnd,
    toDownloadCall: m.dl0 - readEnd,
    downloadCall: m.dl1 - m.dl0,
    toComplete: m.done - m.dl1,
  };
}

function pdfPages(file) {
  const out = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  return Number(/Pages:\s+(\d+)/.exec(out)?.[1] || 0);
}

// --- one launch ---------------------------------------------------------------------------
const launchLog = []; // one entry per launch
const keepers = {}; // side -> copy of the first timed file, for the byte comparison
const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'websnap-perf-'));
let expectedPages = args['expect-pages'] ? Number(args['expect-pages']) : null;
const discards = Object.fromEntries(sides.map(([s]) => [s, 0]));
const notRun = Object.fromEntries(sides.map(([s]) => [s, 0]));

async function waitForLoad(side) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const load = os.loadavg()[0];
    if (load <= maxLoad) return load;
    discards[side]++;
    if (attempt < 3) await new Promise((r) => setTimeout(r, Number(args.wait) * 1000));
  }
  return null;
}

async function runLaunch(side, extDir, launchNo) {
  const load = await waitForLoad(side);
  if (load == null) {
    notRun[side]++;
    console.log(
      `launch ${launchNo} ${side}: not run, load stayed above ${maxLoad} (now ${os.loadavg()[0].toFixed(1)})`,
    );
    return;
  }
  const { context, sw, base, userDataDir, close } = await launchExtension({
    extDir: path.resolve(extDir),
  });
  let stopSampler = null;
  try {
    const url = `${base}/${spec.path}`;
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 180000 });
    const tabId = await tabIdForUrl(sw, url);
    await sw.evaluate(installTiming);
    await new Promise((r) => setTimeout(r, 800));
    const idle = await psRows(userDataDir);
    const samples = [];
    let errors = 0;
    for (let k = 0; k < untimed + nTimed; k++) {
      const timed = k >= untimed;
      if (timed && !stopSampler) stopSampler = startSampler(userDataDir);
      const template = `perf-${side}-${launchNo}-${k}`;
      const x = await sw.evaluate(timedExport, { tabId, template, settings: settingsOver });
      let ok =
        x.state === 'complete' && fs.existsSync(x.filename) && fs.statSync(x.filename).size === x.res.bytes;
      let pages = 0;
      if (ok) {
        pages = pdfPages(x.filename);
        expectedPages ??= pages;
        ok = pages === expectedPages;
      }
      if (side === 'head') ok = ok && x.scheme === 'blob';
      if (!timed) {
        if (!ok) errors++;
        if (ok) fs.rmSync(x.filename, { force: true });
        continue;
      }
      if (!ok) errors++;
      if (ok && !keepers[side]) {
        keepers[side] = path.join(keepDir, `${args.fixture}-${side}.pdf`);
        fs.copyFileSync(x.filename, keepers[side]);
      }
      if (ok) fs.rmSync(x.filename, { force: true });
      samples.push({ ms: x.ms, phases: phasesOf(x.marks), ok, pages, bytes: x.res.bytes });
    }
    const peak = stopSampler ? await stopSampler() : null;
    stopSampler = null;
    const good = samples.filter((s) => s.ok);
    const entry = {
      side,
      launch: launchNo,
      load,
      errors,
      ms: samples.map((s) => s.ms),
      medianMs: good.length ? median(good.map((s) => s.ms)) : null,
      phases: samples.map((s) => s.phases),
      memoryMb:
        peak && idle
          ? Object.fromEntries(Object.keys(peak).map((k) => [k, (peak[k] - idle[k]) / 1024]))
          : null,
    };
    launchLog.push(entry);
    console.log(
      `launch ${launchNo} ${side}: median ${fmt(entry.medianMs)} ms (${entry.ms.map((m) => fmt(m)).join(', ')}) errors ${errors} load ${load.toFixed(1)}`,
    );
  } finally {
    await stopSampler?.();
    await close();
  }
}

// --- report -------------------------------------------------------------------------------
function sideStats(side) {
  const l = launchLog.filter((e) => e.side === side && e.medianMs != null);
  const all = l.flatMap((e) => e.ms);
  const ph = {};
  for (const k of Object.keys(l[0]?.phases[0] || {})) {
    ph[k] = median(l.flatMap((e) => e.phases.map((p) => p[k])));
  }
  const mem = {};
  for (const k of ['extension', 'browser', 'profile']) {
    const v = l.map((e) => e.memoryMb?.[k]).filter((x) => x != null);
    mem[k] = v.length ? median(v) : null;
  }
  return {
    launches: l.length,
    medians: l.map((e) => e.medianMs),
    median: l.length ? median(l.map((e) => e.medianMs)) : null,
    min: Math.min(...all),
    max: Math.max(...all),
    iqr: all.length ? quantile(all, 0.75) - quantile(all, 0.25) : null,
    errors: launchLog.filter((e) => e.side === side).reduce((n, e) => n + e.errors, 0),
    phases: ph,
    mem,
  };
}

function maskDates(buf) {
  let n = 0;
  const text = buf.toString('latin1').replace(/\(D:\d{14}/g, () => (n++, '(D:00000000000000'));
  return { buf: Buffer.from(text, 'latin1'), n };
}

function report() {
  const load = os
    .loadavg()
    .map((x) => x.toFixed(1))
    .join(' ');
  const loads = launchLog.map((e) => e.load);
  console.log(
    `\n=== ${args.fixture} (${spec.path}) ${args.lazy ? 'loadLazy true, not gated' : 'loadLazy false'} ===`,
  );
  console.log(
    `load now ${load}; load at run starts: min ${fmt(Math.min(...loads), 1)}, max ${fmt(Math.max(...loads), 1)}; discards ${JSON.stringify(discards)}; not run ${JSON.stringify(notRun)}`,
  );
  const stats = Object.fromEntries(sides.map(([s]) => [s, sideStats(s)]));
  for (const [s] of sides) {
    const st = stats[s];
    console.log(
      `${s.padEnd(5)} launches ${st.launches}  median ${fmt(st.median)} ms  range ${fmt(st.min)}-${fmt(st.max)}  IQR ${fmt(st.iqr)}  errors ${st.errors}`,
    );
    console.log(
      `      phases (median ms): ${Object.entries(st.phases)
        .map(([k, v]) => `${k} ${fmt(v)}`)
        .join(', ')}`,
    );
    console.log(
      `      peak memory minus idle (median MB): extension ${fmt(st.mem.extension)}, browser ${fmt(st.mem.browser)}, profile ${fmt(st.mem.profile)}`,
    );
  }
  const head = stats.head;
  const main = stats.main;
  if (stats.base) {
    console.log(
      `phase delta head - main (ms): ${Object.keys(head.phases)
        .map((k) => `${k} ${fmt(head.phases[k] - main.phases[k], 1)}`)
        .join(', ')}`,
    );
    console.log(
      `phase delta head - base (ms): ${Object.keys(head.phases)
        .map((k) => `${k} ${fmt(head.phases[k] - stats.base.phases[k], 1)}`)
        .join(', ')}`,
    );
  }

  // Byte comparison (criterion 9).
  const names = Object.keys(keepers);
  const pairs = [
    ['head', 'main'],
    ['head', 'base'],
    ['base', 'main'],
  ].filter(([a, b]) => keepers[a] && keepers[b]);
  for (const [a, b] of pairs) {
    const x = fs.readFileSync(keepers[a]);
    const y = fs.readFileSync(keepers[b]);
    const mx = maskDates(x);
    const my = maskDates(y);
    const same = x.length === y.length && Buffer.compare(mx.buf, my.buf) === 0;
    console.log(
      `${a} vs ${b}: length ${x.length} vs ${y.length}, dates masked ${mx.n}/${my.n}, identical after date mask: ${same ? 'yes' : 'NO'}`,
    );
  }
  if (!names.length) console.log('no file kept for the byte comparison');

  // Verdict.
  let verdict;
  const failedRuns = head.errors + main.errors + (stats.base?.errors || 0);
  const need = slotsPerSide;
  if (!main.launches || !head.launches || main.launches < need || head.launches < need) {
    verdict = `NOT RUN: ${Math.min(main.launches, head.launches)} of ${need} valid launches per side (load above ${maxLoad})`;
  } else if (failedRuns) {
    verdict = `FAIL: ${failedRuns} run(s) failed the file checks`;
  } else if (args.lazy) {
    verdict = `not gated: head/main median ratio ${fmt(head.median / main.median, 3)}`;
  } else if (spec.gated === 'ratio70') {
    const ratio = head.median / main.median;
    const limiter = Object.entries(head.phases).sort((p, q) => q[1] - p[1])[0][0];
    verdict = `${ratio <= 0.7 ? 'PASS' : 'FAIL'}: head/main median ratio ${fmt(ratio, 3)} (limit 0.70, ${fmt((1 - ratio) * 100)} % faster); head's largest phase is ${limiter}${limiter === 'print' ? '' : ', so the result is UNEXPLAINED, not a pass'}`;
  } else {
    const ratio = median(head.medians) / median(main.medians);
    const [lo, hi] = bootstrapRatio(head.medians, main.medians);
    const v = hi <= 1.1 ? 'PASS' : lo > 1.1 ? 'FAIL' : 'INCONCLUSIVE';
    verdict = `${v}: head/main ratio of launch medians ${fmt(ratio, 3)}, 95 % bootstrap interval ${fmt(lo, 3)} to ${fmt(hi, 3)} over ${head.launches} and ${main.launches} launches (limit 1.10); absolute difference ${fmt(head.median - main.median, 1)} ms`;
  }
  console.log(`VERDICT ${args.fixture}: ${verdict}`);
  return { stats, verdict };
}

// --- main ---------------------------------------------------------------------------------
if (args.append) {
  const prev = JSON.parse(fs.readFileSync(args.append, 'utf8'));
  launchLog.push(...prev.launchLog);
  expectedPages ??= prev.expectedPages;
}
const firstLaunch = launchLog.length ? Math.max(...launchLog.map((e) => e.launch)) + 1 : 0;
const rounds = slotsPerSide;
for (let r = 0; r < rounds; r++) {
  const n = firstLaunch + r;
  const order = n % 2 === 0 ? sides : [...sides].reverse();
  for (const [side, dir] of order) await runLaunch(side, dir, n);
}
const out = report();
if (args.out) {
  fs.writeFileSync(args.out, JSON.stringify({ args, expectedPages, launchLog, ...out }, null, 1));
  console.log(`raw results in ${args.out}`);
}
fs.rmSync(keepDir, { recursive: true, force: true });
process.exit(out.verdict.startsWith('PASS') || out.verdict.startsWith('not gated') ? 0 : 1);
