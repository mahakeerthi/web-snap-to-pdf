# Select element

Select element lets the user point at one part of the page, preview it in an overlay, choose PDF, PNG or JPEG (or Markdown when enabled) in the Format dropdown, and save it with Download, or copy it as an image. Tall elements are captured in parts that can be saved or copied one by one.

## Sub-features

- `select-pick` highlights the element under the pointer; ArrowUp and ArrowDown widen or narrow the selection; Escape or Cancel stops.
- `select-preview` opens the overlay with the capture, the element's tag and CSS size, and the Format dropdown (`select.format`).
- `select-png` and `select-jpeg` download the element at the image scale (default 2, so 400x300 CSS px is 800x600).
- `select-pdf` downloads the element alone as a PDF.
- `select-split` splits an element taller than 1600 CSS px into parts, `<name>-1.png`, `<name>-2.png`, and so on, with a Copy and Download button per part.
- `select-copy` copies the preview as a PNG at screen resolution to the clipboard. The preview is a JPEG, so the copy is its decoded image, not a lossless capture.
- `select-reselect` closes the overlay and starts the picker again. On a Full page or Article only preview the same button reads `Select part` and narrows the preview to one element.
- `select-cancel` stops a loading preview or a running Download on Esc or Close, with no file.

## How to get to it (user POV)

- Click the toolbar icon, then the `Select element` card (`#act-select`). The popup closes and the picker starts on the page. Driven, through `popup.html` in a tab.
- Right-click the page, a frame or the toolbar icon and choose `Select an element to preview and save`. Not drivable by the harness.
- In the overlay, `Reselect` starts the picker again, and `Select part` on a page or article preview does the same. It is disabled while the preview loads or an export runs. Driven by `npm run test:content`, not by the helper.

## Driving it with scripts/verify-popup.mjs

Preconditions:

- `node scripts/verify-popup.mjs doctor` exits 0.
- `element.html`, whose `#red` is 400x300 CSS px and starts far below the fold.

- **Run it.** `node scripts/verify-popup.mjs drive select-element-png`.
- **Start the picker.** Click `#act-select` in the popup. The picker host `[data-websnap-ui=""]` appears on the page, and the popup tab closes itself (`notes` in `result.json`).
- **Pick.** Scroll `#red` into view, hover it, click. The overlay `[data-websnap-ui="preview"]` renders `.stage canvas[data-ready]` and its caption reads `div#red · 400×300 px`.
- **Choose PNG.** `selectOption` on `select.format` with the value `png` (its label is the text Format). The select's `value` reads `png`. Proof is `overlay-png.png`.
- **Download.** Click `.download`. A new download completes as `Element Fixture.png`, its magic bytes say PNG and its size is 800x600, and the overlay closes.
- **Other sub-features.** JPEG, element PDF, split parts (`#split`, 400x3700, three parts), part downloads and copy are asserted by `npm run test:content` (tests named `preview:`). A new helper journey should follow the PNG one: `selectOption` `jpeg` or `pdf` on `select.format`, or click `.part[data-part="2"] .part-download` (visible for PNG and JPEG only), and check the file.

## Gotchas

- Copy writes the real macOS clipboard from headless Chromium, so it is not isolated between runs and overwrites the user's clipboard. That is why the helper has no copy journey. The suite's "Copy image" check can fail in a full run; rerun it alone with `ONLY='Copy image' npm run test:content`.
- The overlay remembers the last format chosen. In a reused profile, PNG may already be selected; the helper's fresh profile starts on PDF.
- While the preview loads, and while any export has the page prepared, the Format select, `.download`, `.copy` and `.reselect` are disabled. `.close` always works. Wait for `.stage canvas[data-ready]` before choosing a format.
- Esc or Close while the preview loads or a PDF, PNG or JPEG Download runs cancels it and restores the page. A Markdown Download is not cancellable.
- A download with a warning, or a single part's download, keeps the overlay open with a status line. Only a clean whole-element download closes it.
- The picker targets the deepest element under the pointer, on hover and on click alike. To pick a container, hover a child and widen with ArrowUp before clicking; a click keeps the widened selection. The `.stripes` bands are `pointer-events: none` so the striped element itself is the deepest hit.
- The popup closing itself is the tab stand-in's `window.close()`. In real Chrome the popup also closes because the page takes focus.
