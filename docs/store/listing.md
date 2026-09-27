# Chrome Web Store listing — Web Snap PDF 1.1.0

Exact text to paste into the Developer Dashboard. The dashboard fields are plain text: copy the
contents of each `text` block, not the Markdown around it. Checklist and background:
[../RELEASE.md](../RELEASE.md).

## Store listing tab

**Name** (from the manifest, `__MSG_extName__`):

```text
Web Snap PDF
```

**Summary** (from the manifest, `__MSG_extDescription__` in `extension/_locales/en/messages.json`;
the store shows the manifest description and it must be ≤ 132 characters — this one is 127, and
`npm run check:locales` enforces the limit for every language. If the locale file changes, it wins;
update this block to match):

```text
Save any web page as a PDF in one click. Keeps styles and links, paged or single-page, 100% local with Chrome’s own PDF engine.
```

**Description:**

```text
Web Snap PDF turns the page you are reading into a clean PDF with Chrome's built-in print engine. Text stays selectable, links stay clickable, and nothing is uploaded anywhere.

Three ways to save
• Full page – the whole page, top to bottom
• Article only – the main content, without menus, sidebars or ads
• Select element – click one part of the page, preview it, and save it as PDF, PNG or JPEG

Features
• Paged PDF or one long single page
• 22 paper sizes, portrait or landscape, margin presets or custom margins
• Fit to a desktop, laptop, tablet or mobile layout width, or set the scale yourself
• Header and footer with title, date, URL and page numbers
• Print or screen styles, page ranges, PDF bookmarks from headings
• Loads lazy images, hides sticky bars, expands scrollable chat and docs panes
• Remove ads, banners or anything else before saving, with undo
• Element images at 2× resolution, with Copy image for PNG
• Preview tab before downloading, custom file names, right-click menu and keyboard shortcuts
• Light and dark mode
• Available in English, Español, Deutsch, Français, Português (Brasil), हिन्दी, 日本語 and 简体中文
• Experimental, off by default: Markdown export of the page, the article or a selected element (turn it on in the extension's settings)

Private by design
No account, no uploads, no tracking, no ads. Pages are converted on your device and the files go straight to your Downloads folder. Free, with no paid tier.

Good to know
While a PDF is generated or an element is captured, Chrome shows "Web Snap PDF started debugging this browser". That is how Chrome lets extensions use its PDF and screenshot engine; the bar disappears as soon as the file is ready. Chrome does not allow extensions on its own pages (chrome://) or on the Chrome Web Store.
```

**Category:** Tools (alternative: Workflow & Planning / Productivity, depending on the dashboard's
current category list).

**Language:** English (the listing can be localised later from the `_locales` translations).

## Privacy practices tab

**Single purpose description:**

```text
Web Snap PDF saves the web page in the current tab, or a part of it that the user selects, as a file on the user's device: a PDF, or a PNG/JPEG image of a selected element (and, only if the user turns on the experimental option, a Markdown text file). All conversion happens locally with Chrome's own rendering engine.
```

**Permission justifications:**

`debugger`

```text
Chrome exposes its native PDF renderer and full-element screenshots to extensions only through the DevTools Protocol. When the user starts an export, the extension attaches to that one tab, calls Page.printToPDF (for PDFs) or Page.captureScreenshot with a clip (for the element preview and PNG/JPEG export), plus Emulation.setEmulatedMedia, Emulation.setDeviceMetricsOverride, Page.getLayoutMetrics and Runtime.evaluate (reading the viewport height only) to lay out and measure the page, and detaches as soon as the file is produced, including on errors. It does not read network traffic, cookies, storage or any other tab. Chrome shows its standard debugging bar during the export.
```

`activeTab`

```text
Grants temporary access to the tab on which the user clicked the toolbar button, a context-menu item or a keyboard shortcut, so the extension needs no host permissions and never runs on a site the user did not act on.
```

`scripting`

```text
Injects the extension's own packaged content script into the active tab when the user starts an action. The script prepares the page for export (loads lazy images, hides sticky bars, isolates the article or the selected element), shows the element picker and the on-page preview, converts the page to Markdown when that opt-in option is used, and restores the page afterwards.
```

`downloads`

```text
Saves the generated PDF, PNG/JPEG image or Markdown file to the user's Downloads folder, or to the location the user picks when "Ask where to save" is enabled.
```

`storage`

```text
Stores the user's export settings (paper size, margins, theme, language and similar) and small interface preferences, and passes a generated PDF from the service worker to the extension's own preview page in memory (session storage). No page content or browsing data is stored.
```

`contextMenus`

```text
Adds "Save page as PDF", "Save article only as PDF", "Select an element to preview and save", "Remove elements before saving" and "Restore all removed elements" to the right-click menu.
```

**Host permissions:** none requested.

**Remote code:**

```text
No, I am not using remote code. All JavaScript is packaged in the extension.
```

**Data usage:** tick nothing (no data is collected or transmitted), then certify the three
statements (not sold to third parties, not used for unrelated purposes, not used for
creditworthiness or lending).

**Privacy policy** (optional when nothing is collected; host it on the project's GitHub Pages or
repository and paste the URL):

```text
Web Snap PDF does not collect, transmit or sell any data. Web pages are converted to PDF, image or Markdown files locally in your browser using Chrome's built-in engine, and the files are saved only to your device. Your settings are stored with Chrome's extension storage (synced by Chrome if you use Chrome Sync). The extension makes no network requests and contains no analytics or remote code.
```

## Graphic assets

| Asset              | Size                                             | Source                                                                         |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Store icon         | 128 × 128                                        | `extension/icons/icon128.png`                                                  |
| Screenshots (1-5)  | 1280 × 800 (or 640 × 400), PNG or JPEG, no alpha | See the plan in [RELEASE.md](../RELEASE.md#screenshots)                        |
| Small promo tile   | 440 × 280                                        | To be made from `extension/icons/icon.svg` + name + "Web page to PDF, locally" |
| Marquee (optional) | 1400 × 560                                       | Only needed for featuring                                                      |
