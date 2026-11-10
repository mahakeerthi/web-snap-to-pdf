---
name: verify-web-snap-pdf
description: Drive the Web Snap PDF Chrome extension the way a user does (the toolbar popup, the on-page element picker and preview overlay, the options page) and prove an export by checking the downloaded PDF, PNG, JPEG or Markdown file. Use before reporting a user-visible change as working, before starting a feature to confirm the baseline, and whenever an export, the picker, the overlay or the Markdown opt-in behaves unexpectedly.
---

# Verify Web Snap PDF

The extension has no server and no build step. Every run loads `extension/` into a fresh headless Chromium through `test/harness.mjs` and drives it against the fixture pages in `test/fixtures/`. The helper `scripts/verify-popup.mjs` does that for each mapped journey and keeps the proof.

The feature map in `features/README.md` lists every user-facing feature, every entry point, and the recipe for each. Read the matching feature file before you drive it.

## Launch

There is nothing to keep running. Each `doctor` and each journey calls `launchExtension()` from `test/harness.mjs`, which:

- serves `test/fixtures/` on `http://127.0.0.1:<random port>`,
- copies `extension/` to a temp dir and adds a host permission for that origin only,
- starts Chromium with a temp profile and a temp download dir, and hands downloads back to Chrome's own download delegate so the extension's filenames survive,
- returns `{ context, sw, extensionId, base, downloadDir, close }`.

Ready means the service worker answered and the fixture tab is printable, which is what `doctor` checks. One-time setup on a fresh checkout is `npm install` and `npx playwright install chromium`. PDF checks need poppler (`pdfinfo`, `pdftotext`; `brew install poppler`). Set `HEADED=1` to watch the browser (passed through to the harness; the helper has only been proven headless, so a headed run with the popup as a background tab is unverified).

## Doctor

```bash
node scripts/verify-popup.mjs doctor
```

Launches, opens `article.html`, asks the worker for `__websnap.pageState(tabId)`, and prints JSON. Exit 0 means `ok: true`: the extension loaded (`name` "Web Snap PDF", `version` from `extension/manifest.json`, `extensionId`), the fixture tab is `printable: true`, and `pdfinfo` and `pdftotext` are on PATH. Exit 1 prints the failing field or `error`. Run it first, and again whenever a journey fails before its first click.

## Drive

```bash
node scripts/verify-popup.mjs drive <journey>
node scripts/verify-popup.mjs drive all
```

| Journey              | Fixture                  | What the user does                                                                                         | Pass means                                                                |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `full-page`          | `article.html`           | Popup, `#act-page`                                                                                         | PDF with `ARTICLE-MARK` and `SIDEBAR-MARK`, popup status names the file   |
| `article`            | `article.html`           | Popup, `#act-article`                                                                                      | PDF with `ARTICLE-MARK`, without `SIDEBAR-MARK`                           |
| `select-element-png` | `element.html`           | Popup, `#act-select`, click `#red`, overlay PNG, Download                                                  | 800x600 PNG (400x300 at the default image scale 2), overlay closes        |
| `remove-reset`       | `article.html`           | Popup, `#act-remove`, click `#sidebar`, Done, popup, `#act-page`, `#act-reset`, `#act-page`                | First PDF lacks `SIDEBAR-MARK`, second has it, reset card hides           |
| `markdown`           | `article.html` + options | Popup shows no Markdown cards; options `#markdownEnabled`, confirm `#markdown-enable`; popup `#md-article` | `.md` file with a `# ` heading and `ARTICLE-MARK`, without `SIDEBAR-MARK` |

Each journey gets its own fresh browser and profile, so settings never leak between journeys. Exit 0 means every journey passed, 1 means at least one check failed, 2 means a usage error.

How the helper reaches each surface, for writing a new journey:

- **Popup.** The toolbar popup cannot be opened by automation. The helper opens `chrome-extension://<id>/src/popup/popup.html` as a background tab in the fixture's window (`chrome.tabs.create({ url, windowId, active: false })`), so `popup.js` resolves the fixture as the active tab exactly once at load. It then waits for `body[data-state]` and for `html[data-boot]` to go away, and asserts `data-state="ready"` and that `#page-title` equals the fixture's title before any click. A popup opened before the fixture is in front targets the wrong tab, so open a new popup after every picker run rather than reusing one.
- **Popup cards.** `#act-page`, `#act-article`, `#act-select`, `#act-remove`, `#act-reset` (only visible while elements are removed), `#md-page` and `#md-article` (inside `#md-row`, only while Markdown is enabled). The popup status line is `#status`, with class `ok` or `error`.
- **Picker.** Lives in an open shadow root on the page, host `[data-websnap-ui=""]`. Hover then click the target with `page.mouse`. The remove-mode bar has Undo, Save PDF and Done buttons and a `.count` badge. Find buttons by role and the label from `chrome.i18n.getMessage('picker_done')` so the run survives a non-English browser locale.
- **Preview overlay.** Host `[data-websnap-ui="preview"]`, open shadow root. Ready when `.stage canvas[data-ready]` exists. Format buttons `.seg [data-format="pdf|png|jpeg|markdown"]` (checked one has `aria-checked="true"`), `.copy`, `.download`, `.reselect`, `.close`; split parts add `.part-copy` and `.part-download` per `.part`. Playwright CSS locators pierce the shadow root.
- **Options page.** `chrome-extension://<id>/src/options/options.html` in a tab, ready when `html[data-boot]` is gone.
- **Downloads.** Snapshot `chrome.downloads.search({})` ids before the click, then wait for a new item in state `complete` (fail on `interrupted`). Never wait on `#status.ok` for a second export in the same popup: it still shows the first one. A repeated filename comes back as `<name> (1).pdf`.

`globalThis.__websnap` is for `doctor` and for reading state only. A journey's action must be the click a user makes.

## Evidence

Every `drive` run writes `test/out/verify/<run-id>/` (`<run-id>` is the start time in ISO form) and prints `evidence: <path>` last. It holds `summary.json` (pass and failures per journey) and one folder per journey with:

- the downloaded file or files, copied out before the browser closes,
- screenshots of the steps that prove the action: `popup.png` before the click, `popup-saved.png` with the status line, `overlay-png.png`, `remove-picker.png`, `popup-removed.png`, `popup-reset.png`, `options-confirm.png`, `popup-markdown.png`, and `failure.png` when a journey throws,
- `result.json`: journey, fixture, every control clicked in order, each download with filename and bytes plus `pdf.pages` and `pdf.pageSize` (pdfinfo) and `marks.found` / `marks.absent` (pdftotext), or `image` type and size, every check with pass or fail and detail, `notes`, `pass`, and `failures`.

Proof standards for anything you add:

- Drive the real control. Do not call `__websnap.generate`, send `ps:*` messages, or set `chrome.storage` to stand in for a click.
- Prove the side effect, not only the screen: the file on disk, opened with `pdfinfo` / `pdftotext` or parsed for image size, and the page state the user would see (`#sidebar` display after remove and reset).
- Pair every mark that must be present with one that must be absent where the feature promises an exclusion, so the text check cannot pass vacuously.
- A failing journey stays failing. Put the reason in that feature's Gotchas and never loosen a check to make it pass.

## Cleanup

`close()` from the harness runs in a `finally` for every launch. It closes Chromium and deletes the three temp dirs it created (`websnap-ext-*`, `websnap-*` profile, `websnap-dl-*`) under Node's `os.tmpdir()` (on macOS that is `/var/folders/...`, not `/tmp`). Kill only a Chromium you started; never by process name. If a run was killed mid-way, list `websnap-*` dirs in `os.tmpdir()` before and after your next run and remove only ones your interrupted run left. Cleanup never touches `test/out/verify/`; the evidence stays until a human deletes it.

## Helpers

- `node scripts/verify-popup.mjs doctor` checks the instance, as above.
- `node scripts/verify-popup.mjs drive <full-page|article|select-element-png|remove-reset|markdown|all>` drives journeys and writes evidence.
- `node formal/page-restore/replay-finding.mjs` replays the fixed page-restore finding on the real extension as a regression check (exit 0 expected, 1 on a regression). See `.claude/skills/verify-page-restore/SKILL.md`.

## Broad regression check

The journeys prove the user paths. The suites cover the edge cases, and run them for the code you touched:

- `npm test`: PDF pipeline (paper size, margins, header and footer, single page, screen media, page ranges, article mode, remove and reset, element PDF, large downloads, restricted pages, extension pages load).
- `npm run test:content`: content script, prepare and restore, pickers, preview overlay (PDF, PNG, JPEG, split parts, copy, theme), Markdown converter. `ONLY='<name regex>'` runs a subset.
- `npm run test:ui`: every extension page renders without errors in both themes.
- `npm run check`: ESLint, Prettier, locale parity.

## What the harness cannot drive

The verified build is a stand-in for the shipped one in these ways, and these paths stay unverified by automation until a human checks them in a real Chrome profile:

- **activeTab.** The shipped manifest has no host permissions and relies on the `activeTab` grant from a real toolbar click, keyboard shortcut or context-menu click. The harness instead adds `host_permissions` for the fixture origin to its temp copy of the manifest. A bug that only shows without host permissions passes here.
- **The toolbar popup window.** The helper opens `popup.html` in a tab. Its size, focus and auto-close behavior (the popup closing when the page gets focus) are not exercised. `window.close()` after starting a picker does close the tab, recorded in each picker journey's `notes`.
- **Keyboard shortcuts** `Alt+Shift+P` (save page) and `Alt+Shift+A` (save article), handled by `chrome.commands`.
- **Context-menu items** (Save page, Save article, Select an element, Remove elements, Restore all removed elements) on the page, frame and toolbar icon.
- **The embedded options dialog.** `options_ui.open_in_tab` is false, so the popup's gear opens options inside `chrome://extensions`. The helper opens `options.html` in its own tab.
- **Save As prompts.** With `saveAs` on, Chrome shows a native dialog per file.

## Isolation

Each launch gets a random fixture port, its own profile and its own download dir, so several runs can go side by side, including next to `npm test`. One exception: headless Chromium on macOS writes the real system clipboard. The overlay's Copy image and part Copy buttons are therefore not isolated, which is why `drive` has no copy journey and why the "Copy image" check in `test/content.e2e.mjs` can fail in a full run. Rerun it alone with `ONLY='Copy image' npm run test:content` before calling it a regression, and expect a run to overwrite whatever the user had copied.
