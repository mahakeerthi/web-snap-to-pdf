# Architecture

All paths are relative to `extension/`. There is no build step: the files are loaded as-is.
Extension pages and the service worker are ES modules; the content script is a classic script.

## Modules

### `src/background.js` (service worker, module)

The only place that talks to `chrome.debugger`, `chrome.downloads` and `chrome.contextMenus`.

- `startPreview(tabId, kind)` opens the preview overlay for the whole page or the article. It sends
  `ps:set-target` to the content script, which opens the overlay in its loading state and then asks for
  the capture itself (see [Preview and image capture](#preview-and-image-capture)). The `activeJobs`
  check and the send have no `await` between them, the same atomic guard as `startPicker`. A repeat
  request for the kind that is already loading returns `{ ok: true }`. Any other request while a job
  holds the tab fails with "Wait for the current export to finish before previewing." The popup cards,
  the two shortcuts and the two menu entries all go through it, so none of them downloads anything.
- `generate({ tabId, settings, prep, output, requestId })` is the PDF pipeline. It merges `settings`
  with defaults (or loads saved settings when none are passed), claims the tab (a second run on the
  same tab is rejected), checks the URL with `isPrintableUrl`, injects `src/content.js` if a `ps:ping`
  gets no answer, sends `ps:prepare`, attaches the debugger (protocol `1.3`), applies media / viewport
  emulation, calls `Page.printToPDF`, then downloads the file. A `finally` block always clears
  emulation, detaches the debugger and sends `ps:restore`. Only the preview overlay's Download calls
  it (`ps:generate-from-content`). No product code sends `ps:generate` any more; tests call
  `__websnap.generate`.
- Cancelling. `activeJobs` is a `Map` from tab id to the job that holds the tab,
  `{ requestId, prep, preview, abort }`, made by `claimTab` (a refused request never touches the
  running job's entry). `ps:cancel-export` aborts the job whose `requestId` matches. The pipelines check
  the job's signal before each screenshot part, before `Page.printToPDF` and before the save step, and
  throw `CaptureAborted`. `withPreparedPage` also sends `ps:abort-prepare` when the signal aborts while
  `ps:prepare` is still running, so the lazy pass stops. A cancel from Close or Esc returns
  `{ ok: false, aborted: true }`: no file, no error, no badge. The `ps:restore` in the `finally` still
  runs after the prepare reply, then the debugger detaches and the tab is released.
- `onDebuggerDetach(source, reason)` is the third abort source. When the user dismisses Chrome's
  "started debugging this browser" bar (`reason === 'canceled_by_user'` only) it aborts the job that
  holds the tab with `DebuggerClosed`, and the pipeline fails with the plain `DEBUGGER_CLOSED` text
  ("The export stopped because Chrome's debugging bar was closed. Try again.") and the `!` badge. A
  closed tab detaches with `target_closed`, navigation fires nothing, and the extension's own
  `chrome.debugger.detach` fires no event (measured), so none of them aborts a job here.
- Single-page mode: emulate print media, set a device-metrics override at the computed layout
  width, wait 200 ms, measure the height via `Page.getLayoutMetrics` (`cssContentSize`, falling back
  to the content script's `ps:measure`), then set the paper height to
  `min(200 in, max(1 in, height × scale + top + bottom margins + 0.1 in))`. Page ranges and
  `preferCSSPageSize` are dropped. Content taller than 200 in produces a `warning` in the reply.
- `printToPdf` retries once without `generateDocumentOutline` if Chrome rejects it.
- `cdp`, `sendContent` and `readyTab` map what Chrome says when the page goes away. A debugger that is
  gone becomes the `DEBUGGER_CLOSED` text. A tab that closes, navigates or restarts mid-export (Chrome's
  "message channel closed" or "No tab with given id N") becomes a `PageGone` error, and the reply
  carries the localised `preview_errorInterrupted` string, so no raw Chrome text or tab id reaches the
  user. The overlay maps the same Chrome texts it sees from `chrome.runtime.sendMessage` to that string
  (`failureText` in `content.js`).
- `captureElement`, `previewElement`, `exportElementImage`: the preview and the PNG / JPEG export of
  the page, the article or a picked element (see
  [Preview and image capture](#preview-and-image-capture)).
- `exportMarkdown(tabId, prep)`: experimental Markdown export (see [Markdown converter](#markdown-converter)).
  Throws `error_markdownDisabled` unless `settings.markdownEnabled` is true, so no caller can bypass
  the opt-in.
- Output: `download(base64, filename, saveAs, mime)` uses `chrome.downloads.download` with a
  `data:<mime>;base64,…` URL (`conflictAction: 'uniquify'`, `saveAs` from settings for every
  format). A file is saved only from the overlay's Download button or a popup Markdown card. Only if a
  PDF download throws does the
  worker store a job (in a `Map` and best-effort in `chrome.storage.session` under `job:<uuid>`,
  expiring after 15 minutes) and open the fallback page `src/viewer/viewer.html?job=<uuid>` with
  `autoDownload: true`. `output: 'return'` (test hook only) returns the data instead.
- `uiStrings(settings)`: English fallbacks `PICKER_STRINGS_EN` merged with the user's language for
  every `picker_*` / `preview_*` key; sent to the content script, which has no access to the
  dictionaries itself.
- Errors are wrapped in `UserError` so the popup / overlay can show the message directly. The toolbar
  badge flashes `✓` or `!` for 4 seconds.
- Registers the five context-menu items (`MENU`: `page` "Preview page", `article` "Preview article",
  `selectElement`, `removeElements`, `reset`; contexts `page`, `frame`, `action`) on install and
  startup (`installMenus`), and handles them in `onMenuClicked`. `onCommand` handles the `save-pdf` /
  `save-article` commands. The `page` and `article` items and both commands call `startPreview`.
  Menu titles are hard-coded English.
- Exposes `globalThis.__websnap` (`generate`, `exportElementImage`, `exportMarkdown`,
  `startPicker`, `pageState`, `resetPage`, `splitRect`, and `command`, `menu` and `debuggerDetached`,
  which call the real shortcut, menu and debugger-detach listeners because tests cannot press a
  shortcut or the debugging bar) for the test suites and screenshot scripts.

### `src/content.js` (content script, injected on demand, top frame only)

Guarded by `window.__websnapContent` so repeated injection is a no-op. Every temporary change goes
through `setStyle` / `setAttr`, which push an undo function onto `state.undo`; `restore()` pops them
in reverse order. Styles are applied with `!important`.

- `prepare` order: stop picker → restore → mark the preview overlay busy if open (until the worker's
  restore) → find root (none for the page, the article, or the picked element) → remember scroll →
  load lazy content, or reuse the shared pass record (below) → hide the preview overlay host if open →
  isolate root → neutralise fixed/sticky → expand scroll containers → unlock `<html>`/`<body>` →
  scroll to top → wait two animation frames. The overlay stays on screen over the lazy scroll and is
  hidden only after the pass and its abort check. Restore shows it again and puts its focus back.
  `ps:prepare` takes the overlay's `requestId`. When Close or Esc aborts it (or the worker sends
  `ps:abort-prepare`), `prepare` returns `{ ok: false, aborted: true, error: 'Cancelled.' }` after the
  restore step, after the lazy pass or before the host hide. It never isolates, and the worker's
  `ps:restore` undoes everything it did. `state.prepared = { prep, root }` is set once the last abort
  check has passed, and `restore()` clears it.
- Lazy content: `loading="lazy"` → `eager`; copy `data-src` / `data-lazy-src` / `data-original` into
  empty or `data:` `src`, `data-srcset` into empty `srcset`; then scroll the whole page from the top
  in steps of 85 % of the real viewport (at least 200 px), holding each position 50 ms, and jump to
  the bottom at the end.
  - Every page gets this schedule, with or without images, lazy-loading markers or a root (article
    or picked element). Nothing on the page changes how fast the scroll goes. A handler that reacts
    within the 50 ms hold gets every position: in the matrix, one throttled at 50 ms or debounced at
    30 ms (`lazyph-lodash50`, `bg-lodash50`, `debounce30-dead8`) loads every image, as on `main`. A
    slower handler gets some positions only, here and on `main` alike: one throttled at 100 ms loads
    about 40 of 60 images, and one debounced at 50 ms is a coin flip on both builds. A list that grows
    only when the window nears the end of the page can grow.
  - The scroll always covers the first 250 positions. Past 250 it stops, and reports incomplete, as
    soon as the page has grown since position 250 (an endless feed), or once the pass has run 30 s
    (a page that does not grow, longer than about 590 positions). A page that does not grow
    otherwise ends at its real end. The 30 s cap is about twice what a 200,000 px page needs (about
    294 positions at about 51 ms each).
  - The pass takes an `AbortSignal`, and every wait in it (the hold at each position, the bottom wait,
    the wait for incomplete images) races the signal. Once it aborts the pass returns at once, without
    scrolling back (the worker's restore does that).
  - `ps:prepare` replies `lazy: { complete }`. `complete` is false when the growth rule or the cap
    stopped the scroll before the end of the page. It does not look at the root, so an export of an
    article or picked element above an endless feed scrolls at least as long as on `main` and warns,
    even when the element was in view the whole time. A root's rectangle says nothing about how much
    of the page was scrolled: a fixed or sticky root stays in view, and a root whose only child is
    floated has a height of its own of a few pixels. `complete` is judged when the loop ends, before
    the jump to the bottom, so a late image or banner that lengthens the page during the bottom wait
    is not a stop. `generate` adds the `status_lazyIncomplete` warning to its reply when `complete`
    is false, and the preview overlay shows it after a PDF Download. Only `generate` turns the flag
    into a warning, so a PNG or JPEG Download and the preview itself show none.
  - Then wait 150 ms at the bottom, scroll back, and wait up to 6 s for incomplete images.
  - Shared pass record (`recordPass`, `usablePassRecord`, `ownWritesDone`). A lazy pass that was not
    aborted while an overlay is open is kept as `state.passRecord`, complete or not, with its
    `complete` flag. Page, article and element Downloads that follow a preview of the same target
    reuse it instead of scrolling the page again, and show the same lazy-load warning the preview's
    pass earned. The reply carries `reused: true`. Only requests with `loadLazy` can use it, so an
    element preview (`loadLazy: false`) never makes or reads one. A record is refused, and a full pass
    runs, when the overlay, the prep or the root differ, when the real viewport's `scrollHeight`
    changed, or when the page changed since the pass ended. A `MutationObserver` watches for that from
    the end of the pass, through the capture and the export, not only after restore: `Page.captureScreenshot`
    with `captureBeyondViewport` resizes the viewport once per part, and a gallery that re-renders on
    resize rebuilt itself during the capture. The extension's own page writes are discarded with
    `takeRecords()` right after each batch (`ownWritesDone`), and changes to its own UI are ignored.
    Closing the overlay, Reselect, Select part and Reset page drop the record.
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
- Picker: a shadow-DOM overlay (host marked `data-websnap-ui`) with a highlight box and a control
  bar built from DOM nodes (Trusted Types safe). Window capture-phase listeners swallow page
  pointer events; ↑/↓ move to parent / first visible child; Esc stops. "print" mode stores
  `state.target = { kind: 'element', el }` and calls `requestPreview()`. "remove" mode hides the
  element with `display: none !important`, recorded in `state.removed` (not in `state.undo`, so
  removals survive `restore()`); the bar offers Undo, Preview and Done. Preview closes the picker and
  opens the page preview (`setTarget('page')`), with the removals still applied. It downloads nothing.
- Preview overlay and Markdown converter: see the sections below.

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

Home screen with three action cards (`act-page`, `act-article`, `act-select`; the first two send
`ps:open-preview` with `kind: 'page'` or `'article'` and, once the reply is `{ ok: true }`, the popup
closes: the export happens from the preview overlay on the page, so the popup never downloads these
two. On an error it stays open and shows the message), Remove
elements, a Reset page link (shown when `removed > 0`), the experimental Markdown row (`md-row`,
shown only when `settings.markdownEnabled`), the Layout segmented control, a summary line of the
effective settings and the collapsible "Export settings" panel (open state in
`chrome.storage.local.popupExportSettingsOpen`). Footer: Help `<dialog>`, Shortcuts, language
`<select>`, version. Settings are saved debounced (150 ms) and flushed before every action, so the
overlay's Download uses the same saved settings; actions send `ps:open-preview`, `ps:export-markdown`
(the Markdown cards still download directly), or `ps:start-picker` (then the popup closes). Disables
the action cards when `ps:page-state` reports `printable: false`.
Listens for `ps:progress` to show status, and for `storage.onChanged` to pick up
`markdownEnabled` / `theme` changes made on the options page.

### `src/options/`

Appearance (theme, language), Saving (`filenameTemplate` with live preview, `saveAs`, `imageScale`),
Page handling (`expandScroll`, `preferCssPageSize`), Keyboard shortcuts (link to
`chrome://extensions/shortcuts`), Experimental (`markdownEnabled`, turned on only after an inline
confirmation box; turning it off needs no confirmation), About, "Reset all settings" (writes
`DEFAULT_SETTINGS`). Follows `storage.onChanged` (ignoring its own echo).

### `src/viewer/`

Internal download fallback only (never opened by a user action): used when `chrome.downloads`
rejects a PDF `data:` URL, e.g. for very large files. Titled "Your PDF is ready". Reads `?job=<id>`, fetches the job with `ps:get-job`, decodes base64 into a Blob URL, shows it in an
`<iframe>` (Chrome's PDF viewer) and downloads it via `chrome.downloads.download` on click (or
immediately if `autoDownload`). Sends `ps:discard-job` once loaded. Themed; not translated.

## Preview and image capture

Every page, article and element export opens the same in-page preview first, and nothing downloads
until the user clicks Download there. The preview is a full-page overlay with a toolbar at the top.
The toolbar holds one Format dropdown (`select.format` inside the overlay's shadow root, labelled
`preview_format`: PDF, PNG, JPEG, plus Markdown when `settings.markdownEnabled`), Download, Copy image
(PNG and JPEG), Reselect or Select part, a light / dark toggle and Close. The overlay has three kinds
of target, held in the content script as `state.target = { kind, el }`:

| Kind      | Opened by                                                             | `prep`      | Title and caption                                       | Pick another part |
| --------- | --------------------------------------------------------------------- | ----------- | ------------------------------------------------------- | ----------------- |
| `page`    | popup Full page, `Alt+Shift+P`, menu Preview page, remove bar Preview | `'none'`    | `preview_titlePage`, `preview_captionSize` (`W×H px`)   | Select part       |
| `article` | popup Article only, `Alt+Shift+A`, menu Preview article               | `'article'` | `preview_titleArticle`, `preview_captionSize`           | Select part       |
| `element` | Select element picker, popup or menu                                  | `'element'` | `preview_title`, `preview_caption` (`div#red · W×H px`) | Reselect          |

`PREP_BY_KIND` maps the kind to the `prep` value the messages carry. For an article the element is
found once, when the target is set. While the overlay is open the capture and every export use that
element, so an export cannot pick a different article than the preview showed. If the element has left
the document by then, they fail with "The selected element is gone. Select it again." Reselect and
Select part close the preview and start the picker in print mode, so the user can pick one element
instead. Both are disabled while the preview loads or any export has the page prepared.

Large targets are split into numbered image parts (`preview_part`: "Part 1 of 3",
`preview_splitNote`) of at most 1600 CSS px each, shown stacked. The preview image itself is a JPEG
(quality 80), whatever format is selected. For PNG and JPEG each part has its own Copy
(`preview_copyPart`) and Download (`preview_downloadPart`), and the toolbar's Download saves all parts
(`preview_downloadAll`). For PDF and Markdown the parts are one file, so the part headers and the split
note are hidden and the slices are drawn joined. The toggle's label is `preview_themeToggle`. Focus
starts on Close, and showing the preview does not move it.

Flow for page and article:

1. The popup card sends `ps:open-preview`. The shortcut or the menu entry calls `startPreview` directly.
   `startPreview` sends `ps:set-target` with `strings` and `theme`.
2. The content script resolves the target (an article that is not found replies an error and changes
   nothing), closes any picker or other preview, opens the overlay in its loading state, replies
   `{ ok: true }` and sends `ps:preview-element` with `prep` and a `requestId` for the capture. The
   popup closes at that reply, before the capture, so the user watches the overlay's "Rendering
   preview…" text.
3. The remove bar's Preview button does the same in the content script (`setTarget('page')`) without
   asking the worker first. If the tab is busy, the capture's `claimTab` refuses and the overlay shows
   the error.

Flow for Select element:

1. Popup / context menu → `startPicker(tabId, 'print')` injects the content script and sends
   `ps:start-picker` with `strings` and `theme`. While an export holds the tab (`activeJobs`) it
   refuses instead. The popup gets `{ ok: false, error }`, and `runLogged` only logs a context-menu failure.
2. A click sets `state.target = { kind: 'element', el }`, stops the picker, opens the overlay in its
   loading state (`requestPreview`) and sends `ps:preview-element`.

Then, for all three kinds:

1. `previewElement` runs `captureElement` at screen resolution (`scale: null`, at most
   `PREVIEW_MAX_PIXELS` = 32 MP) as JPEG parts, then sends `ps:show-preview` with the JPEG data URLs,
   the target's CSS size, a description (`div#red` for an element, empty otherwise), the last-used
   format, the scale-down warning an image export would get, `markdownEnabled`, `strings` and `theme`.
   Every capture carries a `requestId` from `state.previewSeq`, a counter that only grows on the page,
   and the overlay drops a `ps:show-preview` that does not echo its own id. The overlay draws the
   image on a `<canvas>` (an `<img src="data:">` would be subject to the page's CSP `img-src`).
2. Download sends `ps:generate-from-content` (PDF), `ps:export-element {format}` (PNG / JPEG) or
   `ps:export-markdown-from-content`, each with the `prep` of the target. The PDF and image requests
   also carry a `requestId` for the Download. Each re-runs the preparation, so the export matches the
   preview. Page and article previews and their Downloads share one lazy-load pass when the page has
   not changed (see Lazy content above). The format is remembered in
   `chrome.storage.local.previewFormat`. Copy image writes a PNG drawn from the preview canvas to the
   clipboard (the decoded JPEG at screen resolution, not a lossless capture). The write call runs
   synchronously inside the click to keep the user activation, and the PNG is encoded while it waits.

Cancelling. Esc or Close while the preview loads, or while a PDF, PNG or JPEG Download runs, cancels
the job. The overlay aborts its own signal and sends `ps:cancel-export` with the preview's `requestId`
or the Download's id, so a cancel that lands before `ps:prepare` arrives still cancels it. The worker
stops the job within about 1 s, restores the page, detaches the debugger, releases the tab and saves
nothing. A Download can be cancelled until its save step starts. A Markdown Download runs no
`ps:prepare`, has no id and is not cancellable. Dismissing Chrome's debugging bar ends the job the same
way, but with the `DEBUGGER_CLOSED` error in the overlay. While any `ps:prepare` runs, whoever started
it, the overlay is busy (`prepare` marks it from its start until the worker's restore): Download, Copy
image, the Format dropdown and Reselect / Select part are disabled, and Close stays enabled because it
is the cancel.

`captureElement(tabId, { settings, format, scale, quality, maxPixels, part, prep, requestId, preview })`:

- **Attach first, then prepare.** Attaching shows Chrome's debugging info bar, which shrinks the
  viewport with a short animation. A `captureBeyondViewport` screenshot taken while the viewport is
  still resizing repeats the first viewport-height of the clip. `waitForStableViewport` polls
  `innerHeight` via `Runtime.evaluate` every 40 ms until it has not changed for 250 ms (max
  2.5 s). Only then is `ps:prepare` sent, with the target's `prep`, the `requestId`, and `loadLazy`
  false for an element and `settings.loadLazy` for a page or an article.
- **Document-relative clip.** `ps:picked-rect` returns the box of the root that this `prepare`
  stored, after isolation, in document coordinates (`getBoundingClientRect() + scrollX/Y`, rounded
  outwards). For a page it is `0, 0` and the measured width and height, taken after preparation:
  before it, `<html>` can be 0 px tall while the body overflows. With `captureBeyondViewport: true`,
  `Page.captureScreenshot` clip coordinates are document-relative whatever the scroll position
  (verified by a raw CDP test in `test/content.e2e.mjs`).
- **DPR probe.** `clip.scale` is multiplied by the device pixel ratio (including page zoom), but
  `window.devicePixelRatio` is not reliable under emulation. `captureRatio` takes a 100 × 100 px
  capture at `scale: 1` and reads the PNG's IHDR width: ratio = width / 100. The clip then uses
  `scale: outScale / ratio`, so the output is exactly `outScale` pixels per CSS pixel.
- **16 384 px cap.** `MAX_CAPTURE_PX = 16384` (GPU texture limit; beyond it the capture wraps and
  repeats the top). `capScale` limits the scale to `16384 / max(width, height)`, floored to 3
  decimals. When that is below the wanted scale the reply carries `scaledDown` and a
  `preview_warningScaled` warning; the overlay stays open to show it.
- **Cancel.** The job's signal is checked before each `screenshotClip`, and `withPreparedPage` stops
  the pass with `ps:abort-prepare` if the signal aborts first.
- Image export uses `settings.imageScale` clamped to 1-3 (default 2), JPEG quality 92, filename
  `buildFilename(template, meta, 'png' | 'jpg')`.
- `finally`: `ps:restore`, detach, release the per-tab lock (`activeJobs`, shared with PDFs).

## Markdown converter

`toMarkdown(prep)` in `content.js`, dependency-free, runs on the live DOM without `ps:prepare`.
The root comes from `prepRoot(prep)`: `document.body` for the page, the article (the overlay's article
target while its preview is open, otherwise a fresh `findArticle()`), or the picked element. Output is
CommonMark plus GFM tables.

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
  `PICKER_STRINGS_EN` + translation) with `ps:start-picker`, `ps:set-target` and `ps:show-preview`.
  The page, article and element overlays use different title and image-label keys
  (`preview_title*`, `preview_imageAlt*`) and the caption `preview_captionSize`.
- Not translated: context-menu titles, the download fallback page, and error messages generated in the
  background (except `error_markdownDisabled`, the preview strings and the page-gone error, which the
  worker sends as `preview_errorInterrupted`; the `DEBUGGER_CLOSED` text stays English).

Supported: `en`, `es`, `de`, `fr`, `pt_BR`, `hi`, `ja`, `zh_CN` (`SUPPORTED_LANGUAGES`).

## Theme

`settings.theme` is `'system' | 'light' | 'dark'`. `src/lib/theme.js` sets `data-theme` on `<html>`
for light / dark and removes it for system, so CSS falls back to `prefers-color-scheme`. To avoid
a flash of the wrong theme, pages start with `<html data-boot>` and
`html[data-boot] body { visibility: hidden }`; importing the module applies the last theme
synchronously from `localStorage['websnap-theme']`, then confirms it from `chrome.storage.sync`
and follows `storage.onChanged`. The page calls `reveal()` when ready (fallback timeout 400 ms).
The popup header button cycles system → light → dark. The in-page overlay receives `theme` from the
background and resolves `system` with `matchMedia`.

## Message protocol

Every message is `{ type: 'ps:…', ...payload }`. Listeners ignore messages whose `type` does not
start with `ps:`. Handlers reply asynchronously; on any thrown error the reply is
`{ ok: false, error: string }`. When a handler returns nothing, the reply is `{ ok: true }`.

### To the service worker (`chrome.runtime.sendMessage`)

| Type                              | Sender                                 | Payload                                                                                                                                                                                                     | Reply                                                                                                                                      |
| --------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ps:open-preview`                 | popup                                  | `tabId?` (default: active tab), `kind: 'page' \| 'article'`                                                                                                                                                 | `{ ok: true }` once the overlay is open in its loading state (or the same kind is already loading), or `{ ok: false, error }`              |
| `ps:generate-from-content`        | content (preview overlay)              | `prep: 'none' \| 'article' \| 'element'` (default `'none'`), `format?` (`'pdf'`, remembered as preview format), `requestId?` (the Download's id). Always downloads. Tab is `sender.tab.id`; saved settings. | `{ ok, filename, bytes, warning }`, or `{ ok: false, aborted: true }` after Close or Esc                                                   |
| `ps:preview-element`              | content (overlay opened)               | `tabId?` (default `sender.tab.id`), `prep: 'none' \| 'article' \| 'element'` (default `'element'`), `requestId`                                                                                             | `{ ok, width, height, parts, warning }`, or `{ ok: false, aborted: true }` after a cancel; the preview itself arrives as `ps:show-preview` |
| `ps:export-element`               | content (preview overlay)              | `format: 'png' \| 'jpeg'`, `prep` (default `'element'`), `requestId?` (the Download's id), `part?` (1-based), `tabId?`                                                                                      | `{ ok, filename, width, height, scale, warning, bytes }`, or `{ ok: false, aborted: true }` after a cancel                                 |
| `ps:cancel-export`                | content (preview overlay)              | `requestId` (the preview's, or the running Download's)                                                                                                                                                      | `{ ok: true }`. Aborts the job that holds the tab if its `requestId` matches, otherwise does nothing                                       |
| `ps:export-markdown`              | popup                                  | `tabId?`, `prep: 'none' \| 'article'`                                                                                                                                                                       | `{ ok, filename, bytes }`; `{ ok: false }` while `markdownEnabled` is off                                                                  |
| `ps:export-markdown-from-content` | content (preview overlay)              | `prep` (default `'element'`)                                                                                                                                                                                | as `ps:export-markdown`                                                                                                                    |
| `ps:set-theme`                    | content (preview overlay theme toggle) | `theme: 'light' \| 'dark' \| 'system'`                                                                                                                                                                      | `{ ok, theme }`; saves `settings.theme`                                                                                                    |
| `ps:start-picker`                 | popup                                  | `tabId?`, `mode: 'print' \| 'remove'`                                                                                                                                                                       | content script's reply `{ ok }`; `{ ok: false, error }` while an export holds the tab (context-menu failures are only logged)              |
| `ps:page-state`                   | popup                                  | `tabId?`                                                                                                                                                                                                    | `{ ok, printable, busy, title, url, removed, hasPicked, pickerActive?, previewOpen? }` (last two only when the content script is present)  |
| `ps:reset-page`                   | popup                                  | `tabId?`                                                                                                                                                                                                    | `{ ok }`                                                                                                                                   |
| `ps:get-job`                      | viewer (download fallback)             | `id`                                                                                                                                                                                                        | `{ ok, job: { base64, filename, title, autoDownload, createdAt } }` or `{ ok: false, error }` if expired                                   |
| `ps:discard-job`                  | viewer (download fallback)             | `id`                                                                                                                                                                                                        | `{ ok }`                                                                                                                                   |

`ps:preview-element`, `ps:export-element` and `ps:generate-from-content` refuse a `prep` outside
`'none'`, `'article'` and `'element'` with `{ ok: false, error: 'Unknown export target.' }`.
`hasPicked` in `ps:page-state` is true only for an element target (a picked element that is still in
the document), not for a page or article preview. `ps:generate` no longer exists: no product code sends
it, and tests call `__websnap.generate`.

Context-menu clicks and keyboard commands call `startPreview` (Preview page, Preview article and the two
shortcuts), `startPicker` and the `ps:reset-page` handler directly inside the worker, without
messaging.

### From the service worker

| Type               | Target                                               | Payload                                                                                                                                                                                              | Reply                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ps:progress`      | broadcast (`runtime.sendMessage`; the popup listens) | `tabId`, `stage: 'prepare' \| 'measure' \| 'render' \| 'save' \| 'done'`, `message`                                                                                                                  | none                                                                                                                                                                                                                                                            |
| `ps:ping`          | content (`tabs.sendMessage`)                         | none                                                                                                                                                                                                 | `{ ok: true }`                                                                                                                                                                                                                                                  |
| `ps:state`         | content                                              | none                                                                                                                                                                                                 | `{ ok, removed, hasPicked, pickerActive, previewOpen }` (`hasPicked` from an element target)                                                                                                                                                                    |
| `ps:set-target`    | content                                              | `kind: 'page' \| 'article'`, `strings`, `theme`                                                                                                                                                      | `{ ok: true }` once the overlay is open in its loading state, or `{ ok: false, error }` (no article, a preview of another kind loading, an export running)                                                                                                      |
| `ps:prepare`       | content                                              | `prep: 'none' \| 'article' \| 'element'`, `hideFixed`, `loadLazy`, `expandScroll`, `requestId?` (the overlay's preview or Download, so Close or Esc can cancel it)                                   | `{ ok: true, title, lazy, reused? }` (`lazy`: `{ complete }`, `null` without `loadLazy`; `reused: true` when the shared lazy pass was used), `{ ok: false, aborted: true, error: 'Cancelled.' }`, or `{ ok: false, error }` (no article found / nothing picked) |
| `ps:abort-prepare` | content                                              | none                                                                                                                                                                                                 | `{ ok: true }`. Aborts the running `prepare`, otherwise does nothing. Sent when a job's signal aborts while its `ps:prepare` is in flight                                                                                                                       |
| `ps:restore`       | content                                              | none                                                                                                                                                                                                 | `{ ok: true }`                                                                                                                                                                                                                                                  |
| `ps:measure`       | content                                              | none                                                                                                                                                                                                 | `{ ok, height, width }` (CSS px)                                                                                                                                                                                                                                |
| `ps:start-picker`  | content                                              | `mode` (anything other than `'remove'` means `'print'`), `strings`, `theme`                                                                                                                          | `{ ok: true }` (also closes an open preview)                                                                                                                                                                                                                    |
| `ps:picked-rect`   | content                                              | none                                                                                                                                                                                                 | `{ ok, x, y, width, height, devicePixelRatio, description }` (document CSS px) of the root the running `prepare` stored (the page is measured after preparation), or `{ ok: false, error }` with none                                                           |
| `ps:show-preview`  | content                                              | `requestId`, `parts: [{ dataUrl, width, height }]` (each `dataUrl` is `data:image/jpeg;base64,…`), `width`, `height`, `description`, `format`, `imageWarning`, `markdownEnabled`, `strings`, `theme` | `{ ok: true }`; the overlay ignores one whose `requestId` is not its own                                                                                                                                                                                        |
| `ps:to-markdown`   | content                                              | `prep: 'none' \| 'article' \| 'element'`                                                                                                                                                             | `{ ok, markdown, title }` or `{ ok: false, error }`                                                                                                                                                                                                             |
| `ps:reset-page`    | content                                              | none                                                                                                                                                                                                 | `{ ok: true }` (stops picker, closes preview, runs `restore()`, un-hides all removals, clears the target and the shared lazy pass)                                                                                                                              |

`ps:stop-picker` no longer exists.

## Storage

| Area                                   | Key                       | Content                                                                    |
| -------------------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| `chrome.storage.sync`                  | `settings`                | Settings object (schema below)                                             |
| `chrome.storage.local`                 | `popupExportSettingsOpen` | Whether the popup's Export settings panel is open                          |
| `chrome.storage.local`                 | `previewFormat`           | Last format used in the preview overlay (`pdf`, `png`, `jpeg`, `markdown`) |
| `chrome.storage.session`               | `job:<uuid>`              | PDF for the download fallback page (15-minute TTL)                         |
| page `localStorage` (extension origin) | `websnap-theme`           | Theme cache for flash-free startup                                         |

## Settings schema

Stored as one object under `settings` in `chrome.storage.sync`. Source: `DEFAULT_SETTINGS` in
`src/lib/settings.js`.

| Key                                              | Type / values                                                        | Default      | Set in                      | Notes                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------- | ------------ | --------------------------- | ------------------------------------------------------------------ |
| `format`                                         | paper id from `PAPER_SIZES`                                          | `'A4'`       | popup                       | Unknown ids fall back to A4                                        |
| `orientation`                                    | `'portrait' \| 'landscape'`                                          | `'portrait'` | popup                       |                                                                    |
| `marginPreset`                                   | `'none' \| 'minimal' \| 'default' \| 'wide' \| 'custom'`             | `'default'`  | popup                       | 0 / 5 / 10 / 20 mm                                                 |
| `margins`                                        | `{ top, right, bottom, left }` in mm                                 | `10` each    | popup                       | Used only when `marginPreset === 'custom'`; popup clamps 0-100     |
| `scale`                                          | number 0.1-2                                                         | `1`          | popup                       | Ignored when `layoutWidth` is not `auto`                           |
| `layoutWidth`                                    | `'auto' \| '1440' \| '1280' \| '1024' \| '768' \| '375'` (string px) | `'auto'`     | popup                       | Overrides `scale`                                                  |
| `layout`                                         | `'paged' \| 'single'`                                                | `'paged'`    | popup                       |                                                                    |
| `pageRanges`                                     | string, e.g. `'1-3, 5'`                                              | `''`         | popup                       | Paged layout only                                                  |
| `preferCssPageSize`                              | boolean                                                              | `false`      | options                     | Forced off in single-page layout                                   |
| `printBackground`                                | boolean                                                              | `true`       | popup                       |                                                                    |
| `mediaView`                                      | `'print' \| 'screen'`                                                | `'print'`    | popup                       |                                                                    |
| `hideFixed`                                      | boolean                                                              | `true`       | popup                       |                                                                    |
| `loadLazy`                                       | boolean                                                              | `true`       | popup                       | PDF, page and article previews and images. Not element images      |
| `expandScroll`                                   | boolean                                                              | `true`       | options                     | Read as `settings.expandScroll !== false`                          |
| `outline`                                        | boolean                                                              | `true`       | popup                       | `generateDocumentOutline`                                          |
| `headerFooter`                                   | boolean                                                              | `false`      | popup                       | Forces top/bottom margins ≥ 0.5 in                                 |
| `hfTitle` / `hfUrl` / `hfDate` / `hfPageNumbers` | boolean                                                              | `true`       | popup                       |                                                                    |
| `filenameTemplate`                               | string with `{title}` `{domain}` `{date}` `{time}`                   | `'{title}'`  | options                     | Also used for `.png`, `.jpg`, `.md`                                |
| `saveAs`                                         | boolean                                                              | `false`      | options                     | Applies to every format; also used by the fallback page's Download |
| `imageScale`                                     | number 1-3                                                           | `2`          | options                     | Output px per CSS px for PNG / JPEG export; clamped 1-3            |
| `markdownEnabled`                                | boolean                                                              | `false`      | options (with confirmation) | Gates the popup row, the overlay format and the background handler |
| `theme`                                          | `'system' \| 'light' \| 'dark'`                                      | `'system'`   | popup header, options       |                                                                    |
| `language`                                       | `'auto'` or a code from `SUPPORTED_LANGUAGES`                        | `'auto'`     | popup footer, options       |                                                                    |

## Test suites

- `test/e2e.mjs` (`npm test`) — PDF pipeline through `Page.printToPDF` (paper sizes, single page,
  header/footer, screen view, ranges, article, pickers, preview-overlay PDF download, the page PDF
  from the preview against a direct export, large downloads, restricted pages, extension pages load).
- `test/content.e2e.mjs` (`npm run test:content`) — content-script checks against
  `test/fixtures/` (restore correctness, scroll containers, fixed elements, article detection with
  `data-expect="article"`, picker and shadow DOM), the document-relative clip probe, the preview
  overlay for pages, articles and elements (the Format dropdown, shortcuts and menu entries, stale
  previews, Select part, the busy overlay, cancel on Close or Esc, a dismissed debugging bar),
  PNG / JPEG size and pixel checks (including tall elements and the 16 384 px cap) and the Markdown
  converter (`markdown.html`). During `ps:prepare` the chosen root is marked with
  `data-websnap-root`, removed on restore.
- `test/harness.mjs` — shared by both suites, `scripts/screenshot-preview.mjs`,
  `scripts/verify-popup.mjs` and `formal/page-restore/replay-finding.mjs`:
  `launchExtension({ extDir, viewport, headless })` starts the fixture server and Chromium with a
  temp copy of the extension and a temp download folder, and returns
  `{ context, sw, extensionId, base, downloadDir, close }`; `tabIdForUrl(sw, url)` finds the tab a
  page was opened in; `waitForDownload(sw, pred, timeoutMs)` waits for a completed download
  (`test/e2e.mjs`); `createReporter()` returns `{ check, test, summary }` (`ONLY=<regex>` runs
  matching tests only).
- `scripts/verify-popup.mjs` — drives the real popup against a fixture tab, through the preview
  overlay for Full page and Article only, and checks the downloaded file (the `/verify-web-snap-pdf`
  skill).
- `formal/page-restore/` — TLA+ model of the page-restore promise (`check.mjs`) and a regression
  replay of its fixed finding on the real extension (`replay-finding.mjs`); the
  `/verify-page-restore` skill.
- `scripts/screenshot-ui.mjs` (`npm run test:ui`) — renders the popup, options and viewer pages
  in light and dark (plus dynamic states) into `test/out/ui/` and fails on page or console
  errors or missing translation keys.
- `scripts/check-locales.mjs` (`npm run check:locales`) — locale key / placeholder parity.
- `scripts/screenshot-preview.mjs` — preview-overlay screenshots for the docs and the store.
