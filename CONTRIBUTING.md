# Contributing to Web Snap PDF

Thanks for helping. Web Snap PDF is a Chrome extension with no build step. Chrome loads the
`extension/` folder as it is, and the rest of the repository is tests, scripts, and docs. Everyone
who takes part agrees to the [code of conduct](CODE_OF_CONDUCT.md).

## Find something to work on

- Browse the [open issues](https://github.com/mahakeerthi/web-snap-to-pdf/issues), starting with
  the ones labelled `good first issue`.
- The README lists [open tasks](README.md#contributing) that need an owner, such as translating the
  right-click menu or closing gaps in the Markdown converter.
- If a translation reads badly, fix it in `extension/_locales/<language>/messages.json`.

Before you start a large change, or any change that adds a permission, open an issue so we can
agree on the approach first.

## Set up

You need Node.js 20 or newer (CI uses Node.js 22), Playwright's Chromium, and poppler. The tests
use poppler's `pdfinfo` and `pdftotext` to read the PDFs they generate.

```sh
npm install
npx playwright install chromium
brew install poppler   # on Debian or Ubuntu: sudo apt-get install poppler-utils
```

To try a change in Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load
unpacked**, and select the `extension/` folder. After you edit a file, click the reload button on
the extension's card and reload the tab you test on.

## Commands

| Command                | What it does                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run check`        | Runs ESLint, the Prettier check, and the locale check. CI runs it first.                                    |
| `npm test`             | Runs the end-to-end tests of the PDF pipeline in `test/e2e.mjs`.                                            |
| `npm run test:content` | Tests the content script, the pickers, the preview, image capture, and Markdown in `test/content.e2e.mjs`.  |
| `npm run test:ui`      | Renders the popup, options, and fallback pages in both themes into `test/out/ui/` and fails on page errors. |
| `npm run test:all`     | Runs the three test suites in sequence.                                                                     |
| `npm run format`       | Rewrites files with Prettier.                                                                               |
| `npm run package`      | Builds the ZIP file for the Chrome Web Store in `dist/`.                                                    |
| `npm run build:icons`  | Renders `extension/icons/icon.svg` to the PNG icon sizes.                                                   |

The tests load the extension into Chromium through `test/harness.mjs` and serve the pages in
`test/fixtures/` from a local port. In `npm test` and `npm run test:content`, set `HEADED=1` to watch
the run in a visible browser window, and set `ONLY='<regex>'` to run only the tests whose names
match. `npm run test:ui` always runs headless.

## Make a change

1. Fork the repository and create a branch from `main`.
2. Make one fix or one feature per branch.
3. Run `npm run check`. It runs ESLint, the Prettier check, and the locale check. To fix formatting,
   run `npm run format`.
4. Run the test suite that covers your change, from the table below. For new behaviour, add a check
   to that suite, and add a page to `test/fixtures/` if no existing page fits.
5. Push the branch and open a pull request against `main`. CI runs `npm run check` and all three
   test suites on Ubuntu.

| If you changed                                                            | Run                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| The PDF pipeline in `extension/src/background.js` or `extension/src/lib/` | `npm test`                                        |
| Page preparation, the pickers, the preview, image capture, or Markdown    | `npm run test:content`                            |
| The popup, the options page, or the fallback download page                | `npm run test:ui`                                 |
| How the extension changes or restores the page, or serialises exports     | `node formal/page-restore/check.mjs`              |
| Anything a user can see                                                   | Also try it in Chrome with the unpacked extension |

On macOS, the "Copy image" check in `npm run test:content` can fail in a full run, because headless
Chromium shares the system clipboard. Rerun it alone with `ONLY='Copy image'` before you treat it as
a real failure.

## What a good pull request contains

- A short description of what was wrong or missing and what you changed, with a link to the issue
  if there is one.
- A test that fails without the change and passes with it, when a test can cover the change.
- Screenshots of any visible UI change in the light and dark themes. `npm run test:ui` saves
  screenshots of the popup, options, and fallback pages to `test/out/ui/`.
- New strings in every locale. If you cannot translate a string, add the English text to that
  locale and say so in the pull request.
- A row in the message tables in `docs/ARCHITECTURE.md` for every new `ps:*` message.

## Rules the code depends on

- `extension/src/content.js` is a classic script that Chrome injects as one file. Keep it in one
  file, with no imports.
- Every temporary change to the page goes through `setStyle` or `setAttr`, so that `restore()` can
  undo it.
- User-facing strings go in `extension/_locales/en/messages.json` and in every other locale.
  `npm run check:locales` lists the missing keys.
- Never add host permissions to `extension/manifest.json`. Automation cannot grant `activeTab`, so
  `test/harness.mjs` copies `extension/` to a temporary folder and adds a host permission for the
  local test server there.
- Discuss any other new permission in an issue first. Chrome shows every permission to users, and
  the Chrome Web Store reviews each one.
- `globalThis.__websnap` in `background.js` is a test hook. Keep it to what the tests and the
  verification skill call.

## Check page-restore changes

The extension promises that every element it changes looks as it did before once no export is
running, except the elements the user removed. `formal/page-restore/` holds a TLA+ model of that
promise. Run it when you change how the extension changes or restores the page (`setStyle`,
`restore`, `prepare`, `isolate`, the picker's remove and undo, or `ps:reset-page`) or how it
serialises exports (`claimTab`, `withPreparedPage`, or `startPicker`):

```sh
node formal/page-restore/check.mjs
```

The check needs Java and `tools/tla2tools.jar`, which git ignores. The script prints how to get
both. `.claude/skills/verify-page-restore/SKILL.md` explains how to read the result. Other changes
do not need Java.

## Verify a user-visible change

`.claude/skills/verify-web-snap-pdf/SKILL.md` drives the real popup, element picker, preview, and
options page against a test page, then checks the downloaded file. Coding agents load it as a skill.
It is a Markdown file of commands, so you can follow it by hand too. Start with
`node scripts/verify-popup.mjs doctor`, then run `node scripts/verify-popup.mjs drive <journey>`.

## Project layout

```
extension/                 the unpacked extension (this folder is what gets zipped)
  manifest.json
  _locales/<lang>/         translations (English is the reference)
  icons/                   icon.svg source and generated PNGs (npm run build:icons)
  src/background.js        service worker: PDF, image, and Markdown pipelines, messaging, menus
  src/content.js           page preparation and restore, pickers, preview (injected on demand)
  src/lib/                 settings, print parameters, paper sizes, i18n, theme
  src/popup/               toolbar popup
  src/options/             options page
  src/viewer/              fallback download page, used only if a direct download fails
scripts/                   build-icons, check-locales, package, screenshot-ui, screenshot-preview, verify-popup
test/e2e.mjs               end-to-end tests of the PDF pipeline
test/content.e2e.mjs       content script and element export tests
test/harness.mjs           shared browser launch, tab and download helpers, check reporter
test/fixtures/             pages served to the tests
formal/page-restore/       TLA+ model of the page-restore promise
.claude/skills/            verification skills: verify-web-snap-pdf, verify-page-restore
docs/                      architecture notes, release checklist, store listing text
```

## License

By contributing, you agree to license your contributions under the [MIT License](LICENSE).
