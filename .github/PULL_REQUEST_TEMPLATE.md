## What this changes

<!-- What was wrong or missing, and what you changed. Link the issue, for example "Fixes #12". Add light and dark screenshots for a visible UI change. -->

## Checks

<!-- Check each box that applies. Leave the rest unchecked. -->

- [ ] `npm run check` passes.
- [ ] The suite that covers this change passes: `npm test`, `npm run test:content`, or `npm run test:ui`.
- [ ] I tried the change in Chrome with the unpacked `extension/` folder.
- [ ] New user-facing strings are in every locale under `extension/_locales/`.
- [ ] Each new `ps:*` message has a row in `docs/ARCHITECTURE.md`.
- [ ] For a change to page restore or to export serialisation, `node formal/page-restore/check.mjs` passes.
- [ ] `extension/manifest.json` has no new permissions, or an issue discusses the new one.
