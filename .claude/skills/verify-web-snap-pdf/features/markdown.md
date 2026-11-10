# Markdown export

Markdown export is an experimental, opt-in feature. After the user confirms it in the options page, the popup shows `Full page` and `Article` Markdown buttons and the element overlay gains a Markdown format, each saving a `.md` file.

## Sub-features

- `md-optin` turns the feature on only after the options page's confirmation dialog, and off without one.
- `md-gate` hides the Markdown cards, and the background refuses Markdown exports, while the feature is off.
- `md-article` saves the main content as `<title>.md`.
- `md-page` saves the whole page as `<title>.md`.
- `md-element` saves a picked element as Markdown from the overlay's Markdown format.

## How to get to it (user POV)

- Opt in: open the options page (the popup's gear `#open-options`, or the extension's Options entry), tick `Enable Markdown export (experimental)` (`#markdownEnabled`), then `Enable` (`#markdown-enable`) in the confirmation. The helper opens `options.html` in a tab; the real embedded options dialog in `chrome://extensions` is not drivable by the harness.
- Popup cards `#md-article` and `#md-page` inside `#md-row`. Driven (`#md-article`); `#md-page` is reachable but not driven by a journey.
- The overlay's `.seg [data-format="markdown"]` after picking an element. Covered by `npm run test:content`, not by the helper.
- No shortcut or context-menu entry exists.

## Driving it with scripts/verify-popup.mjs

Preconditions:

- `node scripts/verify-popup.mjs doctor` exits 0.
- Fresh profile, so Markdown starts off.

- **Run it.** `node scripts/verify-popup.mjs drive markdown`.
- **Gate.** A popup on `article.html` does not show `#md-row`.
- **Opt in.** In `options.html`, click `#markdownEnabled`. `#markdown-confirm` appears and the checkbox stays unticked. Proof is `options-confirm.png`. Click `#markdown-enable`. The checkbox ticks and `chrome.storage.sync` `settings.markdownEnabled` reads true.
- **Cards appear.** A new popup shows `#md-row`. Proof is `popup-markdown.png`.
- **Export.** Click `#md-article`. A new download completes as `Fixture Article The Long Read.md`, `#status` names it, and the file has a `# ` heading and `ARTICLE-MARK` but no `SIDEBAR-MARK`.

## Gotchas

- The setting persists in `chrome.storage.sync` for the profile. A reused profile starts with Markdown on and the gate check fails; the helper's fresh profile avoids that.
- Ticking the checkbox alone changes nothing until `Enable` is clicked. Escape or `Cancel` (`#markdown-cancel`) leaves it off.
- The converter is best-effort. Its output on tables, nested lists and code is asserted by `npm run test:content` against `markdown.html`, not by this journey.
- A popup that is already open picks up the opt-in through `chrome.storage.onChanged`, but a real popup would have closed when the user went to options. Open a new popup.
