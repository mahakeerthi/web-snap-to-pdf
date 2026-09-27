# Chrome Web Store release checklist

Run every command from the project root.

## 1. Version

- [ ] Bump `version` in `extension/manifest.json` (Chrome requires it to be higher than the
      published version; 1-4 dot-separated integers, e.g. `1.0.1`).
- [ ] Bump `version` in `package.json` to the same value.
- [ ] Note user-visible changes for the listing's "What's new" / release notes.

## 2. Verify

- [ ] `npm install && npx playwright install chromium` (first time only) and poppler installed.
- [ ] `npm run test:all` passes with 0 failures (pipeline, content script, UI screenshots).
- [ ] Manual smoke test with the unpacked `extension/` folder in a normal Chrome profile
      (the tests use a copy with extra `host_permissions`; this checks real `activeTab` behaviour):
  - [ ] Popup: Download PDF and Preview on an ordinary article page.
  - [ ] Context menu: all five entries, including from the toolbar icon's menu.
  - [ ] `Alt+Shift+P` and `Alt+Shift+A`.
  - [ ] Select element and Remove elements (Undo, Save PDF, Done, Reset page).
  - [ ] Popup shows the "can't be converted" notice on `chrome://extensions` and the Web Store.
  - [ ] Options page: filename preview updates, Save As toggle, Reset all settings.
  - [ ] Service worker console (`chrome://extensions` → Inspect views) has no errors.
- [ ] If the icon changed: `npm run build:icons`.

## 3. Package

The zip must contain the **contents** of `extension/`, with `manifest.json` at the zip root.

```sh
VERSION=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
(cd extension && zip -r -X "../dist/pagesnap-pdf-$VERSION.zip" . -x '*.DS_Store')
unzip -l "dist/pagesnap-pdf-$VERSION.zip" | grep -E ' manifest\.json$'   # must print "manifest.json", not "extension/manifest.json"
```

- [ ] Nothing outside `extension/` is in the zip (no `node_modules/`, `test/`, `scripts/`).
- [ ] `dist/` is not in `.gitignore`; do not commit the zip (add `dist/` to `.gitignore` or delete it after upload).

## 4. Listing text (suggestions)

**Name:** PageSnap PDF

**Summary (≤ 132 chars):**
Save any web page as a PDF in one click. Keeps styles and clickable links. Runs 100% locally with Chrome's own PDF engine.

**Description:**

> PageSnap PDF turns the page you are reading into a clean PDF using Chrome's built-in print
> engine. Text stays selectable and links stay clickable.
>
> • Paged or single long page
> • 22 paper sizes, portrait or landscape, margin presets or custom margins
> • Fit to a desktop, tablet or mobile layout width, or set the scale yourself
> • Header and footer with title, date, URL and page numbers
> • Print or screen styles, page ranges, PDF bookmarks from headings
> • Loads lazy images, hides sticky bars, expands scrollable chat and docs panes
> • Article only, save a single element, or remove ads and banners before saving
> • Preview before downloading, custom file names, right-click menu and keyboard shortcuts
>
> Private by design: no account, no uploads, no tracking. Everything happens on your device.
> Free, with no paid tier.
>
> Note: while a PDF is being generated Chrome shows "PageSnap PDF started debugging this
> browser". This is how Chrome lets extensions use its PDF engine; the bar disappears when the
> PDF is ready.

**Category:** Productivity (or Tools).

- [ ] Screenshots, 1280×800 or 640×400: popup, picker bar on a page, preview tab, options page.
- [ ] Small promo tile 440×280.
- [ ] Store icon 128×128: `extension/icons/icon128.png`.

## 5. Privacy practices tab

**Single purpose:**
Convert the web page in the current tab to a PDF file on the user's device.

**Permission justifications:**

| Permission | Justification to paste |
|---|---|
| `debugger` | Chrome exposes its native PDF renderer to extensions only through the DevTools Protocol command `Page.printToPDF`. The extension attaches to the single tab the user asked to convert, calls `Page.printToPDF` (plus `Emulation.setEmulatedMedia`, `Emulation.setDeviceMetricsOverride` and `Page.getLayoutMetrics` for screen-style and single-page output), and detaches as soon as the PDF is produced, including on errors. It does not read network traffic, cookies or any other tab. Chrome shows its standard debugging bar during the conversion. |
| `activeTab` | Grants temporary access to the tab the user clicked the toolbar button, context menu item or keyboard shortcut on, so no host permissions are needed. |
| `scripting` | Injects the extension's own content script into the active tab to prepare the page for printing (load lazy images, hide sticky bars, isolate the article or a chosen element) and restore it afterwards. |
| `downloads` | Saves the generated PDF to the user's Downloads folder or the location the user picks. |
| `storage` | Stores the user's PDF settings and passes a generated PDF to the extension's own preview page. |
| `contextMenus` | Adds "Save page as PDF" and related entries to the right-click menu. |

**Host permissions:** none requested.

**Remote code:** No, I am not using remote code. All JavaScript is packaged in the extension.

**Data usage:** tick nothing. The extension does not collect or transmit any user data; the page
content is processed locally and the PDF is written only to the user's disk.

- [ ] Certify the three data-use statements (not sold, not used for unrelated purposes, not used
      for creditworthiness).
- [ ] Privacy policy URL: not strictly required when no data is collected, but a one-paragraph
      hosted page ("PageSnap PDF collects no data; conversions happen locally; settings are stored
      with Chrome storage") usually avoids review back-and-forth.

Reviewers look closely at `debugger`. Keep the justification specific (name the protocol
commands, the per-conversion attach/detach, and that nothing else is inspected), and make sure the
description mentions the debugging bar so users are not surprised by it.

## 6. Branding

- [ ] Name, icon, screenshots, promo tiles and description are PageSnap PDF's own. Do not use the
      name "Web to PDF", the webtopdf.space domain, or the original extension's logo, colours,
      screenshots or listing text, and do not describe PageSnap as affiliated with it. Copying
      another listing's branding risks rejection or takedown for impersonation.

## 7. Submit

- [ ] Upload `dist/pagesnap-pdf-<version>.zip` in the Developer Dashboard (new item or Package → Upload new package).
- [ ] Fill in listing, privacy practices and distribution (visibility, regions).
- [ ] Submit for review; after approval, install from the store in a clean profile and repeat the smoke test.
