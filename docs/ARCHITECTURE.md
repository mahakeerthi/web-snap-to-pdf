# Architecture

All paths are relative to `extension/`. There is no build step: the files are loaded as-is.
Extension pages and the service worker are ES modules; the content script is a classic script.

## Modules

### `src/background.js` (service worker, module)

The only place that talks to `chrome.debugger`, `chrome.downloads` and `chrome.contextMenus`.

- `generate({ tabId, settings, prep, output })` is the PDF pipeline. It merges `settings` with
  defaults (or loads saved settings when none are passed), rejects a second run on the same tab,
  checks the URL with `isPrintableUrl`, injects `src/content.js` if a `ps:ping` gets no answer, sends
  `ps:prepare`, attaches the debugger (protocol `1.3`), applies media / viewport emulation, calls
  `Page.printToPDF`, then downloads or opens the viewer. A `finally` block always clears
  emulation, detaches the debugger and sends `ps:restore`.
- Single-page mode: emulate print media, set a device-metrics override at the computed layout
  width, wait 200 ms, measure the height via `Page.getLayoutMetrics` (`cssContentSize`, falling back
  to the content script's `ps:measure`), then set the paper height to
  `min(200 in, max(1 in, height × scale + top + bottom margins + 0.1 in))`. Page ranges and
  `preferCSSPageSize` are dropped. Content taller than 200 in produces a `warning` in the reply.
- `printToPdf` retries once without `generateDocumentOutline` if Chrome rejects it, and maps
  debugger-detach errors to "PDF generation was cancelled."
- `captureElement`, `previewElement`, `exportElementImage`: the element preview and PNG / JPEG
  export (see [Preview and image capture](#preview-and-image-capture)).
- `exportMarkdown(tabId, prep)`: experimental Markdown export (see [Markdown converter](#markdown-converter)).
  Throws `error_markdownDisabled` unless `settings.markdownEnabled` is true, so no caller can bypass
  the opt-in.
- Output: `download(base64, filename, saveAs, mime)` uses `chrome.downloads.download` with a
  `data:<mime>;base64,…` URL (`conflictAction: 'uniquify'`, `saveAs` from settings for every
  format). If a PDF download throws, the PDF opens in the viewer with `autoDownload: true`. `open`
  stores a preview job (in a `Map` and best-effort in `chrome.storage.session` under `job:<uuid>`,
  expiring after 15 minutes) and opens `src/viewer/viewer.html?job=<uuid>`. `return` (test hook
  only) returns the data instead.
- `uiStrings(settings)`: English fallbacks `PICKER_STRINGS_EN` merged with the user's language for
  every `picker_*` / `preview_*` key; sent to the content script, which has no access to the
  dictionaries itself.
- Errors are wrapped in `UserError` so the popup / modal can show the message directly. The toolbar
  badge flashes `✓` or `!` for 4 seconds.
- Registers the five context-menu items (`MENU`: `page`, `article`, `selectElement`,
  `removeElements`, `reset`; contexts `page`, `frame`, `action`) on install and startup, and the
  `save-pdf` / `save-article` commands. Menu titles are hard-coded English.
- Exposes `globalThis.__pagesnap` (`generate`, `previewElement`, `exportElementImage`,
  `exportMarkdown`, `PICKER_STRINGS_EN`, `previewJobs`, `isPrintableUrl`, `startPicker`,
  `pageState`, `resetPage`) for the test suites.

### `src/content.js` (content script, injected on demand, top frame only)

Guarded by `window.__pagesnapContent` so repeated injection is a no-op. Every temporary change goes
through `setStyle` / `setAttr`, which push an undo function onto `state.undo`; `restore()` pops them
in reverse order. Styles are applied with `!important`.

- `prepare` order: stop picker → restore → find root (article or picked element) → remember scroll
  → hide the preview modal host if open → load lazy content → isolate root → neutralise
  fixed/sticky → expand scroll containers → unlock `<html>`/`<body>` → scroll to top → wait two
  animation frames.
- Lazy content: `loading="lazy"` → `eager`; copy `data-src` / `data-lazy-src` / `data-original` into
  empty or `data:` `src`, `data-srcset` into empty `srcset`; scroll the page in 85 %-viewport steps
  (max 250 steps, 50 ms each), then wait up to 6 s for incomplete images.
- Isolation: hide every sibling along the root's flat-tree ancestor chain (open shadow roots and
  slots included, skipping `script`, `style` etc. and the extension's own UI), and relax ancestors
  (`overflow: visible`, `height: auto`, no `max-height`, `position: static` if
  fixed/sticky/absolute, no `transform`).
- Fixed/sticky: fixed elements larger than 60 % of the viewport in both dimensions become
  `static` (app shells); smaller ones are hidden. Sticky elements become `static`. Scans read first
  and write afterwards and stop after `MAX_SCAN` = 200 000 elements.
- Scroll containers: any element with `overflow-y` `auto` / `scroll` (or a large `hidden` / `clip`
  pane) whose content overflows is released (`overflow-y: visible`, `overflow-x: clip` for wide
  content, `height: auto`, no `max-height`), then clipping ancestors are released too.
- Article detection: candidates from a selector list (`article`, `main`, `[role=main]`,
  `[itemprop=articleBody]`, common content classes/ids), or all `div, section, td` if none match.
  One pass over text nodes scores text in `p, li, pre, blockquote, h1-h6, dd, figcaption` minus
  1.5 × link text, stopping at boilerplate containers (comments, nav, …). Best score must be ≥ 150;
  the tightest candidate scoring ≥ 90 % of the best wins unless it drops the headline.
- Picker: a shadow-DOM overlay (host marked `data-pagesnap-ui`) with a highlight box and a control
  bar built from DOM nodes (Trusted Types safe). Window capture-phase listeners swallow page
  pointer events; ↑/↓ move to parent / first visible child; Esc stops. "print" mode stores
  `state.picked` and calls `requestPreview()`. "remove" mode hides the element with
  `display: none !important`, recorded in `state.removed` (not in `state.undo`, so removals survive
  `restore()`); the bar offers Undo, Save PDF (`prep: 'none'`) and Done.
- Preview modal and Markdown converter: see the sections below.

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
  The popup also uses it for the summary line, so the summary shows the effective margins.
- `buildFilename(template, meta, ext = 'pdf')` substitutes `{title}`, `{domain}` (without `www.`),
  `{date}` (`YYYY-MM-DD`), `{time}` (`HH-MM`), then `sanitizeFilename` replaces
  `\ / : * ? " < > |` and control characters, trims dots/spaces and caps at 150 characters; falls
  back to `page`. The extension is `pdf`, `png`, `jpg` or `md`.

### `src/lib/settings.js`

Settings schema and defaults (below), `loadSettings` / `saveSettings` (`chrome.storage.sync`, key
`settings`), `normalizeSettings` (merges defaults, deep-merges `margins`, clamps `scale`),
`MARGIN_PRESETS`, `LAYOUT_WIDTHS`, `clamp`.

### `src/lib/i18n.js` and `src/lib/theme.js`

See [Localisation](#localisation) and [Theme](#theme).

### `src/popup/`

Home screen with three action cards (`act-page`, `act-article`, `act-select`), eye buttons
(`act-page-preview`, `act-article-preview`) that run the same prep with `output: 'open'`, Remove
elements, a Reset page link (shown when `removed > 0`), the experimental Markdown row (`md-row`,
shown only when `settings.markdownEnabled`), the Layout segmented control, a summary line of the
effective settings and the collapsible "Export settings" panel (open state in
`chrome.storage.local.popupExportSettingsOpen`). Footer: Help `<dialog>`, Shortcuts, language
`<select>`, version. Settings are saved debounced (150 ms) and flushed before every action; actions
send `ps:generate` with the full settings object, `ps:export-markdown`, or `ps:start-picker` (then
the popup closes). Disables the action cards when `ps:page-state` reports `printable: false`.
Listens for `ps:progress` to show status, and for `storage.onChanged` to pick up
`markdownEnabled` / `theme` changes made on the options page.

### `src/options/`

Appearance (theme, language), Saving (`filenameTemplate` with live preview, `saveAs`, `output`),
Page handling (`expandScroll`, `preferCssPageSize`), Keyboard shortcuts (link to
`chrome://extensions/shortcuts`), Experimental (`markdownEnabled`, turned on only after an inline
confirmation box; turning it off needs no confirmation), About, "Reset all settings" (writes
`DEFAULT_SETTINGS`). Follows `storage.onChanged` (ignoring its own echo).

### `src/viewer/`

Reads `?job=<id>`, fetches the job with `ps:get-job`, decodes base64 into a Blob URL, shows it in an
`<iframe>` (Chrome's PDF viewer) and downloads it via `chrome.downloads.download` on click (or
immediately if `autoDownload`). Sends `ps:discard-job` once loaded. Themed; not translated.

## Preview and image capture

Flow for Select element:

1. Popup / context menu → `startPicker(tabId, 'print')` injects the content script and sends
   `ps:start-picker` with `strings` and `theme`.
2. A click stores `state.picked`, stops the picker, opens the modal in its loading state
   (`requestPreview`) and sends `ps:preview-element`.
3. `previewElement` runs `captureElement` at screen resolution (`scale: null`, at most
   `PREVIEW_MAX_PIXELS` = 32 MP), then sends `ps:show-preview` with a PNG data URL, the element's
   CSS size, a description (`div#red`), the last-used format, the scale-down warning an image export
   would get, `markdownEnabled`, `strings` and `theme`. The modal draws the image on a `<canvas>`
   (an `<img src="data:">` would be subject to the page's CSP `img-src`).
4. Download sends `ps:generate-from-content` (`prep: 'element'`, PDF),
   `ps:export-element {format}` (PNG / JPEG) or `ps:export-markdown-from-content`. Each re-runs the
   preparation, so the export matches the preview. The format is remembered in
   `chrome.storage.local.previewFormat`. Copy image writes the preview PNG (screen resolution) to
   the clipboard synchronously inside the click to keep the user activation.

`captureElement(tabId, { settings, format, scale, quality, maxPixels })`:

- **Attach first, then prepare.** Attaching shows Chrome's debugging info bar, which shrinks the
  viewport with a short animation. A `captureBeyondViewport` screenshot taken while the viewport is
  still resizing repeats the first viewport-height of the clip. `waitForStableViewport` polls
  `innerHeight` via `Runtime.evaluate` every 40 ms until it has not changed for 250 ms (max
  2.5 s). Only then is `ps:prepare` sent (`prep: 'element'`, `loadLazy: false`).
- **Document-relative clip.** `ps:picked-rect` returns the element's box after isolation in
  document coordinates (`getBoundingClientRect() + scrollX/Y`, rounded outwards). With
  `captureBeyondViewport: true`, `Page.captureScreenshot` clip coordinates are document-relative
  whatever the scroll position (verified by a raw CDP test in `test/content.e2e.mjs`).
- **DPR probe.** `clip.scale` is multiplied by the device pixel ratio (including page zoom), but
  `window.devicePixelRatio` is not reliable under emulation. `captureRatio` takes a 100 × 100 px
  capture at `scale: 1` and reads the PNG's IHDR width: ratio = width / 100. The clip then uses
  `scale: outScale / ratio`, so the output is exactly `outScale` pixels per CSS pixel.
- **16 384 px cap.** `MAX_CAPTURE_PX = 16384` (GPU texture limit; beyond it the capture wraps and
  repeats the top). `capScale` limits the scale to `16384 / max(width, height)`, floored to 3
  decimals. When that is below the wanted scale the reply carries `scaledDown` and a
  `preview_warningScaled` warning; the modal stays open to show it.
- Image export uses `settings.imageScale` clamped to 1-3 (default 2), JPEG quality 92, filename
  `buildFilename(template, meta, 'png' | 'jpg')`.
- `finally`: `ps:restore`, detach, release the per-tab lock (`activeJobs`, shared with PDFs).

## Markdown converter

`toMarkdown(prep)` in `content.js`, dependency-free, runs on the live DOM without `ps:prepare`:
root is `document.body`, the detected article, or `state.picked`. Output is CommonMark plus GFM
tables.

- Walks the flat tree (open shadow roots, slot-assigned nodes). Skips `display: none` elements
  (including the user's removals), the extension's UI, and `script`, `style`, `svg`, `iframe`,
  `canvas`, `video`, `audio`, `object`, `embed`, `select` etc.
- Block vs inline from the tag or computed `display`. Headings `#`…`######`, paragraphs, `---`,
  blockquotes `> `, ordered (honours `start`) / unordered lists with nested indentation,
  definition lists (`**term**` + definitions), fenced code blocks (language from
  `language-*` / `lang-*` classes, fence longer than any backtick run inside), inline code, `**`,
  `_`, `~~`, links (absolute URLs, `javascript:` dropped), images.
- Code blocks are stored as placeholders and re-inserted after whitespace normalisation, so their
  content is never touched.
- Adds `# <document.title>` when the root has no `<h1>`, and a final `Source: <url>` line.
- Known limitations: `data:` images over 2 KB dropped (alt kept); backslash, backtick, `*`, `_`,
  `[`, `]` and `<` escaped everywhere (`snake_case` → `snake\_case`); `visibility: hidden` elements exported;
  tables: no rowspan, colspan → empty cells, first row always the header, `<br>` inside cells;
  `sup`/`sub`/`mark`/`u`, task lists and reversed lists not handled; multi-paragraph list items
  merged; closed shadow roots and iframes excluded; no lazy-loading or fixed-bar handling.

The background converts the string to UTF-8 base64 and downloads it as `text/markdown` with the
`.md` filename.

## Localisation

Two mechanisms, both reading `_locales/<code>/messages.json` (Chrome's format,
`{ key: { message, description } }`; `en` is the reference and `npm run check:locales` verifies
that every locale has the same keys and `$N` placeholders and that `extDescription` fits 132
characters):

- **Manifest strings** (`__MSG_extName__`, `extDescription`, `actionTitle`, `cmdSavePdf`,
  `cmdSaveArticle`) are resolved by Chrome from the browser UI language (`default_locale: "en"`).
- **In-app UI**: `chrome.i18n` cannot switch language at runtime, so `src/lib/i18n.js` fetches the
  dictionary for `settings.language` (`'auto'` → `navigator.language`, full code such as `pt_BR`
  first, then the base language, then `en`) and merges it over English.
  `applyTranslations(root, messages)` fills `data-i18n`, `data-i18n-title`,
  `data-i18n-placeholder` and `data-i18n-aria-label`; missing keys leave the English HTML in place. `t(messages, key, subs)`
  substitutes `$1…$n`.
- **Content script**: the background sends the `picker_*` / `preview_*` strings (English fallback
  `PICKER_STRINGS_EN` + translation) with `ps:start-picker` and `ps:show-preview`.
- Not translated: context-menu titles, the viewer page, and error messages generated in the
  background (except `error_markdownDisabled` and the preview strings).

Supported: `en`, `es`, `de`, `fr`, `pt_BR`, `hi`, `ja`, `zh_CN` (`SUPPORTED_LANGUAGES`).

## Theme

`settings.theme` is `'system' | 'light' | 'dark'`. `src/lib/theme.js` sets `data-theme` on `<html>`
for light / dark and removes it for system, so CSS falls back to `prefers-color-scheme`. To avoid
a flash of the wrong theme, pages start with `<html data-boot>` and
`html[data-boot] body { visibility: hidden }`; importing the module applies the last theme
synchronously from `localStorage['pagesnap-theme']`, then confirms it from `chrome.storage.sync`
and follows `storage.onChanged`. The page calls `reveal()` when ready (fallback timeout 400 ms).
The popup header button cycles system → light → dark. The in-page modal receives `theme` from the
background and resolves `system` with `matchMedia`.

## Message protocol

Every message is `{ type: 'ps:…', ...payload }`. Listeners ignore messages whose `type` does not
start with `ps:`. Handlers reply asynchronously; on any thrown error the reply is
`{ ok: false, error: string }`. When a handler returns nothing, the reply is `{ ok: true }`.

### To the service worker (`chrome.runtime.sendMessage`)

| Type                              | Sender                              | Payload                                                                                                                                                                         | Reply                                                                                                                                     |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ps:generate`                     | popup                               | `tabId?` (default: active tab), `prep: 'none' \| 'article' \| 'element'`, `output?: 'download' \| 'open' \| 'return'` (default `settings.output`), `settings?` (default: saved) | `{ ok, filename, bytes, warning }`; with `output: 'return'`: `{ ok, base64, filename, warning }`                                          |
| `ps:generate-from-content`        | content (remove bar, preview modal) | `prep: 'none' \| 'element'`, `output?`, `format?` (`'pdf'`, remembered as preview format). Tab is `sender.tab.id`; saved settings.                                              | as `ps:generate`                                                                                                                          |
| `ps:preview-element`              | content (picker click)              | `tabId?` (default `sender.tab.id`)                                                                                                                                              | `{ ok, width, height, warning }`; the preview itself arrives as `ps:show-preview`                                                         |
| `ps:export-element`               | content (preview modal)             | `format: 'png' \| 'jpeg'`, `tabId?`                                                                                                                                             | `{ ok, filename, width, height, scale, warning, bytes }`                                                                                  |
| `ps:export-markdown`              | popup                               | `tabId?`, `prep: 'none' \| 'article'`                                                                                                                                           | `{ ok, filename, bytes }`; `{ ok: false }` while `markdownEnabled` is off                                                                 |
| `ps:export-markdown-from-content` | content (preview modal)             | `prep` (default `'element'`)                                                                                                                                                    | as `ps:export-markdown`                                                                                                                   |
| `ps:start-picker`                 | popup                               | `tabId?`, `mode: 'print' \| 'remove'`                                                                                                                                           | content script's reply `{ ok }`                                                                                                           |
| `ps:page-state`                   | popup                               | `tabId?`                                                                                                                                                                        | `{ ok, printable, busy, title, url, removed, hasPicked, pickerActive?, previewOpen? }` (last two only when the content script is present) |
| `ps:reset-page`                   | popup                               | `tabId?`                                                                                                                                                                        | `{ ok }`                                                                                                                                  |
| `ps:get-job`                      | viewer                              | `id`                                                                                                                                                                            | `{ ok, job: { base64, filename, title, autoDownload, createdAt } }` or `{ ok: false, error }` if expired                                  |
| `ps:discard-job`                  | viewer                              | `id`                                                                                                                                                                            | `{ ok }`                                                                                                                                  |

Context-menu clicks and keyboard commands call `generate` / `startPicker` / the `ps:reset-page`
handler directly inside the worker, without messaging.

### From the service worker

| Type                | Target                                               | Payload                                                                                                      | Reply                                                                                                             |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ps:progress`       | broadcast (`runtime.sendMessage`; the popup listens) | `tabId`, `stage: 'prepare' \| 'measure' \| 'render' \| 'save' \| 'done'`, `message`                          | none                                                                                                              |
| `ps:ping`           | content (`tabs.sendMessage`)                         | none                                                                                                         | `{ ok: true }`                                                                                                    |
| `ps:state`          | content                                              | none                                                                                                         | `{ ok, removed, hasPicked, pickerActive, previewOpen }`                                                           |
| `ps:prepare`        | content                                              | `prep: 'none' \| 'article' \| 'element'`, `hideFixed`, `loadLazy`, `expandScroll`                            | `{ ok: true, title }` or `{ ok: false, error }` (no article found / nothing picked)                               |
| `ps:restore`        | content                                              | none                                                                                                         | `{ ok: true }`                                                                                                    |
| `ps:measure`        | content                                              | none                                                                                                         | `{ ok, height, width }` (CSS px)                                                                                  |
| `ps:start-picker`   | content                                              | `mode` (anything other than `'remove'` means `'print'`), `strings`, `theme`                                  | `{ ok: true }` (also closes an open preview)                                                                      |
| `ps:picked-rect`    | content                                              | none                                                                                                         | `{ ok, x, y, width, height, devicePixelRatio, description }` (document CSS px) or `{ ok: false, error }`          |
| `ps:show-preview`   | content                                              | `dataUrl`, `width`, `height`, `description`, `format`, `imageWarning`, `markdownEnabled`, `strings`, `theme` | `{ ok: true }`                                                                                                    |
| `ps:cancel-preview` | content                                              | none                                                                                                         | `{ ok: true }` (closes the modal)                                                                                 |
| `ps:to-markdown`    | content                                              | `prep: 'none' \| 'article' \| 'element'`                                                                     | `{ ok, markdown, title }` or `{ ok: false, error }`                                                               |
| `ps:reset-page`     | content                                              | none                                                                                                         | `{ ok: true }` (stops picker, closes preview, runs `restore()`, un-hides all removals, clears the picked element) |

`ps:cancel-preview` is handled by the content script but nothing currently sends it.
`ps:stop-picker` no longer exists.

## Storage

| Area                                   | Key                       | Content                                                                  |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `chrome.storage.sync`                  | `settings`                | Settings object (schema below)                                           |
| `chrome.storage.local`                 | `popupExportSettingsOpen` | Whether the popup's Export settings panel is open                        |
| `chrome.storage.local`                 | `previewFormat`           | Last format used in the preview modal (`pdf`, `png`, `jpeg`, `markdown`) |
| `chrome.storage.session`               | `job:<uuid>`              | Preview PDF for the viewer tab (15-minute TTL)                           |
| page `localStorage` (extension origin) | `pagesnap-theme`          | Theme cache for flash-free startup                                       |

## Settings schema

Stored as one object under `settings` in `chrome.storage.sync`. Source: `DEFAULT_SETTINGS` in
`src/lib/settings.js`.

| Key                                              | Type / values                                                        | Default      | Set in                      | Notes                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------- | ------------ | --------------------------- | ---------------------------------------------------------------------------------- |
| `format`                                         | paper id from `PAPER_SIZES`                                          | `'A4'`       | popup                       | Unknown ids fall back to A4                                                        |
| `orientation`                                    | `'portrait' \| 'landscape'`                                          | `'portrait'` | popup                       |                                                                                    |
| `marginPreset`                                   | `'none' \| 'minimal' \| 'default' \| 'wide' \| 'custom'`             | `'default'`  | popup                       | 0 / 5 / 10 / 20 mm                                                                 |
| `margins`                                        | `{ top, right, bottom, left }` in mm                                 | `10` each    | popup                       | Used only when `marginPreset === 'custom'`; popup clamps 0-100                     |
| `scale`                                          | number 0.1-2                                                         | `1`          | popup                       | Ignored when `layoutWidth` is not `auto`                                           |
| `layoutWidth`                                    | `'auto' \| '1440' \| '1280' \| '1024' \| '768' \| '375'` (string px) | `'auto'`     | popup                       | Overrides `scale`                                                                  |
| `layout`                                         | `'paged' \| 'single'`                                                | `'paged'`    | popup                       |                                                                                    |
| `pageRanges`                                     | string, e.g. `'1-3, 5'`                                              | `''`         | popup                       | Paged layout only                                                                  |
| `preferCssPageSize`                              | boolean                                                              | `false`      | options                     | Forced off in single-page layout                                                   |
| `printBackground`                                | boolean                                                              | `true`       | popup                       |                                                                                    |
| `mediaView`                                      | `'print' \| 'screen'`                                                | `'print'`    | popup                       |                                                                                    |
| `hideFixed`                                      | boolean                                                              | `true`       | popup                       |                                                                                    |
| `loadLazy`                                       | boolean                                                              | `true`       | popup                       | Not used for image capture                                                         |
| `expandScroll`                                   | boolean                                                              | `true`       | options                     | Read as `settings.expandScroll !== false`                                          |
| `outline`                                        | boolean                                                              | `true`       | popup                       | `generateDocumentOutline`                                                          |
| `headerFooter`                                   | boolean                                                              | `false`      | popup                       | Forces top/bottom margins ≥ 0.5 in                                                 |
| `hfTitle` / `hfUrl` / `hfDate` / `hfPageNumbers` | boolean                                                              | `true`       | popup                       |                                                                                    |
| `output`                                         | `'download' \| 'open'`                                               | `'download'` | options                     | Default action for shortcuts, context menu, picker bar and the preview modal's PDF |
| `filenameTemplate`                               | string with `{title}` `{domain}` `{date}` `{time}`                   | `'{title}'`  | options                     | Also used for `.png`, `.jpg`, `.md`                                                |
| `saveAs`                                         | boolean                                                              | `false`      | options                     | Applies to every format; also used by the viewer's Download                        |
| `imageScale`                                     | number 1-3                                                           | `2`          | options                     | Output px per CSS px for PNG / JPEG export; clamped 1-3                            |
| `markdownEnabled`                                | boolean                                                              | `false`      | options (with confirmation) | Gates the popup row, the modal format and the background handler                   |
| `theme`                                          | `'system' \| 'light' \| 'dark'`                                      | `'system'`   | popup header, options       |                                                                                    |
| `language`                                       | `'auto'` or a code from `SUPPORTED_LANGUAGES`                        | `'auto'`     | popup footer, options       |                                                                                    |

## Test suites

- `test/e2e.mjs` (`npm test`) — PDF pipeline through `Page.printToPDF` (paper sizes, single page,
  header/footer, screen view, ranges, article, pickers, preview-modal PDF download, large
  downloads, restricted pages, extension pages load).
- `test/content.e2e.mjs` (`npm run test:content`) — content-script checks against
  `test/fixtures/` (restore correctness, scroll containers, fixed elements, article detection with
  `data-expect="article"`, picker and shadow DOM), the document-relative clip probe, preview modal,
  PNG / JPEG size and pixel checks (including tall elements and the 16 384 px cap) and the Markdown
  converter (`markdown.html`). During `ps:prepare` the chosen root is marked with
  `data-pagesnap-root`, removed on restore.
- `scripts/screenshot-ui.mjs` (`npm run test:ui`) — renders the popup, options and viewer pages
  in light and dark (plus dynamic states) into `test/out/ui/` and fails on page or console
  errors or missing translation keys.
- `scripts/check-locales.mjs` (`npm run check:locales`) — locale key / placeholder parity.
- `scripts/screenshot-preview.mjs` — preview-modal screenshots for the docs and the store.
