// Regression replay of the fixed PageRestore finding: both paths that left an element hidden when
// the picker opened during an export, on the real extension (test/fixtures/article.html,
// X = #sidebar) during a real article export, so activeJobs holds the tab throughout.
// Usage: node formal/page-restore/replay-finding.mjs   (EXT_DIR=<dir> replays another build)
//   exit 0  expected: neither path reproduced
//   exit 1  regression: on at least one path #sidebar stays hidden with 0 removals after "Restore all"
//   exit 2  inconclusive: the export ended before the picker steps ran, or the replay failed
import path from 'node:path';
import { launchExtension, tabIdForUrl } from '../../test/harness.mjs';

const FILLER_PARAGRAPHS = 1500;
const PICKER = '[data-websnap-ui=""]';
// renderBar's remove-mode bar: [text, count?, Undo, Save PDF, Done]. Undo has no class or id.
const UNDO_BUTTON = '.bar > button:first-of-type';

class Inconclusive extends Error {}

const { context, sw, base, close } = await launchExtension({
  extDir: process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : undefined,
  viewport: { width: 1200, height: 800 },
}).catch((err) => {
  console.error(err);
  process.exit(2);
});

const hook = (fn, ...args) =>
  sw.evaluate(({ fn, args }) => globalThis.__websnap[fn](...args).catch((e) => ({ error: e.message })), {
    fn,
    args,
  });

async function openArticle() {
  const page = await context.newPage();
  await page.goto(`${base}/article.html`, { waitUntil: 'load' });
  await page.bringToFront();
  // Inside the article root, so the export output is unchanged; it only makes loadLazyContent and
  // printToPDF slow enough to act between the steps of one export.
  await page.evaluate(
    (n) => document.getElementById('body').insertAdjacentHTML('beforeend', '<p>filler</p>'.repeat(n)),
    FILLER_PARAGRAPHS,
  );
  const tabId = await tabIdForUrl(sw, page.url());

  const contentState = () => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'ps:state' }), tabId);
  const sidebar = () =>
    page.evaluate(() => {
      const el = document.getElementById('sidebar');
      const r = el.getBoundingClientRect();
      return {
        css: el.style.cssText || '(page value)',
        hidden: el.style.display === 'none',
        x: r.left + 4,
        y: r.top + 4,
      };
    });
  const pickerOpen = () => page.evaluate((s) => !!document.querySelector(s), PICKER);
  const pickerTag = () =>
    page.evaluate(
      (s) => document.querySelector(s)?.shadowRoot.querySelector('.tag').textContent ?? '',
      PICKER,
    );
  // isolate() hides the footer (a sibling of an ancestor of the root) until ps:restore.
  const isolated = () => page.evaluate(() => document.querySelector('footer').style.display === 'none');

  async function startExport() {
    await sw.evaluate((id) => {
      globalThis.__replayExport = globalThis.__websnap
        .generate({ tabId: id, prep: 'article', output: 'return', settings: { loadLazy: true } })
        .then(
          () => ({ ok: true }),
          (e) => ({ error: e.message }),
        );
    }, tabId);
  }

  async function until(fn, label, tries = 1000) {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return;
      await page.waitForTimeout(10);
    }
    throw new Inconclusive(`timed out waiting for ${label}`);
  }

  async function openPickerDuringExport() {
    const busy = (await hook('pageState', tabId)).busy;
    if (!busy) throw new Inconclusive('the export was not running when the picker was requested');
    const res = await hook('startPicker', tabId, 'remove');
    const open = await pickerOpen();
    console.log(
      `  startPicker while pageState.busy: ${JSON.stringify(res)}, picker ${open ? 'open' : 'not open'}`,
    );
    return open;
  }

  async function finish() {
    const result = await sw.evaluate(() => globalThis.__replayExport);
    console.log(`  export: ${JSON.stringify(result)}`);
    await page.keyboard.press('Escape');
    const before = { css: (await sidebar()).css, removed: (await contentState()).removed };
    console.log(`  after the export: #sidebar ${before.css}, ${before.removed} removed`);
    console.log(`  "Restore all removed elements": ${JSON.stringify(await hook('resetPage', tabId))}`);
    const s = await sidebar();
    const removed = (await contentState()).removed;
    console.log(`  after "Restore all": #sidebar ${s.css}, ${removed} removed`);
    await page.close();
    return s.hidden && removed === 0;
  }

  return {
    page,
    tabId,
    sidebar,
    pickerOpen,
    pickerTag,
    isolated,
    startExport,
    until,
    openPickerDuringExport,
    finish,
    contentState,
  };
}

// TLC trace, StartPicker guard removed and no loading window: the user removes X, an export
// isolates the root (snapshotting X's `none !important`), the picker opens and Undo shows X, and
// ps:restore writes the snapshot back.
async function undoPath() {
  const a = await openArticle();
  await hook('startPicker', a.tabId, 'remove');
  const s0 = await a.sidebar();
  await a.page.mouse.move(s0.x, s0.y);
  await a.page.mouse.click(s0.x, s0.y);
  await a.page.keyboard.press('Escape');
  const removedFirst = (await a.contentState()).removed;
  console.log(`  user removes #sidebar: ${(await a.sidebar()).css}, ${removedFirst} removed`);
  if (removedFirst !== 1) throw new Inconclusive('the remove picker did not remove #sidebar');

  await a.startExport();
  await a.until(a.isolated, 'isolate() to hide the footer');
  if (await a.openPickerDuringExport()) {
    const undo = await a.page.evaluate(
      ({ picker, button }) => {
        const b = document.querySelector(picker).shadowRoot.querySelector(button).getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      },
      { picker: PICKER, button: UNDO_BUTTON },
    );
    await a.page.mouse.click(undo.x, undo.y);
    const removed = (await a.contentState()).removed;
    console.log(`  Undo in the picker bar: #sidebar ${(await a.sidebar()).css}, ${removed} removed`);
    // Save PDF and Done close the picker; Undo keeps it open, even when a fix makes it refuse.
    if (!(await a.pickerOpen())) throw new Inconclusive(`${UNDO_BUTTON} is not the Undo button`);
    if (!(await a.isolated())) throw new Inconclusive('ps:restore ran before Undo');
  }
  return a.finish();
}

// TLC trace, StartPicker guard removed: during an export's loading window the picker opens and the
// pointer rests on X; isolate() hides X; a click picks the stale p.current and records
// `none !important` as X's own value.
async function staleHoverPath() {
  const a = await openArticle();
  await a.startExport();
  await a.until(
    () => a.page.evaluate(() => !!document.querySelector('[data-websnap-root]')),
    'prepare() to mark the root',
  );
  if ((await a.sidebar()).hidden) throw new Inconclusive('isolate() ran before the picker could open');
  if (await a.openPickerDuringExport()) {
    for (let i = 0; i < 50 && !(await a.pickerTag()).startsWith('aside#sidebar'); i++) {
      const s = await a.sidebar();
      if (s.hidden) break;
      await a.page.mouse.move(s.x, s.y);
    }
    const tag = await a.pickerTag();
    console.log(`  pointer on #sidebar, picker highlights: ${tag}`);
    if (!tag.startsWith('aside#sidebar')) throw new Inconclusive('isolate() ran before the hover landed');
    await a.until(async () => (await a.sidebar()).hidden, 'isolate() to hide #sidebar');
    console.log(`  isolate(): #sidebar ${(await a.sidebar()).css}`);
    await a.page.mouse.down();
    await a.page.mouse.up();
    console.log(`  click without moving: ${(await a.contentState()).removed} removed`);
    if (!(await a.isolated())) throw new Inconclusive('ps:restore ran before the click');
  }
  return a.finish();
}

console.log(
  `Article export with loadLazy on; ${FILLER_PARAGRAPHS} filler paragraphs added to the article ` +
    '(page.evaluate, fixture file unchanged) to widen the windows between export steps.',
);
const results = {};
let code = 2;
try {
  for (const [name, run] of [
    ['Undo path', undoPath],
    ['stale-hover path', staleHoverPath],
  ]) {
    console.log(`\n${name}:`);
    try {
      results[name] = (await run()) ? 'REPRODUCED' : 'not reproduced';
    } catch (err) {
      if (!(err instanceof Inconclusive)) throw err;
      results[name] = `inconclusive (${err.message})`;
    }
    console.log(`  ${name}: ${results[name]}`);
  }
  const values = Object.values(results);
  code = values.includes('REPRODUCED') ? 1 : values.every((v) => v === 'not reproduced') ? 0 : 2;
} catch (err) {
  console.error(err);
} finally {
  await close();
}
console.log(`\n${JSON.stringify(results)}`);
process.exit(code);
