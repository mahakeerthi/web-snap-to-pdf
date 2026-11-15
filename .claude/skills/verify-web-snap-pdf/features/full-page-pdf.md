# Full page PDF

Full page opens a preview of the whole current page in an overlay on the page, and nothing downloads until the user clicks Download there. With PDF selected in the Format dropdown, Download saves the page, top to bottom, through Chrome's print engine with the popup's layout and export settings, and names the file from the page title. The same dropdown offers PNG and JPEG (and Markdown when enabled). Esc or Close while the preview loads or a Download runs cancels the job, restores the page and saves nothing.

## Sub-features

- `page-preview` opens the overlay (title "Export this page", caption `W×H px`) and downloads nothing.
- `page-pdf` saves the whole page as one PDF download named `<title>.pdf` when Download is clicked with PDF selected.
- `page-image` saves PNG or JPEG parts when the Format dropdown is changed first.
- `page-cancel` stops a loading preview or a running Download on Esc or Close, with no file.
- `page-settings` applies the popup's layout (page breaks or single page), paper size, margins, backgrounds, and the hide-fixed-elements option.

## How to get to it (user POV)

- Click the toolbar icon, then the `Full page` card (`#act-page`). The popup closes and the overlay opens. Driven, through `popup.html` in a tab.
- Press `Alt+Shift+P`. Opens the same preview. Not drivable by the harness; `npm run test:content` calls the real listener through `__websnap.command`.
- Right-click the page, a frame or the toolbar icon and choose `Preview page`. Not drivable by the harness; `npm run test:content` calls the real listener through `__websnap.menu`.
- In the remove-elements bar, the `Preview` button opens the same preview with the removals applied. See [Remove elements](./remove-elements.md).

## Driving it with scripts/verify-popup.mjs

Preconditions:

- `node scripts/verify-popup.mjs doctor` exits 0.
- Default settings (fresh profile, which every journey gets).

- **Run it.** `node scripts/verify-popup.mjs drive full-page`. The helper opens `article.html`, then the popup in the fixture's window.
- **Popup targets the page.** `body[data-state="ready"]` and `#page-title` reads `Fixture Article: The Long Read`. Proof is `popup.png`.
- **Open the preview.** Click `#act-page`. The popup tab closes itself. The overlay `[data-websnap-ui="preview"]` renders `.stage canvas[data-ready]`, its title reads `Export this page`, its caption is a size (`W×H px`) with no selector, and `select.format` reads `pdf` in a fresh profile.
- **Nothing saved yet.** The profile's download dir has no new item.
- **Save.** Click `.download`. A new download completes as `Fixture Article The Long Read.pdf` and the overlay closes.
- **Other formats and cancel.** `selectOption` on `select.format` (`png`, `jpeg`) and Esc during the load are asserted by `npm run test:content` (tests named `preview:`), not by this journey.
- **File.** pdfinfo reports A4 pages (18 on the fixture). pdftotext finds `ARTICLE-MARK` and `SIDEBAR-MARK`. `result.json` lists both under `marks.found`.

## Gotchas

- `FIXED-HEADER-MARK` is absent from the PDF by design: hide fixed elements is on by default. Do not assert it present unless the journey turns the option off in the popup's Export settings.
- The popup resolves its target once, at load. Opening it before the fixture is in front exports the wrong tab; the helper's `#page-title` check catches this.
- The popup closes itself once the overlay opens, so it has no "Saved" status line to check. The proof is the overlay and the file. In real Chrome the popup also closes when the page gets focus.
- Download after the preview reuses the preview's lazy-load pass when the page has not changed since. A page that rewrites its DOM in between gets a second full scroll, so a slow page can keep the overlay busy for a few seconds after the click.
- Esc or Close while the preview is loading cancels the capture and restores the page. No file, no badge. A Download from the overlay can be cancelled the same way until its save step starts.
- A second export of the same page in one profile saves `<title> (1).pdf`. Find the file by new download id, not by name.
