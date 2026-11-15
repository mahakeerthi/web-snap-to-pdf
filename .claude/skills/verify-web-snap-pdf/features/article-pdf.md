# Article PDF

Article only finds the page's main content and opens a preview of it in an overlay, and nothing downloads until the user clicks Download there. Download hides menus, sidebars, headers and footers for the export, saves the article (PDF by default, or PNG or JPEG from the Format dropdown), and restores the page afterwards.

## Sub-features

- `article-preview` opens the overlay (title "Export this article", caption `W×H px`) and downloads nothing. With no article on the page the popup shows the error and no overlay opens.
- `article-pdf` saves only the main content as `<title>.pdf` when Download is clicked with PDF selected.
- `article-exclude` leaves out sidebars, fixed headers and footers.
- `article-restore` puts the page back exactly as it was after the export.

## How to get to it (user POV)

- Click the toolbar icon, then the `Article only` card (`#act-article`). The popup closes and the overlay opens. Driven, through `popup.html` in a tab.
- Press `Alt+Shift+A`. Opens the same preview. Not drivable by the harness; `npm run test:content` calls the real listener through `__websnap.command`.
- Right-click the page, a frame or the toolbar icon and choose `Preview article`. Not drivable by the harness; `npm run test:content` calls the real listener through `__websnap.menu`.

## Driving it with scripts/verify-popup.mjs

Preconditions:

- `node scripts/verify-popup.mjs doctor` exits 0.
- `article.html`, whose main content is `#story` and whose sidebar is `#sidebar`.

- **Run it.** `node scripts/verify-popup.mjs drive article`.
- **Popup targets the page.** `#page-title` reads `Fixture Article: The Long Read`. Proof is `popup.png`.
- **Open the preview.** Click `#act-article`. The popup tab closes itself. The overlay renders `.stage canvas[data-ready]`, its title reads `Export this article`, and its caption is a size with no selector.
- **Nothing saved yet.** The profile's download dir has no new item.
- **Save.** Click `.download`. A new download completes as `Fixture Article The Long Read.pdf` and the overlay closes.
- **File.** pdftotext finds `ARTICLE-MARK` and does not find `SIDEBAR-MARK` (also absent: `FIXED-HEADER-MARK`, `FOOTER-MARK`).

## Gotchas

- The fixture's article is long, so the article PDF has as many pages as the full page one (18). Page count does not tell the two exports apart; the marks do.
- Article detection on other page shapes (blogs, docs, feeds, div soup) is covered by `npm run test:content` with the `article-*.html` fixtures, not by this journey.
- The article is found once, when the preview opens. The Download exports that same element, so it cannot pick a different article than the preview showed.
- The popup closes itself once the overlay opens, so there is no status line to check. The proof is the overlay and the file.
- Page restore after the export is checked by `npm run test:content` and modeled by `node formal/page-restore/check.mjs`. This journey does not snapshot the DOM.
