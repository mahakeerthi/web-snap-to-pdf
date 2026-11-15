# Remove elements

Remove elements lets the user click away parts of the page (banners, sidebars, popups) before saving, undo the last removal, open the page preview from the picker bar, and later restore every removed element.

## Sub-features

- `remove-pick` hides each clicked element and counts it in the picker bar.
- `remove-undo` brings back the most recently removed element.
- `remove-done` closes the picker and leaves the elements hidden for later exports.
- `remove-preview` opens the page preview (the same overlay as Full page) from the picker bar's `Preview` button, with the removals applied and nothing downloaded until Download.
- `remove-reset` restores every removed element from the popup's `Reset page (n)` card.

## How to get to it (user POV)

- Click the toolbar icon, then `Remove elements` (`#act-remove`). The popup closes and the picker starts in remove mode. Driven, through `popup.html` in a tab.
- Right-click the page, a frame or the toolbar icon and choose `Remove elements before saving`. Not drivable by the harness.
- Reset: the popup's `Reset page (n)` card (`#act-reset`, shown only while elements are removed). Driven. Or the context menu's `Restore all removed elements`. Not drivable by the harness.
- Picker bar buttons `Undo` and `Preview` (the locale key is still `picker_savePdf`). Reachable by the helper but not driven by any journey. `npm run test:content` asserts that `Preview` opens the page preview. `node formal/page-restore/replay-finding.mjs` would click `Undo` during an export, but the picker is refused there now, so it no longer reaches the button.

## Driving it with scripts/verify-popup.mjs

Preconditions:

- `node scripts/verify-popup.mjs doctor` exits 0.
- `article.html`, whose `#sidebar` holds `SIDEBAR-MARK`.

- **Run it.** `node scripts/verify-popup.mjs drive remove-reset`.
- **Start remove mode.** Click `#act-remove`. The picker host `[data-websnap-ui=""]` appears and the popup closes itself.
- **Remove.** Hover and click `#sidebar`. The bar's `.count` reads `1` and `#sidebar` computes `display: none`. Proof is `remove-picker.png`.
- **Done.** Click the bar's `Done` button (role button, label from `chrome.i18n.getMessage('picker_done')`). The picker closes; `#sidebar` stays hidden.
- **Popup sees it.** A new popup shows `#act-reset` reading `Reset page (1)`. Proof is `popup-removed.png`.
- **Export without it.** Click `#act-page`, wait for the overlay, then click `.download`. The PDF has `ARTICLE-MARK` and no `SIDEBAR-MARK`.
- **Reset.** Click `#act-reset`. The card hides and `#sidebar` is visible on the page again. Proof is `popup-reset.png`.
- **Export with it.** Click `#act-page` again, wait for the overlay, then click `.download`. The new file, `Fixture Article The Long Read (1).pdf`, has `SIDEBAR-MARK`.

## Gotchas

- The picker is refused during an export. While an export holds the tab, `background.js` `startPicker` rejects both modes with "Wait for the current export to finish before selecting elements." The popup shows that message in its status line. The context menu stays silent and only logs the error. Opening the picker during an export used to leave an element hidden with nothing for `Reset page` to restore. `node formal/page-restore/replay-finding.mjs` replays both old paths and exits 0 while the fix holds; the model and traces are in `.claude/skills/verify-page-restore/SKILL.md`. Any change to remove, undo or reset must run that skill.
- Open a new popup after the picker. The first popup closed itself when the picker started, and a popup opened earlier holds a stale removed count.
- Full page opens an overlay and the popup closes itself, so there is no status line to check. Open a new popup before each `#act-page` click, and wait for the new download id.
- Removals live in the page. Reloading the tab drops them and the reset card with them.
