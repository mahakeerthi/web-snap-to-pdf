# PageSnap PDF

A Chrome extension (Manifest V3) that saves the current web page as a PDF in one click. It uses
Chrome's own print engine (`Page.printToPDF` through `chrome.debugger`), so styles and clickable
links are kept and nothing ever leaves your machine.

PageSnap PDF is an independent, from-scratch implementation of the feature set of the "Web to PDF"
extension. It shares no code or branding with it, and everything is free: there is no account,
licence key or paid tier.

Requires Chrome 128 or newer (`minimum_chrome_version` in the manifest).

## Features

### Compared with the original

"Same" means the feature exists here too; the implementation is our own. The comparison covers
only the features listed below; it is not a full audit of the original.

| Feature | Status | Notes |
|---|---|---|
| One-click save of the current page | Same | Popup button, context menu, `Alt+Shift+P` |
| Chrome's native PDF engine, runs locally | Same | `chrome.debugger` + `Page.printToPDF` |
| Keeps styles and clickable links | Same | Links become PDF link annotations |
| Paged or single-page layout | Same | Single page is one tall page, capped at 200 in |
| 22 paper formats | Same | A0-A9, B0-B5, Letter, Legal, Tabloid, Ledger, Folio, Executive |
| Portrait / landscape | Same | |
| Margin presets and custom margins | Same | None 0, Minimal 5, Default 10, Wide 20 mm, or per-side mm |
| Scale or layout-width fitting | Same | Scale 10-200 %, or lay out at 1440/1280/1024/768/375 px |
| Header / footer (title, date, URL, page numbers) | Same | |
| Print vs screen CSS | Same | |
| Page ranges | Same | Paged layout only |
| PDF bookmarks from headings | Same | Chrome's document outline |
| Auto-scroll to load lazy images | Same | |
| Hide sticky / fixed bars | Same | |
| Expand inner scroll areas (chat apps) | Same | Options page toggle |
| Article only | Same | Heuristic main-content detection |
| Select element picker | Same | |
| Remove elements picker with undo / reset | Same | |
| Preview tab | Same | Built-in viewer page, then download |
| Filename template | Same | `{title}` `{domain}` `{date}` `{time}` |
| Context menu and keyboard shortcuts | Same | |
| Options page | Same | |
| Everything free | Different | No licensing or paywall, by design |
| Online converter (website) | Not included | Extension only |
| HTML file to PDF | Not included | Converts open tabs only (see Limitations for `file://`) |
| Paid tier | Not included | |

### PageSnap-specific details

- Toolbar badge shows `✓` or `!` for 4 seconds after each run.
- With header/footer on, top and bottom margins are raised to at least 0.5 in so the text fits.
- If Chrome rejects the outline option, the PDF is generated again without bookmarks instead of failing.
- If the direct download fails, the PDF opens in the preview tab and downloads from there.

## Screenshots

_Placeholder: add screenshots of the popup, the options page, the element picker bar and the
preview tab here (also needed for the Web Store listing, see [docs/RELEASE.md](docs/RELEASE.md))._

## Install (unpacked)

1. Download or clone this repository.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/` folder (the one that contains `manifest.json`),
   not the repository root.
4. Pin PageSnap PDF from the puzzle-piece menu so the toolbar button is visible.

After pulling changes, click the reload icon on the extension's card and reload any tab you want to
convert.

## Usage

### Popup

Click the toolbar button. The popup shows the page title and these controls (all saved as you
change them, except the content mode):

- **Full page / Article only**: what to capture. This choice is per popup session, not saved.
- **Page breaks / Single page**: paged output or one tall page.
- **Paper size**, **Orientation**, **Margins** (presets or custom mm per side).
- **Layout width**: "Fit to paper width" uses the **Scale** slider; any fixed width (desktop,
  laptop, tablet, mobile) computes the scale automatically and disables the slider.
- Toggles: print backgrounds, screen styles instead of print styles, hide sticky/fixed bars,
  scroll to load lazy images, PDF bookmarks from headings, header and footer (title, date, URL,
  page numbers).
- **Pages to include**: e.g. `1-3, 5`. Hidden in single-page mode.
- **Download PDF** (or Enter when no control is focused) saves the file; **Preview** opens it in a viewer tab first.

The popup is disabled on pages Chrome does not let extensions touch (see Limitations).

### Page tools

- **Select element**: the popup closes and a picker bar appears on the page. Hover to highlight,
  ↑/↓ to widen or narrow the selection, click to save just that element, Esc to cancel.
- **Remove elements**: click anything (ads, banners, comments) to hide it. The bar offers
  **Undo** (last removal), **Save PDF** and **Done**. Removals stay until you reset or reload.
- **Reset page (n)**: appears in the popup when elements are removed; restores all of them.

PDFs started from the in-page picker use your saved settings and the default action from the
options page.

### Context menu

Right-click the page, a frame, or the toolbar icon:

- Save page as PDF
- Save article only as PDF
- Select an element to save as PDF
- Remove elements before saving
- Undo removed elements (restores all removed elements)

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+P` | Save the page with your saved settings |
| `Alt+Shift+A` | Save only the main article |

Change them at `chrome://extensions/shortcuts` (the options page has a button for this).

### Options page

- **File name pattern** with `{title}`, `{domain}`, `{date}` (YYYY-MM-DD), `{time}` (HH-MM), and
  a live preview. Illegal characters are replaced and the name is capped at 150 characters.
- **Ask where to save each PDF** (Chrome's Save As dialog).
- **Default action**: download or open a preview tab. Used by shortcuts, context menu and
  in-page tools.
- **Expand inner scrollable areas** (on by default).
- **Let the page's `@page` CSS size override the paper size**.
- **Reset all settings**.

## How it works

```
 popup / context menu / shortcut / in-page picker
        │  ps:generate  (or direct call from the menu/command handler)
        ▼
 service worker (src/background.js)
        │ 1. inject src/content.js if not present (chrome.scripting, activeTab)
        │ 2. ps:prepare ───────────────► content script
        │                                 · auto-scroll, force lazy images to load
        │                                 · isolate article / picked element
        │                                 · hide small fixed bars, un-stick sticky ones
        │                                 · expand inner scroll areas, unlock <html>/<body>
        │ 3. chrome.debugger.attach(tab)
        │    · Emulation.setEmulatedMedia (screen view / single page)
        │    · single page: setDeviceMetricsOverride + Page.getLayoutMetrics → page height
        │    · Page.printToPDF(params from src/lib/print-params.js) → base64 PDF
        │ 4. finally: clear emulation, detach debugger, ps:restore (page back to normal)
        ▼
 chrome.downloads.download(data:application/pdf…)   or   viewer tab (src/viewer/)
                                                          Blob URL → iframe + Download
```

### The "started debugging this browser" bar

While a PDF is being generated Chrome shows a bar saying *PageSnap PDF started debugging this
browser*. Chrome shows it whenever any extension attaches `chrome.debugger`, and an extension
cannot hide it. `chrome.debugger` is the only extension API that reaches Chrome's
`Page.printToPDF`, which is what gives real text, vector output and working links. The debugger is
attached only for one conversion and detached right after, so the bar goes away. Clicking
**Cancel** on the bar aborts the conversion.

## Privacy

- **No network requests.** The extension has no servers, analytics or remote code. The PDF is
  rendered by Chrome on your device and is passed between the extension's own pages only (runtime
  messages and `chrome.storage.session`, which lives in memory and is cleared when the browser
  closes). Preview jobs are discarded after 15 minutes or once the viewer has loaded them.
- **Settings** are stored in `chrome.storage.sync`. If you use Chrome Sync, Chrome itself syncs
  them to your Google account like any extension's settings. Page content is never stored there.
- **No `host_permissions`.** The extension cannot read any site on its own; it only touches a tab
  after you invoke it there.

| Permission | Why it is needed |
|---|---|
| `debugger` | Attach to the current tab to call `Page.printToPDF` (and media/viewport emulation for screen view and single-page mode). Attached per conversion, detached immediately after. |
| `activeTab` | Temporary access to the tab you clicked the button, menu or shortcut on. Replaces host permissions. |
| `scripting` | Inject the content script that prepares the page (lazy images, fixed bars, article, pickers) and restores it afterwards. |
| `downloads` | Save the PDF to your Downloads folder, optionally with the Save As dialog. |
| `storage` | Remember your settings (`sync`) and hand preview PDFs to the viewer tab (`session`). |
| `contextMenus` | The right-click menu entries. |

## Limitations

- **Blocked pages.** Chrome does not allow extensions on `chrome://`, `edge://`, `about:`,
  `view-source:`, DevTools and other extensions' pages, or the Chrome Web Store. The popup shows a
  notice there.
- **`file://` pages** work only if "Allow access to file URLs" is enabled on the extension's
  details page.
- **DevTools open on the tab.** Only one debugger client can attach; close DevTools (or any other
  debugging tool) on that tab and retry.
- **Single page is capped at 200 inches** (14 400 pt), the largest page size most PDF viewers
  accept. Content taller than that at the chosen width and scale continues on further 200-inch
  pages.
- **Iframes are not prepared.** The content script runs in the top frame only, so lazy images,
  fixed bars and scroll areas inside iframes are left as they are. Right-clicking inside a frame
  still converts the whole tab.
- **Extremely long pages.** The fixed-bar and scroll-area scans stop after 25 000 elements,
  auto-scroll stops after 250 steps, and image loading waits at most 6 seconds. Very large PDFs
  are also slow to hand to the download manager.
- **Article detection is a heuristic.** If it picks the wrong block or none, use Select element.
- **Canvas / WebGL / video** print as whatever Chrome's print engine renders for them.

## Development

Requirements: Node.js 18+, Playwright's Chromium, and poppler (`pdfinfo`, `pdftotext`) for the
test assertions.

```sh
npm install
npx playwright install chromium
brew install poppler           # or: apt-get install poppler-utils
npm test                       # headless end-to-end run of the PDF pipeline (test/e2e.mjs)
npm run test:content           # content-script checks: restore, picker, article detection (test/content.e2e.mjs)
npm run test:ui                # renders popup/options/viewer light+dark into test/out/ui/ and fails on errors
npm run test:all               # all three in sequence
HEADED=1 npm test              # watch it in a real window
npm run build:icons            # rasterise extension/icons/icon.svg to 16/32/48/128 px PNGs
```

`test/e2e.mjs` serves `test/fixtures/` on a local port, loads the extension into Chromium and
calls the service worker's test hook (`globalThis.__pagesnap`) to generate PDFs, then checks page
count, page size, text and links with poppler. Output goes to `test/out/` (git-ignored).
Automation cannot grant `activeTab`, so the harness copies `extension/` to a temp dir and adds a
`host_permissions` entry for the local fixture server only; the shipped manifest is unchanged.

### Project layout

```
extension/                 the unpacked extension (this folder is what gets zipped)
  manifest.json
  icons/                   icon.svg source + generated PNGs
  src/background.js        service worker: pipeline, messaging, context menus, shortcuts
  src/content.js           page preparation, restoration, element pickers (injected on demand)
  src/lib/paper-sizes.js   22 paper formats, 200-inch cap
  src/lib/settings.js      settings schema, defaults, load/save
  src/lib/print-params.js  settings → Page.printToPDF params, header/footer, filenames
  src/popup/               toolbar popup
  src/options/             options page
  src/viewer/              preview tab
scripts/build-icons.mjs    icon rasteriser (Playwright)
test/e2e.mjs               end-to-end tests
test/fixtures/             pages used by the tests
docs/ARCHITECTURE.md       modules, message protocol, settings schema
docs/RELEASE.md            Chrome Web Store release checklist
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "This page cannot be converted…" | The page is a browser page, the Web Store or another extension. Nothing to do. |
| "Another tool (usually DevTools) is attached to this tab" | Close DevTools on that tab and try again. |
| "Could not reach the page content. Reload the page and try again." | The tab was open before the extension was installed or reloaded, or the page blocks injection. Reload the tab. |
| "Chrome does not allow extensions to access this page." on a `file://` URL | Enable "Allow access to file URLs" for PageSnap PDF in `chrome://extensions`. |
| "PDF generation was cancelled." | The debugger bar's Cancel was clicked, or the tab navigated/closed mid-run. |
| "A PDF is already being generated for this tab." | Wait for the current run (the popup shows progress). |
| "Could not detect an article on this page." | Use Select element instead. |
| "This preview has expired." | Preview data is kept for 15 minutes; generate again. |
| Sticky header still repeats or content is clipped | Try "Use screen styles", turn on "Expand inner scrollable areas", or remove the element with Remove elements. |
| Images missing | Keep "Scroll page to load lazy images" on; slow images are given up to 6 s. |
| Page looks like a phone/tablet layout or is tiny | Adjust Layout width, or set it to "Fit to paper width" and use Scale. |
| Page is left in an odd state after a failed run | Right-click → Undo removed elements (also reverts any leftover preparation), or reload the tab. |
