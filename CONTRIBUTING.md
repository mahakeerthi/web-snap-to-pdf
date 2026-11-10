# Contributing to Web Snap PDF

Thanks for helping out. Web Snap PDF is a Chrome (Manifest V3) extension with no build step: the
`extension/` folder is loaded as-is, and everything else in the repository is tooling and tests.

## Setup

Requirements: Node.js 22 (18.18+ works), Playwright's Chromium and poppler (`pdfinfo`, `pdftotext`),
which the tests use to inspect generated PDFs.

```sh
npm install
npx playwright install chromium
brew install poppler                  # macOS; on Debian/Ubuntu: sudo apt-get install poppler-utils
```

Only the formal page-restore check (`node formal/page-restore/check.mjs`) needs Java and
`tools/tla2tools.jar` (gitignored); the script prints how to get both.

To try the extension, open `chrome://extensions`, enable Developer mode, click **Load unpacked**
and pick the `extension/` folder. Reload it there after changing any file.

## Checks and tests

```sh
npm run check          # lint + format:check + check:locales (run before every PR)
npm run lint           # ESLint (eslint.config.js)
npm run format         # Prettier, rewrites files in place
npm run check:locales  # every _locales/*/messages.json matches the English keys and placeholders
npm test               # end-to-end PDF pipeline (test/e2e.mjs), ~2 min
npm run test:content   # content-script checks: prepare/restore, pickers, preview, Markdown
npm run test:ui        # renders popup/options/viewer light + dark into test/out/ui/, fails on errors
npm run test:all       # all three test suites in sequence
HEADED=1 npm test      # watch a run in a real browser window
npm run package        # zip extension/ into dist/web-snap-pdf-<version>.zip for the Web Store
```

CI (`.github/workflows/ci.yml`) runs `npm run check` and all three test suites on every push and
pull request. The tests exercise real behaviour in Chromium, so a green run is the bar for merging.

### Why the tests use a modified manifest

The shipped extension has no host permissions: it relies on `activeTab`, which Chrome grants only
when a real user clicks the toolbar button, a context-menu entry or a shortcut. Automation cannot
trigger that grant, so `test/harness.mjs` copies `extension/` to a temporary folder and adds a
`host_permissions` entry for the local fixture server only. The manifest in the repository is
never changed; do not add host permissions to it to make a test pass.

## Project layout

```
extension/                 the unpacked extension (this folder is what gets zipped)
  manifest.json
  _locales/<lang>/         translations (English is the reference)
  icons/                   icon.svg source + generated PNGs (npm run build:icons)
  src/background.js        service worker: PDF / image / Markdown pipelines, messaging, menus
  src/content.js           page preparation and restore, pickers, preview overlay (injected on demand)
  src/lib/                 shared modules: settings, print params, paper sizes, i18n, theme
  src/popup/               toolbar popup
  src/options/             options page
  src/viewer/              fallback download page (only used if a direct download fails)
scripts/                   icon rasteriser, locale check, UI screenshots, packaging
scripts/verify-popup.mjs   drives the real popup and checks the downloaded file
test/e2e.mjs               end-to-end tests of the PDF pipeline
test/content.e2e.mjs       content-script and element-export tests
test/harness.mjs           shared browser launch, tab and download helpers, check reporter
test/fixtures/             pages served to the tests
formal/page-restore/       TLA+ model of the page-restore promise and its replay script
.claude/skills/            verification skills: verify-web-snap-pdf, verify-page-restore
docs/                      architecture notes and the release checklist
```

## Guidelines

- Keep changes small and focused, and match the existing style (Prettier and ESLint enforce most
  of it; `.editorconfig` covers editors).
- Messages between the popup, service worker and content script use `ps:*` types; keep the
  protocol backwards compatible and documented in `docs/ARCHITECTURE.md`.
- User-facing text goes through `_locales/en/messages.json`; add the key to every locale
  (`npm run check:locales` tells you what is missing).
- New behaviour needs a check in one of the test suites, with a fixture page under
  `test/fixtures/` if the existing ones do not cover it.
- Do not add permissions to `manifest.json` without discussing it in an issue first: every
  permission is shown to users and reviewed by the Chrome Web Store.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
