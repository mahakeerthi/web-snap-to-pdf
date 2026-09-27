# Architecture

All paths are relative to `extension/`. There is no build step: the files are loaded as-is.
Extension pages and the service worker are ES modules; the content script is a classic script.

## Modules

### `src/background.js` (service worker, module)

The only place that talks to `chrome.debugger`, `chrome.downloads` and `chrome.contextMenus`.

- `generate({ tabId, settings, prep, output })` is the whole pipeline. It merges `settings` with
  defaults (or loads saved settings when none are passed), rejects a second run on the same tab,
  checks the URL with `isPrintableUrl`, injects `src/content.js` if a `ps:ping` gets no answer, sends
  `ps:prepare`, attaches the debugger (protocol `1.3`), applies media / viewport emulation, calls
  `Page.printToPDF`, then downloads or opens the viewer. A `finally` block always clears
  emulation, detaches the debugger and sends `ps:restore`.
- Single-page mode: emulate print media, set a device-metrics override at the computed layout
  width, wait 200 ms, measure the height via `Page.getLayoutMetrics` (`cssContentSize`, falling back
  to the content script's `ps:measure`), then set `paperHeight = min(200 in, max(1 in, height ×
  scale + top + bottom margins + 0.1 in))`. Page ranges and `preferCSSPageSize` are dropped.
- `printToPdf` retries once without `generateDocumentOutline` if Chrome rejects it, and maps
  debugger-detach errors to "PDF generation was cancelled."
- Output: `download` uses `chrome.downloads.download` with a `data:application/pdf;base64,…` URL
  (`conflictAction: 'uniquify'`, `saveAs` from settings). If that throws, the PDF opens in the
  viewer with `autoDownload: true`. `open` stores a preview job (in a `Map` and best-effort in
  `chrome.storage.session` under `job:<uuid>`, expiring after 15 minutes) and opens
  `src/viewer/viewer.html?job=<uuid>`. `return` (test hook only) returns the base64 data.
- Errors are wrapped in `UserError` so the popup can show the message directly. The toolbar badge
  flashes `✓` or `!` for 4 seconds.
- Registers the five context-menu items (`page`, `article`, `selectElement`, `removeElements`,
  `reset`; contexts `page`, `frame`, `action`) on install and startup, and the `save-pdf` /
  `save-article` commands.
- Exposes `globalThis.__pagesnap` (`generate`, `previewJobs`, `isPrintableUrl`, `startPicker`,
  `pageState`, `resetPage`) for `test/e2e.mjs`.

### `src/content.js` (content script, injected on demand, top frame only)

Guarded by `window.__pagesnapContent` so repeated injection is a no-op. Every temporary change goes
through `setStyle` / `setAttr`, which push an undo function onto `state.undo`; `restore()` pops them
in reverse order. Styles are applied with `!important`.

- `prepare` order: stop picker → restore → find root (article or picked element) → load lazy
  content → isolate root → neutralise fixed/sticky → expand scroll containers → unlock
  `<html>`/`<body>` → scroll to top → wait two animation frames.
- Lazy content: `loading="lazy"` → `eager`; copy `data-src` / `data-lazy-src` / `data-original` into
  empty or `data:` `src`, `data-srcset` into empty `srcset`; scroll the page in 85 %-viewport steps
  (max 250 steps, 50 ms each), then wait up to 6 s for incomplete images.
- Isolation: hide every sibling along the root's ancestor chain (skipping `script`, `style` etc. and
  the extension's own UI), and relax ancestors (`overflow: visible`, `height: auto`, no
  `max-height`, `position: static` if fixed/sticky/absolute, no `transform`).
- Fixed/sticky: fixed elements larger than 60 % of the viewport in both dimensions become
  `static` (app shells); smaller ones are hidden. Sticky elements become `static`. Scans stop after
  25 000 elements.
- Scroll containers: any element with `overflow-y` `auto` / `scroll` / `hidden` whose content
  overflows gets `overflow: visible; height: auto; max-height: none` (limited to the root's subtree
  or ancestors when a root is set).
- Article detection: candidates from a selector list (`article`, `main`, `[role=main]`,
  `[itemprop=articleBody]`, common content classes/ids), or all `div, section, td` (max 4000) if none
  match. Score = text length of `p, li, pre, blockquote, h1-h6, dd, figcaption` minus 1.5 × link
  text. Best score must be ≥ 150; the tightest candidate scoring ≥ 90 % of the best wins.
- Picker: a shadow-DOM overlay (host marked `data-pagesnap-ui`) with a highlight box and a control
  bar. Capture-phase listeners swallow page clicks; ↑/↓ move to parent / first visible child; Esc
  stops. "print" mode stores `state.picked` and sends `ps:generate-from-content` with
  `prep: 'element'`. "remove" mode hides the element with `display: none !important`, recorded in
  `state.removed` (not in `state.undo`, so removals survive `restore()`); the bar offers Undo, Save
  PDF (`prep: 'none'`) and Done.

### `src/lib/paper-sizes.js`

`PAPER_SIZES` (22 portrait sizes in inches: A0-A9, B0-B5, Letter, Legal, Tabloid, Ledger, Folio,
Executive), `getPaperSize(id)` (falls back to A4), `MAX_PAGE_INCHES = 200`,
`CSS_PX_PER_INCH = 96`, `MM_PER_INCH = 25.4`.

### `src/lib/print-params.js`

Pure functions from settings to `Page.printToPDF` parameters.

- `orientedPaper` swaps width/height for landscape; the params always use `landscape: false` with
  the swapped size.
- `marginsInches` converts a preset or custom mm margins to inches.
- `effectiveScale`: `scale` clamped to 0.1-2; if `layoutWidth` is not `auto`, scale =
  printable width (px at 96 dpi) ÷ `layoutWidth`, clamped the same way.
- `buildHeaderFooter` produces `headerTemplate` (title left, date right) and `footerTemplate` (URL
  left, `pageNumber / totalPages` right) using Chrome's template classes.
- `buildPrintParams` raises top/bottom margins to ≥ 0.5 in when header/footer is on, and adds
  `pageRanges` (whitespace removed) only in paged layout. Always `transferMode: 'ReturnAsBase64'`.
- `buildFilename` substitutes `{title}`, `{domain}` (without `www.`), `{date}` (`YYYY-MM-DD`),
  `{time}` (`HH-MM`), then `sanitizeFilename` replaces `\ / : * ? " < > |` and control characters,
  trims dots/spaces and caps at 150 characters; falls back to `page.pdf`.

### `src/lib/settings.js`

Settings schema and defaults (below), `loadSettings` / `saveSettings` (`chrome.storage.sync`, key
`settings`), `normalizeSettings` (merges defaults, deep-merges `margins`, clamps `scale`),
`MARGIN_PRESETS`, `LAYOUT_WIDTHS`, `clamp`.

### `src/popup/`

Renders all paper/layout/content controls, saves changes (debounced 150 ms) and sends
`ps:generate` with the full settings object. "Full page / Article only" is popup-local state
(`contentMode`), never saved. Disables itself when `ps:page-state` reports `printable: false`.
Listens for `ps:progress` to show status. Picker buttons send `ps:start-picker` and close the popup.

### `src/options/`

Edits `filenameTemplate`, `saveAs`, `output`, `expandScroll`, `preferCssPageSize`; links to
`chrome://extensions/shortcuts`; "Reset all settings" writes `DEFAULT_SETTINGS`.

### `src/viewer/`

Reads `?job=<id>`, fetches the job with `ps:get-job`, decodes base64 into a Blob URL, shows it in an
`<iframe>` (Chrome's PDF viewer) and downloads it via `chrome.downloads.download` on click (or
immediately if `autoDownload`). Sends `ps:discard-job` once loaded.

## Message protocol

Every message is `{ type: 'ps:…', ...payload }`. Listeners ignore messages whose `type` does not
start with `ps:`. Handlers reply asynchronously; on any thrown error the reply is
`{ ok: false, error: string }`. When a handler returns nothing, the reply is `{ ok: true }`.

### To the service worker (`chrome.runtime.sendMessage`)

| Type | Sender | Payload | Reply |
|---|---|---|---|
| `ps:generate` | popup | `tabId?` (default: active tab), `prep: 'none' \| 'article' \| 'element'`, `output?: 'download' \| 'open' \| 'return'` (default `settings.output`), `settings?` (default: saved) | `{ ok, filename, bytes }`; with `output: 'return'`: `{ ok, base64, filename }` |
| `ps:generate-from-content` | content script (picker bar) | `prep: 'none' \| 'element'`, `output?`. Tab is `sender.tab.id`; saved settings are used. | as `ps:generate` (the content script ignores it) |
| `ps:start-picker` | popup | `tabId?`, `mode: 'print' \| 'remove'` | content script's reply `{ ok }` |
| `ps:page-state` | popup | `tabId?` | `{ ok, printable, busy, title, url, removed, hasPicked, pickerActive? }` (`pickerActive` only when the content script is present) |
| `ps:reset-page` | popup | `tabId?` | `{ ok }` |
| `ps:get-job` | viewer | `id` | `{ ok, job: { base64, filename, title, autoDownload, createdAt } }` or `{ ok: false, error }` if expired |
| `ps:discard-job` | viewer | `id` | `{ ok }` |

Context-menu clicks and keyboard commands call `generate` / `startPicker` / the `ps:reset-page`
handler directly inside the worker, without messaging.

### From the service worker

| Type | Target | Payload | Reply |
|---|---|---|---|
| `ps:progress` | broadcast (`runtime.sendMessage`; the popup listens) | `tabId`, `stage: 'prepare' \| 'measure' \| 'render' \| 'save' \| 'done'`, `message` | none |
| `ps:ping` | content (`tabs.sendMessage`) | none | `{ ok: true }` |
| `ps:state` | content | none | `{ ok, removed, hasPicked, pickerActive }` |
| `ps:prepare` | content | `prep: 'none' \| 'article' \| 'element'`, `hideFixed`, `loadLazy`, `expandScroll` | `{ ok: true, title }` or `{ ok: false, error }` (no article found / nothing picked) |
| `ps:restore` | content | none | `{ ok: true }` |
| `ps:measure` | content | none | `{ ok, height, width }` (CSS px) |
| `ps:start-picker` | content | `mode` (anything other than `'remove'` means `'print'`) | `{ ok: true }` |
| `ps:reset-page` | content | none | `{ ok: true }` (stops picker, runs `restore()`, un-hides all removals, clears the picked element) |

`ps:stop-picker` is handled by the content script but nothing currently sends it.

## Settings schema

Stored as one object under `settings` in `chrome.storage.sync`. Source: `DEFAULT_SETTINGS` in
`src/lib/settings.js`.

| Key | Type / values | Default | Set in | Notes |
|---|---|---|---|---|
| `format` | paper id from `PAPER_SIZES` | `'A4'` | popup | Unknown ids fall back to A4 |
| `orientation` | `'portrait' \| 'landscape'` | `'portrait'` | popup | |
| `marginPreset` | `'none' \| 'minimal' \| 'default' \| 'wide' \| 'custom'` | `'default'` | popup | 0 / 5 / 10 / 20 mm |
| `margins` | `{ top, right, bottom, left }` in mm | `10` each | popup | Used only when `marginPreset === 'custom'`; popup clamps 0-100 |
| `scale` | number 0.1-2 | `1` | popup | Ignored when `layoutWidth` is not `auto` |
| `layoutWidth` | `'auto' \| '1440' \| '1280' \| '1024' \| '768' \| '375'` (string px) | `'auto'` | popup | Overrides `scale` |
| `layout` | `'paged' \| 'single'` | `'paged'` | popup | |
| `pageRanges` | string, e.g. `'1-3, 5'` | `''` | popup | Paged layout only |
| `preferCssPageSize` | boolean | `false` | options | Forced off in single-page layout |
| `printBackground` | boolean | `true` | popup | |
| `mediaView` | `'print' \| 'screen'` | `'print'` | popup | |
| `hideFixed` | boolean | `true` | popup | |
| `loadLazy` | boolean | `true` | popup | |
| `outline` | boolean | `true` | popup | `generateDocumentOutline` |
| `headerFooter` | boolean | `false` | popup | Forces top/bottom margins ≥ 0.5 in |
| `hfTitle` | boolean | `true` | popup | |
| `hfUrl` | boolean | `true` | popup | |
| `hfDate` | boolean | `true` | popup | |
| `hfPageNumbers` | boolean | `true` | popup | |
| `output` | `'download' \| 'open'` | `'download'` | options | Default action for shortcuts, context menu, picker |
| `filenameTemplate` | string with `{title}` `{domain}` `{date}` `{time}` | `'{title}'` | options | |
| `saveAs` | boolean | `false` | options | Not applied to downloads started from the viewer |
| `expandScroll` | boolean | effectively `true` | options | Not in `DEFAULT_SETTINGS`; read as `settings.expandScroll !== false` |

## Test suites

- `test/e2e.mjs` — pipeline checks through `Page.printToPDF` (paper sizes, single page, header/footer, article, pickers, downloads).
- `test/content.e2e.mjs` — content-script checks against fixtures in `test/fixtures/` (restore correctness, scroll containers, fixed elements, article detection with `data-expect="article"`, picker and shadow DOM). During `ps:prepare` the chosen root is marked with `data-pagesnap-root`, removed on restore.
- `scripts/screenshot-ui.mjs` — renders the popup, options and viewer pages in light and dark mode and fails on page or console errors.
