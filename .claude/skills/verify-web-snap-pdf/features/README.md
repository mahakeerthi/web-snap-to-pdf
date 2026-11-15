# Web Snap PDF verification map

This directory is the maintained source for verifying the user-facing behavior of Web Snap PDF. Read the index before driving the extension, then use the matching feature file as the recipe.

## Baseline preconditions

- `npm install` has run and `npx playwright install chromium` has installed Chromium.
- `pdfinfo` and `pdftotext` (poppler) are on PATH.
- `node scripts/verify-popup.mjs doctor` exits 0 and prints `"name": "Web Snap PDF"`, the version in `extension/manifest.json`, and `"printable": true`.
- Every journey starts from a fresh profile with default settings: image scale 2, filename template `{title}`, Save As off, Markdown off, hide fixed elements on.
- Fixture pages come from `test/fixtures/`. `article.html` contains `ARTICLE-MARK` (in `#story`), `SIDEBAR-MARK` (in `#sidebar`), `FIXED-HEADER-MARK` and `FOOTER-MARK`. `element.html` has `#red`, a 400x300 element far below the fold, plus `#tall` and `#split` for split exports.

## Driving conventions

- Drive through `scripts/verify-popup.mjs`. Each journey is one fresh browser; never share one between journeys.
- Open the fixture first and bring it to the front, then open the popup. The popup resolves its target tab once, at load.
- Before any popup click, require `body[data-state="ready"]` and a `#page-title` equal to the fixture's title.
- Prefer ids in extension pages (`#act-page`) and class or tag handles in the shadow-root UI (`.download`, `select.format`, which you set with `selectOption` and which a `label` with the text Format names). Picker bar buttons go by role and their localized label.
- Click the real control. `globalThis.__websnap` is for `doctor` and for reading state.

## Proof and skip reporting

- Capture the action and the result: a screenshot before the click, the downloaded file, and the page or popup state after.
- A PDF proof includes pdfinfo pages and page size and the present and absent marks from pdftotext.
- An image proof includes the type from the magic bytes and the pixel size.
- A Markdown proof includes the filename extension and the present and absent marks.
- Every artifact sits under `test/out/verify/<run-id>/<journey>/` next to `result.json`, which lists the controls clicked.
- Report an entry point the harness cannot drive as unverified. Do not report it as verified through a different entry point.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line each.
2. `How to get to it (user POV)` lists every user entry point and marks the ones the harness cannot drive.
3. `Driving it with scripts/verify-popup.mjs` starts with `Preconditions:` and pairs each user action with the control and the observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

## Features

- [Full page PDF](./full-page-pdf.md) covers previewing the whole page from the popup, the context menu and `Alt+Shift+P`, and saving it with Download in the overlay.
- [Article PDF](./article-pdf.md) covers previewing only the main content from the popup, the context menu and `Alt+Shift+A`, and saving it with Download in the overlay.
- [Select element](./select-element.md) covers the element picker and the preview overlay's Format dropdown (PDF, PNG and JPEG), split parts, copy and cancel.
- [Remove elements](./remove-elements.md) covers removing elements before an export, Undo, Preview from the picker bar, and resetting the page.
- [Markdown export](./markdown.md) covers the opt-in in options, the page and article Markdown cards and the overlay's Markdown format.
