# Select element

Select element lets the user point at one part of the page, preview it in an overlay, and save it as a PDF, PNG or JPEG (or Markdown when enabled), or copy it as an image. Tall elements are captured in parts that can be saved or copied one by one.

## Sub-features

- `select-pick` highlights the element under the pointer; ArrowUp and ArrowDown widen or narrow the selection; Escape or Cancel stops.
- `select-preview` opens the overlay with the capture, the element's tag and CSS size, and the format buttons.
- `select-png` and `select-jpeg` download the element at the image scale (default 2, so 400x300 CSS px is 800x600).
- `select-pdf` downloads the element alone as a PDF.
- `select-split` splits an element taller than 1600 CSS px into parts, `<name>-1.png`, `<name>-2.png`, and so on, with a Copy and Download button per part.
- `select-copy` copies the capture as a PNG to the clipboard.
- `select-reselect` closes the overlay and starts the picker again.

## How to get to it (user POV)

- Click the toolbar icon, then the `Select element` card (`#act-select`). The popup closes and the picker starts on the page. Driven, through `popup.html` in a tab.
- Right-click the page, a frame or the toolbar icon and choose `Select an element to preview and save`. Not drivable by the harness.
- In the overlay, `Reselect` starts the picker again. Driven by `npm run test:content`, not by the helper.

## Driving it with scripts/verify-popup.mjs

Preconditions:

- `node scripts/verify-popup.mjs doctor` exits 0.
- `element.html`, whose `#red` is 400x300 CSS px and starts far below the fold.

- **Run it.** `node scripts/verify-popup.mjs drive select-element-png`.
- **Start the picker.** Click `#act-select` in the popup. The picker host `[data-websnap-ui=""]` appears on the page, and the popup tab closes itself (`notes` in `result.json`).
- **Pick.** Scroll `#red` into view, hover it, click. The overlay `[data-websnap-ui="preview"]` renders `.stage canvas[data-ready]` and its caption reads `div#red · 400×300 px`.
- **Choose PNG.** Click `.seg [data-format="png"]`. It gets `aria-checked="true"`. Proof is `overlay-png.png`.
- **Download.** Click `.download`. A new download completes as `Element Fixture.png`, its magic bytes say PNG and its size is 800x600, and the overlay closes.
- **Other sub-features.** JPEG, element PDF, split parts (`#split`, 400x3700, three parts), part downloads and copy are asserted by `npm run test:content` (tests named `preview:`). A new helper journey should follow the PNG one: click `.seg [data-format="jpeg"]` or `"pdf"`, or `.part[data-part="2"] .part-download`, and check the file.

## Gotchas

- Copy writes the real macOS clipboard from headless Chromium, so it is not isolated between runs and overwrites the user's clipboard. That is why the helper has no copy journey. The suite's "Copy image" check can fail in a full run; rerun it alone with `ONLY='Copy image' npm run test:content`.
- The overlay remembers the last format chosen. In a reused profile, PNG may already be checked; the helper's fresh profile starts on PDF.
- A download with a warning, or a single part's download, keeps the overlay open with a status line. Only a clean whole-element download closes it.
- The picker targets the deepest element under the pointer, on hover and on click alike. To pick a container, hover a child and widen with ArrowUp before clicking; a click keeps the widened selection. The `.stripes` bands are `pointer-events: none` so the striped element itself is the deepest hit.
- The popup closing itself is the tab stand-in's `window.close()`. In real Chrome the popup also closes because the page takes focus.
