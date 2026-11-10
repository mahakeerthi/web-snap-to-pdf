# Web Snap PDF

Chrome MV3 extension that saves the current page, its article, or a picked element as PDF, PNG,
JPEG or (opt-in) Markdown, using Chrome's own print engine through `chrome.debugger`. No build
step: `extension/` is loaded as-is. Setup, commands and layout are in `CONTRIBUTING.md`; module
design, the `ps:*` message protocol and the settings schema are in `docs/ARCHITECTURE.md`.
`TASKS.md` is the user's status board: do not flip its checkboxes for work the user has not
accepted.

## Before you report a change as working

- `npm run check` (lint, Prettier, locale parity) and the suite that covers the change:
  `npm test` (PDF pipeline), `npm run test:content` (content script, pickers, preview, Markdown),
  `npm run test:ui` (extension pages render without errors). `ONLY='<test name regex>'` runs a
  subset of `test/e2e.mjs` or `test/content.e2e.mjs`; `HEADED=1` shows the browser.
- User-visible behavior: drive it with the `/verify-web-snap-pdf` skill
  (`.claude/skills/verify-web-snap-pdf/`), which clicks the real popup against a fixture tab and
  checks the downloaded file.
- Changes to how the page is mutated or restored (`setStyle`, `restore`, `prepare`, `isolate`,
  `neutralizeFixed`, the picker's hover/remove/undo, `ps:reset-page`) or how exports are
  serialised (`claimTab`, `withPreparedPage`, `startPicker`): run `node formal/page-restore/check.mjs` and follow the
  `/verify-page-restore` skill (`.claude/skills/verify-page-restore/`). It needs Java and
  `tools/tla2tools.jar` (gitignored; the script prints how to get both).

## Rules the code depends on

- `extension/src/content.js` is a classic script injected as one file; keep it one file, with no
  imports. Every temporary page change goes through `setStyle` / `setAttr` so `restore()` can
  undo it.
- Every new `ps:*` message gets a row in the `docs/ARCHITECTURE.md` message tables.
- User-facing strings go in `extension/_locales/en/messages.json` and every other locale
  (`npm run check:locales`).
- Tests launch the extension through `test/harness.mjs`, which copies `extension/` and adds a
  host permission for the fixture server. Never add host permissions to `extension/manifest.json`.
- `globalThis.__websnap` in `background.js` is a test hook. Keep it to what tests and the verify
  skill call.

## Known flake

The "Copy image" check in `test/content.e2e.mjs` can fail in a full run on macOS because headless
Chromium uses the shared system clipboard. Rerun it alone with `ONLY='Copy image'` before treating
it as a regression.

## Working with pstack in Claude Code

Use `/pstack:poteto-mode` for rigorous work. Project skills live in `.claude/skills/` (not
`.cursor/`); model roles come from `~/.claude/rules/pstack-models.md`. Keep the verification skills
current with `/pstack:maintain-verification-skill` and `/pstack:maintain-formal-verification-skill`.
These `/pstack:*` commands are typed by a person; an agent asked to run one reads that skill's
`SKILL.md` in the installed pstack plugin and follows it.
