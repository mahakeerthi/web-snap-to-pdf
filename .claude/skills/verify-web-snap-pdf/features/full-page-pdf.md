# Full page PDF

Full page saves the whole current page, top to bottom, as a PDF through Chrome's print engine, with the popup's layout and export settings, and names the file from the page title.

## Sub-features

- `page-pdf` saves the whole page as one PDF download named `<title>.pdf`.
- `page-status` shows "Saved <filename>" in the popup status line.
- `page-settings` applies the popup's layout (page breaks or single page), paper size, margins, backgrounds, and the hide-fixed-elements option.

## How to get to it (user POV)

- Click the toolbar icon, then the `Full page` card (`#act-page`). Driven, through `popup.html` in a tab.
- Press `Alt+Shift+P`. Not drivable by the harness.
- Right-click the page, a frame or the toolbar icon and choose `Save page as PDF`. Not drivable by the harness.

## Driving it with scripts/verify-popup.mjs

Preconditions:

- `node scripts/verify-popup.mjs doctor` exits 0.
- Default settings (fresh profile, which every journey gets).

- **Run it.** `node scripts/verify-popup.mjs drive full-page`. The helper opens `article.html`, then the popup in the fixture's window.
- **Popup targets the page.** `body[data-state="ready"]` and `#page-title` reads `Fixture Article: The Long Read`. Proof is `popup.png`.
- **Save.** Click `#act-page`. A new download completes in the profile's download dir as `Fixture Article The Long Read.pdf`.
- **Status.** `#status` gets class `ok` and reads `Saved Fixture Article The Long Read.pdf`. Proof is `popup-saved.png`.
- **File.** pdfinfo reports A4 pages (18 on the fixture). pdftotext finds `ARTICLE-MARK` and `SIDEBAR-MARK`. `result.json` lists both under `marks.found`.

## Gotchas

- `FIXED-HEADER-MARK` is absent from the PDF by design: hide fixed elements is on by default. Do not assert it present unless the journey turns the option off in the popup's Export settings.
- The popup resolves its target once, at load. Opening it before the fixture is in front exports the wrong tab; the helper's `#page-title` check catches this.
- The real toolbar popup closes when the page gets focus. The tab stand-in stays open, so a status check after the export works here but proves nothing about the popup surviving the export in real Chrome.
- A second export of the same page in one profile saves `<title> (1).pdf`. Find the file by new download id, not by name.
