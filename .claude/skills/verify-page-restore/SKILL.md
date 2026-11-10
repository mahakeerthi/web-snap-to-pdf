---
name: verify-page-restore
description: Model-check Web Snap PDF's page-restore promise with TLA+ (formal/page-restore). Use when a change touches how content.js mutates or restores the page (setStyle, restore, prepare, isolate, neutralizeFixed, the picker's hover, remove and undo, ps:reset-page) or how background.js serialises exports (claimTab, withPreparedPage, startPicker, ps:reset-page), and before claiming such a change is safe.
---

# Verify the page-restore promise

**The promise.** When no export is running, every element the extension touched shows the page's own style, except elements the user removed with the picker, and "Restore all removed elements" brings those back.

**The harm when it breaks.** An element stays hidden (or reappears) on the user's page after an export, and nothing in the UI can put it back short of reloading the tab.

The check is a TLA+ model of one element's inline `display` under every order of the actions below, checked exhaustively by TLC. It runs in under two seconds.

## Run it

```bash
node formal/page-restore/check.mjs
```

Needs Java and `tools/tla2tools.jar` (gitignored). The script prints the install commands when either is missing. On macOS: `brew install openjdk`, then the `curl` line it prints (TLA+ v1.7.4, pinned in `coverage.json` with its sha256, which the script verifies before running).

| Exit | Meaning                                                                                                                                         | What to do                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 0    | Every config gives its expected result and no covered function changed since the sync.                                                          | Nothing.                                                    |
| 1    | A config's result differs from `coverage.json` `expect`.                                                                                        | A new finding or a broken model. See "Read a result".       |
| 2    | Results match, but a covered function's text changed since the sync.                                                                            | Review the model against the change. See "Keep it in step". |
| 3    | The check could not run: no Java, a missing or different jar, TLC printed no result, or a covered function is missing (`! missing: <file#fn>`). | Fix the setup, or update `functions` and the model.         |

`--trace` prints TLC's full output, including each counterexample.

## Does my change touch the verified code?

The covered functions, by file, are listed in `formal/page-restore/coverage.json` under `functions`. The check hashes each one, so exit 2 tells you when you touched one. Besides the mutation and restore code, they include `neutralizeFixed` (the other way `prepare` can hide X), `elementAt`, `pickable` and `setCurrent` (how hovering sets the picker's `p.current`, which a click then picks), and `renderBar` (it builds the Undo button). Also treat these as covered even though they are not hashed: any new code path that writes `el.style` on page elements outside `setStyle`, a new sender of `ps:prepare`, `ps:restore`, `ps:start-picker` or `ps:reset-page`, the closures `startPicker` installs (`p.onMove`, `p.onClick`, `p.onKey`), and the `chrome.contextMenus.onClicked` listener in `background.js`.

## What each model action stands for

`formal/page-restore/PageRestore.tla` maps every action to code. In short:

| Model                                     | Code                                                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inline`                                  | `X.style` `display` value and priority                                                                                                                                 |
| `undo`                                    | `state.undo` entries for X (`setStyle` snapshots), unwound by `restore()`                                                                                              |
| `removed`                                 | `state.removed` entries for X (`pick` in remove mode)                                                                                                                  |
| `picker`                                  | `state.picker !== null`                                                                                                                                                |
| `hovered`                                 | the picker's `p.current === X`                                                                                                                                         |
| `job`                                     | `activeJobs.has(tabId)`: `claimed`, then `loading` (inside `prepare`, at `await loadLazyContent()`), then `printing` (after `isolate`)                                 |
| `ClaimTab`, `ExportDone`                  | `claimTab`, and the `finally` of `withPreparedPage` sending `ps:restore`                                                                                               |
| `PrepareStart`, `PrepareIsolate`          | `prepare()` before and after its first `await`; `isolate()` hiding X as a sibling of the root, or `neutralizeFixed()` hiding X as a small fixed element                |
| `StartPicker`                             | `background.js` `startPicker` (popup and context menu); `PickerGuard` models it refusing while `activeJobs` has the tab                                                |
| `Hover`, `Unhover`                        | `p.onMove`: `elementAt` and `setCurrent` make X `p.current` while X is shown; hovering anything else replaces it                                                       |
| `PickRemove`, `UndoRemoval`, `StopPicker` | `p.onClick` then `pick` (remove mode) on X, or on a stale `p.current`; the picker bar's Undo (built by `renderBar`, runs `undoRemoval`); Done or Escape (`stopPicker`) |
| `ResetPage`                               | the `ps:reset-page` guard in `handleMessage`, then content `restore()` and `resetRemovals()`                                                                           |

The invariant is `IdlePageMatchesRemovals`. `PageRestore.cfg` models the code as it is. `PageRestoreGuarded.cfg` differs only in `PickerGuard = TRUE`.

**`PageRestoreGuarded.cfg` models only an atomic guard.** `background.js` `startPicker` awaits `readyTab`, `loadSettings` and `uiStrings` before `sendContent`. An `activeJobs` check at its top is check-then-act: an export can claim the tab during those awaits. A scratch model that splits `StartPicker` into the check and the delivery violates `IdlePageMatchesRemovals` with a 9-state trace even with the guard on. A fix matches the guarded model only in one of two forms:

- `content.js` refuses `ps:start-picker` while the page is prepared, with a flag set in `prepare` and cleared in `restore`. A scratch model of this form (refused once `prepare` has run, so allowed while `job = "claimed"`) passes (16 states).
- The `activeJobs` check sits in `startPicker` right before `sendContent`, after the awaits.

Two other atomic steps are deliberate. `ResetPage` checks `job = "idle"` in the same step as the content `restore()`, though `handleMessage` awaits in between. That overstates atomicity but is safe: `PageRestoreGuarded.cfg` still passes with the guard removed entirely (16 states). `ExportDone` merges `ps:restore` with `activeJobs.delete`. That is sound: between the two only picker actions can run, none of them reads `job`, and a guarded `StartPicker` is only refused there. A scratch model with the two as separate steps passes under the guarded settings (18 states).

## Read a result

Read every TLC result with the pstack statechart skill. It tells an invariant violation as its path in plain words, and draws the state chart when the check passes. A person types `/pstack:statechart`. An agent cannot invoke it, so it reads that skill's `SKILL.md` from the installed pstack plugin and follows it. Without pstack, read TLC's trace directly with `--trace`.

Then decide which kind of failure it is.

- **Real bug.** Each step of the trace maps to a user action or a code step in the table above, and you can replay it on the real extension. Replay it before you report it, with the content-script messages the test suites use (`test/content.e2e.mjs` sends `ps:prepare`, `ps:start-picker`, `ps:restore` from the service worker), with `formal/page-restore/replay-finding.mjs` as a template, or with `/verify-web-snap-pdf`. Report the trace in the code's words. Do not edit the model or the expectations to make it pass, and do not change product code unless the user asks.
- **Modeling error.** A step in the trace cannot happen in the code (an action fires when the code's guard forbids it, or one model step spans an `await` in the code). Fix the model so each atomic step matches an atomic stretch of code, then rerun.

## Known finding (open)

`PageRestore.cfg` violates `IdlePageMatchesRemovals` today. That is expected and recorded in `coverage.json`. Both paths need the picker to open while an export runs, which `startPicker` allows.

**Stale-hover path.** This is TLC's trace for `PageRestore.cfg` (`--trace`). It needs the `loading` window, so `loadLazy` on (the default).

1. The user saves the article as PDF. `claimTab`, then `prepare()` stops the picker, restores, marks the root and awaits `loadLazyContent()`.
2. Meanwhile the user picks "Remove elements before saving" from the context menu. The picker opens on the page being prepared.
3. The pointer rests on X. `p.onMove` makes X `p.current`.
4. `isolate()` hides X as a sibling of the root, snapshotting X's own value into `state.undo`. `p.current` is still X.
5. The user clicks. `p.onClick` picks `p.current` and `pick` has no visibility check, so it records `none !important` as X's own value in `state.removed`.
6. The export finishes. `ps:restore` shows X again, though a removal of X is on record. TLC stops here.

"Restore all removed elements" then writes the recorded `none !important` back. X is hidden with 0 removals on record. The export need not have a root: with "Hide fixed elements" on (the default), `neutralizeFixed()` hides a small fixed X in step 4 of a full-page export. That was replayed once on the real extension with a scratch copy of the replay (full-page export of `article.html`, X = `header.fixed`): the header stayed hidden with 0 removals after "Restore all".

**Undo path.** It needs an export with a root, "Article only" or an element export: a full-page export has no root, so `isolate()` does not run, and `neutralizeFixed()` skips elements that are already hidden. TLC reaches it with the hover actions removed (8 states: X removed during the `loading` window), and with user actions barred from the `loading` window, as with `loadLazy` off (this 9-state trace):

1. The user saves the article as PDF. `claimTab` runs, and before `ps:prepare` arrives the user opens "Remove elements" and removes X (`pick`): X gets `display: none !important`, and `state.removed` remembers X's own value.
2. `prepare()` stops the picker, and `isolate()` hides X as a sibling of the root, snapshotting `none !important` into `state.undo`.
3. While the export runs, the user opens the picker from the context menu and clicks Undo. `undoRemoval` puts X's own value back and drops X from `state.removed`.
4. The export finishes. `ps:restore` writes the `none !important` snapshot back.

X is hidden, no removal is on record, and "Restore all removed elements" cannot show it again.

**An Undo-only fix is not enough.** A scratch model where `UndoRemoval` also needs `job = "idle"` still violates `IdlePageMatchesRemovals` (8-state trace, the stale-hover path above). The real extension agrees: with `undoRemoval` patched to do nothing while `state.undo` is non-empty, the replay reports the Undo path not reproduced and the stale-hover path reproduced. `PageRestoreGuarded.cfg` passes, so an atomic `startPicker` guard removes both paths in the model.

**Replayed on the real extension.** `node formal/page-restore/replay-finding.mjs` drives both paths on `test/fixtures/article.html` with X = `#sidebar`, inside a real `__websnap.generate` article export with `loadLazy` on, so `activeJobs` holds the tab. Its Undo path removes X just before the export starts, which the model also allows. It adds 1500 filler paragraphs to the article through `page.evaluate` (the fixture file is unchanged) so the windows between export steps are wide enough to act in. For each path it prints the steps and `REPRODUCED` when `#sidebar` keeps `display: none !important` with 0 removals after "Restore all". Exit 1 means at least one path reproduced, 0 means neither did, and 2 means inconclusive (the export ended before the picker steps, or the replay failed). Today it exits 1 with both paths reproduced. Against a scratch copy with the `activeJobs` check right before `sendContent` (`EXT_DIR=<copy>`), it exits 0.

While this finding is open, `PageRestore.cfg` already expects a violation, so a new bug would not change its result. `PageRestoreGuarded.cfg` is then the regression check for every path except the `startPicker` guard: a new break anywhere else turns it from `pass` to a violation, and the script exits 1.

When the code is fixed with an atomic guard: set `PickerGuard = TRUE` in `PageRestore.cfg` (or delete the guard constant and the second config), change `expect` for `PageRestore.cfg` to `pass`, rerun, check that `replay-finding.mjs` exits 0, then sync.

## Evidence that the check can fail

Each of these was run on a scratch copy of the current model, with `PageRestoreGuarded.cfg` settings unless the bullet says otherwise. A violating run stops at the first violation, so its count is the states TLC had found by then.

- `PrepareIsolate` hiding X without appending to `undo` (a `display` write that skips `setStyle`) violates `IdlePageMatchesRemovals` with a 5-state trace (13 states found).
- `ExportDone` writing X's original value instead of the snapshot (a `restore()` that calls `removeProperty` instead of putting the snapshot back) violates it with a 7-state trace (17 states found): a removed X reappears after an export.
- Swapping `restore()` and `resetRemovals()` in `ResetPage` still passes (16 states). That is correct, not a blind spot: `ResetPage` only runs while `job = "idle"`, when `undo` is always empty, so the order cannot matter. With that guard removed (as if `handleMessage` let `ps:reset-page` through during an export), the code's order still passes and the swapped order violates `IdlePageMatchesRemovals` with an 8-state trace.
- The split guard (guard on) and the Undo-only guard (`PickerGuard = FALSE`) above both violate.

## Keep it in step with the code

`coverage.json` records the commit (`syncCommit`) and a hash of each covered function at the time someone last confirmed that the model describes the code. Exit 2 means a covered function changed since then.

1. Read the diff of each function the check names.
2. If the change alters an atomic step, a guard, or what gets snapshotted or restored, update the matching action in `PageRestore.tla` and rerun.
3. Only after you have confirmed that the model describes the code at the new commit, record it:

```bash
node formal/page-restore/check.mjs --sync
```

Never run `--sync` just to silence exit 2. It refuses (exit 3) while a covered function is missing. When the covered files differ from `HEAD`, it records `syncCommit` as `<short sha>+working-tree`: the hashes describe uncommitted code. Sync again after that code is committed, so `syncCommit` names a commit someone can check out.

## What this does not cover

- One element and one property (`display`). Every `state.undo` and `state.removed` entry restores only its own element's snapshot, so entries for different elements commute and a second element adds states but no new orderings for this property. Other properties `setStyle` writes (`position`, `height`, `overflow-*`) follow the same snapshot rule but are not modelled. Neither is the scroll position.
- X only as an element `prepare` may hide. X as the export root is not modelled: `isolate()` can set the root's `display` to `block`, a third value.
- One picker. Print mode (select element) and remove mode are not distinguished: every picker the model opens can remove X. That over-approximates, since a print-mode pick does not change X's `display`.
- The `loading` window always exists in the model. In the code it exists only with `loadLazy` on, and `captureElement` (the element preview capture) always passes `loadLazy: false`. That over-approximates too.
- `Unhover` can fire at any time, which over-approximates where the pointer can go.
- One tab. Exports on other tabs are independent (`activeJobs` is per tab).
- The preview overlay, Markdown export, and the content of the PDF.
- No bounds, but not every config is finite. `PageRestoreGuarded.cfg` has 16 reachable states, the full set with or without `-continue`. `PageRestore.cfg` stops at its first violation after 28 states. With `-continue` it never finishes: each stale pick during an export appends another entry to `removed`. Measured with `-continue` and a measurement-only constraint `Len(removed) <= k`, it has 68, 111, 154 and 197 states for k = 1 to 4. Once the code is fixed and `PageRestore.cfg` takes `PickerGuard = TRUE`, it is the finite guarded model.
- A pass covers the model, not the code. The hashes only tell you that covered code changed, not that the model still matches it.
