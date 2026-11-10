# Remove elements

Remove elements lets the user click away parts of the page (banners, sidebars, popups) before saving, undo the last removal, save straight from the picker bar, and later restore every removed element.

## Sub-features

- `remove-pick` hides each clicked element and counts it in the picker bar.
- `remove-undo` brings back the most recently removed element.
- `remove-done` closes the picker and leaves the elements hidden for later exports.
- `remove-save` saves the full page as a PDF from the picker bar's `Save PDF`.
- `remove-reset` restores every removed element from the popup's `Reset page (n)` card.

## How to get to it (user POV)

- Click the toolbar icon, then `Remove elements` (`#act-remove`). The popup closes and the picker starts in remove mode. Driven, through `popup.html` in a tab.
- Right-click the page, a frame or the toolbar icon and choose `Remove elements before saving`. Not drivable by the harness.
- Reset: the popup's `Reset page (n)` card (`#act-reset`, shown only while elements are removed). Driven. Or the context menu's `Restore all removed elements`. Not drivable by the harness.
- Picker bar buttons `Undo` and `Save PDF`. Reachable by the helper but not driven by any journey, and no suite asserts them. Only `node formal/page-restore/replay-finding.mjs` clicks `Undo`, during an export.

## Driving it with scripts/verify-popup.mjs

Preconditions:

- `node scripts/verify-popup.mjs doctor` exits 0.
- `article.html`, whose `#sidebar` holds `SIDEBAR-MARK`.

- **Run it.** `node scripts/verify-popup.mjs drive remove-reset`.
- **Start remove mode.** Click `#act-remove`. The picker host `[data-websnap-ui=""]` appears and the popup closes itself.
- **Remove.** Hover and click `#sidebar`. The bar's `.count` reads `1` and `#sidebar` computes `display: none`. Proof is `remove-picker.png`.
- **Done.** Click the bar's `Done` button (role button, label from `chrome.i18n.getMessage('picker_done')`). The picker closes; `#sidebar` stays hidden.
- **Popup sees it.** A new popup shows `#act-reset` reading `Reset page (1)`. Proof is `popup-removed.png`.
- **Export without it.** Click `#act-page`. The PDF has `ARTICLE-MARK` and no `SIDEBAR-MARK`.
- **Reset.** Click `#act-reset`. The card hides and `#sidebar` is visible on the page again. Proof is `popup-reset.png`.
- **Export with it.** Click `#act-page` again. The new file, `Fixture Article The Long Read (1).pdf`, has `SIDEBAR-MARK`.

## Gotchas

- Open finding, not fixed: opening remove mode while an export is running can leave an element hidden with nothing recorded to restore, so even `Reset page` cannot bring it back short of a reload. Two paths: clicking `Undo` during the export, or clicking after the pointer rested on an element the export then hid (the click removes the hidden element). `background.js` `startPicker` does not refuse while an export holds the tab. `node formal/page-restore/replay-finding.mjs` reproduces it on the real extension (exit 1 while it reproduces); the model and trace are in `.claude/skills/verify-page-restore/SKILL.md`. Any change to remove, undo or reset must run that skill.
- Open a new popup after the picker. The first popup closed itself when the picker started, and a popup opened earlier holds a stale removed count.
- In one popup, the second export's status line still shows the first export until it updates. Wait for the new download id, not `#status.ok`.
- Removals live in the page. Reloading the tab drops them and the reset card with them.
