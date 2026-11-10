# Chrome Web Store release checklist

Run every command from the project root. The exact text to paste into the dashboard is in
[store/listing.md](store/listing.md); this file is the checklist and the reasoning behind it.

## 1. Version

- [ ] Bump `version` in `extension/manifest.json` (Chrome requires it to be higher than the
      published version; 1-4 dot-separated integers, e.g. `1.1.1`). Current: `1.1.0`.
- [ ] Bump `version` in `package.json` to the same value.
- [ ] Note user-visible changes for the release notes. 1.1.0: redesigned popup (three action cards,
      Layout + summary line, collapsible Export settings, Help), on-page element preview with PDF /
      PNG / JPEG export and Copy image, light/dark theme, 8 interface languages, experimental
      Markdown export (opt-in). Next release: the popup cards always download directly (the
      separate preview buttons and the "Default action" option are removed); the element preview
      becomes a full-page overlay with a toolbar at the top and splits large elements into image
      parts.

## 2. Verify

- [ ] `npm install && npx playwright install chromium` (first time only) and poppler installed.
- [ ] `npm run check` (ESLint, Prettier check, locale check) passes.
- [ ] `npm run test:all` passes with 0 failures (pipeline, content script, UI screenshots).
- [ ] `npm run check:locales` reports all 8 locales in sync and every `extDescription` ≤ 132 chars.
- [ ] Manual smoke test with the unpacked `extension/` folder in a normal Chrome profile
      (the tests use a copy with extra `host_permissions`; this checks real `activeTab` behaviour):
  - [ ] Popup: Full page and Article only download directly; the cards have no extra buttons.
  - [ ] Layout toggle and Export settings: the summary line follows every change; the panel's
        open/closed state survives reopening the popup.
  - [ ] Select element → full-page preview overlay with the toolbar at the top: PDF, PNG and JPEG
        download; Copy image (PNG and JPEG) pastes into another app; Reselect; light / dark toggle;
        Close and Esc close it. A very tall element is split into numbered parts shown stacked:
        each part's Copy and Download work, and the toolbar's Download saves all parts.
  - [ ] Remove elements (Undo, Save PDF, Done) and Reset page in the popup.
  - [ ] Context menu: all five entries, including from the toolbar icon's menu.
  - [ ] `Alt+Shift+P` and `Alt+Shift+A`.
  - [ ] Theme button cycles System → Light → Dark; options page and preview overlay follow.
  - [ ] Language selector: switch to at least one non-Latin language (ja or hi) and back; picker
        bar and preview overlay are translated.
  - [ ] Markdown: hidden by default; options → Experimental asks for confirmation; after enabling,
        the popup row and the overlay's Markdown format appear and produce `.md` files; disabling
        hides them again.
  - [ ] Popup shows the "can't be converted" notice on `chrome://extensions` and the Web Store.
  - [ ] Options page: filename preview updates, Save As toggle (also for images and Markdown),
        image resolution, no "Default action" select, Reset all settings.
  - [ ] Service worker console (`chrome://extensions` → Inspect views) has no errors.
- [ ] If the icon changed: `npm run build:icons`.

## 3. Package

```sh
npm run package
```

builds `dist/web-snap-pdf-<version>.zip` (git-ignored; fails if `package.json` and the manifest
disagree on the version). The zip must contain the **contents** of `extension/`,
with `manifest.json` at the zip root. Manual equivalent, and the check to run either way:

```sh
VERSION=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
(cd extension && zip -r -X "../dist/web-snap-pdf-$VERSION.zip" . -x '*.DS_Store')
unzip -l "dist/web-snap-pdf-$VERSION.zip" | grep -E ' manifest\.json$'   # must print "manifest.json", not "extension/manifest.json"
```

- [ ] Nothing outside `extension/` is in the zip (no `node_modules/`, `test/`, `scripts/`, `docs/`).
- [ ] `_locales/` is included (the manifest uses `__MSG_*__` strings and `default_locale`).

## 4. Listing

Paste from [store/listing.md](store/listing.md):

- **Name:** Web Snap PDF.
- **Summary:** comes from the manifest description (`extDescription` in
  `extension/_locales/en/messages.json`, ≤ 132 characters, currently 127). Translations provide
  the summary for other store languages automatically.
- **Description:** leads with the three ways to save, then the feature bullets, privacy, and the
  debugging-bar note. It mentions Markdown only as **experimental and off by default** — do not
  advertise it as a headline feature while it is opt-in, and keep the screenshots on the default
  UI (the popup without the Markdown row), except where noted below.
- **Category:** Tools.

### Screenshots

Requirements: 1280 × 800 (preferred) or 640 × 400, PNG or JPEG without transparency, 1-5 images.
Our raw captures are narrower (popup 360 px, options 720 px), so the popup shots need composing onto
a 1280 × 800 canvas; the preview-overlay shots are already 1280 × 800.

Use a neutral demo page with our own content (no third-party sites, logos or trademarks) and the
light theme unless stated. Plan:

| #   | Shot                                                                    | How to produce                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Popup over an article page: "Full page / Article only / Select element" | Open a demo article at 1280 × 800, render `popup.html` (as `scripts/screenshot-ui.mjs` does, 360 px wide, device scale 2 for sharpness) and composite it at the top right under a mock toolbar.                                          |
| 2   | Element preview overlay with PDF / PNG / JPEG                           | `node scripts/screenshot-preview.mjs` → `docs/images/preview-overlay-light.png` (1280 × 800). Before the store capture, point `FIXTURE` / `TARGET` at a realistic demo element (a chart card or recipe box) instead of the red test box. |
| 3   | Export settings expanded                                                | Composite `popup-expanded-light.png` (crop to the Paper → Content groups) next to a sample PDF page rendered from the demo article.                                                                                                      |
| 4   | Dark mode                                                               | Same as 1 with `popup-default-dark.png` and `preview-overlay-dark.png` side by side on a dark background.                                                                                                                                |
| 5   | Remove elements / options                                               | The remove-mode bar on the demo page with a removed banner, or `options-light.png` framed on the canvas with the language menu open.                                                                                                     |

The source images live in `docs/images/` (copied from `test/out/ui/` after `npm run test:ui`).
Add a caption strip to each (e.g. "Save the whole page, the article, or just one part") only if it
stays legible at 640 × 400.

- [ ] Small promo tile 440 × 280 (icon + name + one short line).
- [ ] Store icon 128 × 128: `extension/icons/icon128.png`.

## 5. Privacy practices tab

**Single purpose:** see [store/listing.md](store/listing.md#privacy-practices-tab). In short: save
the page in the current tab, or a selected part of it, as a file on the user's device (PDF, element
image, or opt-in Markdown), converted locally.

**Permission justifications** (full paste text in the listing file):

| Permission     | Why                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `debugger`     | Only route to Chrome's `Page.printToPDF` and full-element `Page.captureScreenshot`. Attached to the one tab the user acted on, per export, detached in `finally`. Also uses `Emulation.setEmulatedMedia`, `Emulation.setDeviceMetricsOverride`, `Page.getLayoutMetrics` and `Runtime.evaluate` (viewport height only). Never reads network, cookies or other tabs. |
| `activeTab`    | Temporary access to the tab where the user clicked the button, menu item or shortcut; replaces host permissions.                                                                                                                                                                                                                                                   |
| `scripting`    | Injects the packaged content script: page preparation and restore, pickers, on-page preview overlay, opt-in Markdown conversion.                                                                                                                                                                                                                                   |
| `downloads`    | Saves the PDF / PNG / JPEG / Markdown file, optionally with Save As.                                                                                                                                                                                                                                                                                               |
| `storage`      | Settings (`sync`), small UI preferences (`local`), PDF hand-off to the download fallback page if a direct download fails (`session`).                                                                                                                                                                                                                              |
| `contextMenus` | Five right-click entries.                                                                                                                                                                                                                                                                                                                                          |

**Host permissions:** none. **Remote code:** none. **Data usage:** nothing collected; certify the
three statements. **Privacy policy:** optional; the one-paragraph text in the listing file avoids
review back-and-forth.

Reviewers look closely at `debugger`. Keep the justification specific (name the protocol
commands, the per-export attach/detach, and that nothing else is inspected), and make sure the
description mentions the debugging bar so users are not surprised by it. The experimental
Markdown export needs no extra permission (it reads the DOM through the same content script and
downloads through `downloads`).

## 6. Branding

- [ ] Name, icon, screenshots, promo tiles and description are Web Snap PDF's own. Do not use the
      name "Web to PDF", the webtopdf.space domain, or the original extension's logo, colours,
      screenshots or listing text, and do not describe Web Snap as affiliated with it. Copying
      another listing's branding risks rejection or takedown for impersonation.

## 7. Submit

- [ ] Upload `dist/web-snap-pdf-<version>.zip` in the Developer Dashboard (new item or Package → Upload new package).
- [ ] Fill in listing, privacy practices and distribution (visibility, regions).
- [ ] Submit for review; after approval, install from the store in a clean profile and repeat the smoke test.
