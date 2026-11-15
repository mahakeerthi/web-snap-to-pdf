# Chrome Web Store listing — WebPage to PDF

Exact text to paste into the Developer Dashboard. The dashboard fields are plain text: copy the
contents of each `text` block, not the Markdown around it. Checklist and background:
[../RELEASE.md](../RELEASE.md). Run `node scripts/check-listing.mjs` after any edit: it checks the
name and summary against the manifest strings and counts the search phrases in the description
(the store treats more than five repeats of one keyword as keyword spam).

Fields marked **You fill this** need your own details. They are not in this repository.

## Store listing tab

**Name** (from the manifest, `__MSG_extName__`):

```text
WebPage to PDF
```

**Summary** (from the manifest, `__MSG_extDescription__` in `extension/_locales/en/messages.json`;
the store shows the manifest description and it must be ≤ 132 characters. This one is 129, and
`npm run check:locales` enforces the limit for every language. If the locale file changes, it wins;
update this block to match):

```text
Save any web page as a PDF. Preview the full page, the article or one part, then export to PDF, PNG or JPEG. Free and 100% local.
```

**Description:**

```text
Convert any webpage to PDF and check it before you save it. See the page, the article or just one part in a full-size preview, then choose PDF, PNG or JPEG and press Download. Text stays selectable, links stay clickable, and nothing is uploaded anywhere.

Preview first, then save
• Full page – the whole page, top to bottom
• Article only – the main content, without menus, sidebars or ads
• Select element – click one part of the page, such as a chart or a table, and save just that
• The toolbar button, two keyboard shortcuts and the right-click menu ("Preview page", "Preview article") all open the same preview

Features
• Print to PDF with Chrome's own engine, paged or as one long single page. Large files save much faster and use far less memory
• 22 paper sizes, portrait or landscape, margin presets or custom margins
• Fit to a desktop, laptop, tablet or mobile layout width, or set the scale yourself
• Header and footer with title, date, URL and page numbers
• Print or screen styles, page ranges, bookmarks from headings
• Loads lazy images, hides sticky bars, expands scrollable chat and docs panes
• Remove ads, banners or anything else before saving, with undo
• Save an element as a PNG or JPEG screenshot at 2× resolution, with Copy image; very large elements are split into parts you can copy or download one by one
• Custom file names, light and dark mode
• Available in English, Español, Deutsch, Français, Português (Brasil), हिन्दी, 日本語 and 简体中文
• Experimental, off by default: Markdown export of the page, the article or a selected element (turn it on in the extension's settings)

Private by design
No account, no uploads, no tracking, no ads. Pages are converted on your device and the files go straight to your Downloads folder. Free, with no paid tier.

Good to know
While the preview is made and while a file is saved, Chrome shows "WebPage to PDF started debugging this browser". That is how Chrome lets extensions use its built-in print and screenshot engine; the bar disappears as soon as the preview or the file is ready. Chrome does not allow extensions on its own pages (chrome://) or on the Chrome Web Store.
```

**Category:** Tools (alternative: Workflow & Planning / Productivity, depending on the dashboard's
current category list).

**Language:** English (the listing can be localised later from the `_locales` translations).

**Store icon:** upload `extension/icons/icon128.png` (128 × 128).

**Screenshots:** upload the five files below, in this order. 1280 × 800, PNG, no transparency.
They show the shipped extension with the name `WebPage to PDF`, on a demo page with our own
content.

| #   | File                                          | Shows                                                                            |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `docs/store/images/1-preview-format-menu.png` | The full-page preview with the Format menu open: PDF, PNG, JPEG                  |
| 2   | `docs/store/images/2-three-ways-to-save.png`  | The toolbar popup over the demo article: Full page, Article only, Select element |
| 3   | `docs/store/images/3-select-one-part.png`     | The element picker highlighting one chart card on the demo page                  |
| 4   | `docs/store/images/4-export-settings.png`     | The popup's export settings next to a sample paper page                          |
| 5   | `docs/store/images/5-dark-mode.png`           | The popup and the preview in dark mode                                           |

**Small promo tile:** `docs/store/images/promo-tile-440x280.png` (440 × 280).

**Marquee promo tile** (optional, only used if the store features the extension): none made.

**Global promo video** (optional): none.

**Official URL / website** (optional, builds trust): `https://github.com/mahakeerthi/web-snap-to-pdf`

**Support URL** (optional): `https://github.com/mahakeerthi/web-snap-to-pdf/issues`

## Privacy practices tab

**Single purpose description:**

```text
WebPage to PDF saves the web page in the current tab, its main article, or a part of it that the user selects, as a file on the user's device: a PDF, or a PNG or JPEG image (and, only if the user turns on the experimental option, a Markdown text file). The user sees a preview first. All conversion happens locally with Chrome's own rendering engine.
```

**Permission justifications:**

`debugger`

```text
Chrome exposes its native PDF renderer and full-page and full-element screenshots to extensions only through the DevTools Protocol. When the user starts a preview or an export, the extension attaches to that one tab, calls Page.printToPDF (for PDFs) and reads the result as a stream with IO.read and IO.close, or calls Page.captureScreenshot with a clip (for the preview and for PNG and JPEG export), plus Emulation.setEmulatedMedia, Emulation.setDeviceMetricsOverride, Emulation.clearDeviceMetricsOverride, Page.getLayoutMetrics and Runtime.evaluate (reading the viewport height only) to lay out and measure the page, and detaches as soon as the work is done, including on errors. It does not read network traffic, cookies, storage or any other tab. Chrome shows its standard debugging bar during the work.
```

`activeTab`

```text
Grants temporary access to the tab on which the user clicked the toolbar button, a context-menu item or a keyboard shortcut, so the extension needs no host permissions and never runs on a site the user did not act on.
```

`scripting`

```text
Injects the extension's own packaged content script into the active tab when the user starts an action. The script prepares the page for export (loads lazy images, hides sticky bars, isolates the article or the selected element), shows the element picker and the full-page preview overlay, converts the page to Markdown when that opt-in option is used, and restores the page afterwards.
```

`downloads`

```text
Saves the generated PDF, PNG/JPEG image or Markdown file to the user's Downloads folder, or to the location the user picks when "Ask where to save" is enabled.
```

`offscreen`

```text
Saves a generated PDF quickly. A Manifest V3 service worker cannot create a blob: URL, so while a PDF is being generated and saved the extension opens one hidden page of its own (reason BLOBS). That page turns the PDF the extension just printed into a local blob: URL, which chrome.downloads saves. This is much faster than passing a large PDF as a data: URL and uses far less memory. The page loads no web content, uses no other permission, and is closed as soon as the download has started.
```

`storage`

```text
Stores the user's export settings (paper size, margins, theme, language and similar) and small interface preferences. No page content or browsing data is stored.
```

`contextMenus`

```text
Adds "Preview page", "Preview article", "Select an element to preview and save", "Remove elements before saving" and "Restore all removed elements" to the right-click menu.
```

**Host permissions:** none requested.

**Remote code:**

```text
No, I am not using remote code. All JavaScript is packaged in the extension.
```

**Data usage:** tick nothing (no data is collected or transmitted), then certify the three
statements (not sold to third parties, not used for unrelated purposes, not used for
creditworthiness or lending).

**Privacy policy URL** (paste after this branch is merged to `main`; the page is
[../PRIVACY.md](../PRIVACY.md)):

```text
https://github.com/mahakeerthi/web-snap-to-pdf/blob/main/docs/PRIVACY.md
```

**Privacy policy text** (the same words as `docs/PRIVACY.md`, for the dashboard's text box if it
offers one):

```text
WebPage to PDF does not collect, transmit or sell any data. Web pages are converted to PDF, image or Markdown files locally in your browser using Chrome's built-in engine, and the files are saved only to your device. Your settings are stored with Chrome's extension storage (synced by Chrome if you use Chrome Sync). The extension makes no network requests and contains no analytics or remote code.
```

## Account and distribution

**Contact email** (Account tab, required, verified by the store): **You fill this.** Use an address
you are happy to show publicly.

**Distribution tab:** visibility Public, all regions, price Free.

**Test instructions** (for the reviewer, if the dashboard shows the field):

```text
No account or login is needed. Open any ordinary web page (http or https), click the WebPage to PDF toolbar button, and choose Full page. A preview opens on the page. Pick PDF, PNG or JPEG in the Format menu and press Download: the file is saved to the Downloads folder. Article only previews just the main content. Select element lets you click one part of the page and save only that. Chrome shows its debugging bar while the preview is made and while a file is saved, because the extension uses the DevTools Protocol for printing and screenshots. The extension does not work on chrome:// pages or on the Chrome Web Store, which Chrome does not allow.
```

## Graphic assets

| Asset              | Size                                             | File                                               |
| ------------------ | ------------------------------------------------ | -------------------------------------------------- |
| Store icon         | 128 × 128                                        | `extension/icons/icon128.png`                      |
| Screenshots (1-5)  | 1280 × 800 (or 640 × 400), PNG or JPEG, no alpha | `docs/store/images/1-…` to `docs/store/images/5-…` |
| Small promo tile   | 440 × 280, no alpha                              | `docs/store/images/promo-tile-440x280.png`         |
| Marquee (optional) | 1400 × 560                                       | Not made. Only needed for featuring                |

Rebuild the images with `npm run store:images` (see `scripts/store-images/`) and check them with
`npm run check:store-images`.
