# Article PDF

Article only finds the page's main content, hides menus, sidebars, headers and footers for the export, saves it as a PDF, and restores the page afterwards.

## Sub-features

- `article-pdf` saves only the main content as `<title>.pdf`.
- `article-exclude` leaves out sidebars, fixed headers and footers.
- `article-restore` puts the page back exactly as it was after the export.

## How to get to it (user POV)

- Click the toolbar icon, then the `Article only` card (`#act-article`). Driven, through `popup.html` in a tab.
- Press `Alt+Shift+A`. Not drivable by the harness.
- Right-click the page, a frame or the toolbar icon and choose `Save article only as PDF`. Not drivable by the harness.

## Driving it with scripts/verify-popup.mjs

Preconditions:

- `node scripts/verify-popup.mjs doctor` exits 0.
- `article.html`, whose main content is `#story` and whose sidebar is `#sidebar`.

- **Run it.** `node scripts/verify-popup.mjs drive article`.
- **Popup targets the page.** `#page-title` reads `Fixture Article: The Long Read`. Proof is `popup.png`.
- **Save.** Click `#act-article`. A new download completes as `Fixture Article The Long Read.pdf` and `#status` names it. Proof is `popup-saved.png`.
- **File.** pdftotext finds `ARTICLE-MARK` and does not find `SIDEBAR-MARK` (also absent: `FIXED-HEADER-MARK`, `FOOTER-MARK`).

## Gotchas

- The fixture's article is long, so the article PDF has as many pages as the full page one (18). Page count does not tell the two exports apart; the marks do.
- Article detection on other page shapes (blogs, docs, feeds, div soup) is covered by `npm run test:content` with the `article-*.html` fixtures, not by this journey.
- Page restore after the export is checked by `npm run test:content` and modeled by `node formal/page-restore/check.mjs`. This journey does not snapshot the DOM.
