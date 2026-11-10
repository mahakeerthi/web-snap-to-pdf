---------------------------- MODULE PageRestore ----------------------------
(***************************************************************************)
(* The page-mutation protocol of one tab, reduced to the inline `display`  *)
(* of one page element X. Every action names the code it models.           *)
(*                                                                         *)
(* content.js                                                              *)
(*   setStyle      pushes a snapshot of the old value onto state.undo      *)
(*   restore       pops state.undo, putting each snapshot back (LIFO)      *)
(*   pick          remove mode: records X's display in state.removed and   *)
(*                 sets display: none !important. A click picks            *)
(*                 p.current, set by the last hover, with no visibility    *)
(*                 check                                                   *)
(*   undoRemoval   pops state.removed and puts its snapshot back           *)
(*   prepare       stopPicker + restore, then awaits loadLazyContent,      *)
(*                 then isolate() may hide X as a sibling of the root, or  *)
(*                 neutralizeFixed() may hide it as a small fixed element  *)
(*   ps:reset-page stopPicker, closePreview, restore, resetRemovals        *)
(* background.js                                                           *)
(*   claimTab      one export per tab (activeJobs)                         *)
(*   generate /    ps:prepare ... printToPDF / captureScreenshot ...       *)
(*   captureElement  ps:restore in `finally`                               *)
(*   ps:reset-page refused while activeJobs has the tab                    *)
(*   startPicker   no activeJobs check (popup, context menu)               *)
(***************************************************************************)
EXTENDS Sequences, Naturals

CONSTANTS
    Orig,        \* X's own inline display, as the page set it
    None,        \* display: none !important, as setStyle / pick write it
    PickerGuard  \* TRUE models startPicker refusing while an export runs.
                 \* The refusal must be atomic with opening the picker:
                 \* background.js startPicker awaits readyTab, loadSettings
                 \* and uiStrings before sendContent, so an activeJobs check
                 \* at its top is check-then-act and an export can claim the
                 \* tab in between (that split violates the invariant).
                 \* Atomic forms: content.js refuses ps:start-picker while
                 \* prepared (a flag set in prepare, cleared in restore), or
                 \* the activeJobs check sits right before sendContent,
                 \* after the awaits.

ASSUME PickerGuard \in BOOLEAN

VARIABLES
    inline,   \* X.style display value and priority
    undo,     \* state.undo entries for X: the snapshot each one restores
    removed,  \* state.removed entries for X: the snapshot each one restores
    picker,   \* state.picker !== null
    hovered,  \* the picker's p.current === X
    job       \* activeJobs.has(tabId), split by how far the export got

vars == <<inline, undo, removed, picker, hovered, job>>

Values == {Orig, None}
Jobs == {"idle", "claimed", "loading", "printing"}

TypeOK ==
    /\ inline \in Values
    /\ undo \in Seq(Values)
    /\ removed \in Seq(Values)
    /\ picker \in BOOLEAN
    /\ hovered \in BOOLEAN
    /\ job \in Jobs

Init ==
    /\ inline = Orig
    /\ undo = <<>>
    /\ removed = <<>>
    /\ picker = FALSE
    /\ hovered = FALSE
    /\ job = "idle"

\* restore() pops every entry and writes its snapshot, so the last write is
\* the snapshot of the first entry pushed.
Restored == IF undo = <<>> THEN inline ELSE Head(undo)

\* The pointer can only land on X while it is displayed.
Visible == inline # None

-----------------------------------------------------------------------------
(* background.js: export pipeline *)

ClaimTab ==
    /\ job = "idle"
    /\ job' = "claimed"
    /\ UNCHANGED <<inline, undo, removed, picker, hovered>>

\* content.js prepare(), up to `await loadLazyContent()`
PrepareStart ==
    /\ job = "claimed"
    /\ picker' = FALSE
    /\ hovered' = FALSE
    /\ inline' = Restored
    /\ undo' = <<>>
    /\ job' = "loading"
    /\ UNCHANGED removed

\* content.js prepare(), after the await: isolate() hides X when it is a
\* sibling of the root (neutralizeFixed() when X is a small fixed element),
\* or leaves it alone.
PrepareIsolate ==
    /\ job = "loading"
    /\ \/ /\ undo' = Append(undo, inline)
          /\ inline' = None
       \/ UNCHANGED <<inline, undo>>
    /\ job' = "printing"
    /\ UNCHANGED <<removed, picker, hovered>>

\* background.js `finally`: ps:restore, then activeJobs.delete(tabId).
\* Runs after printing, or early when a step before it throws. One step is
\* sound: between the two only picker actions can run, none reads job (a
\* guarded StartPicker is only refused there), so each split order equals
\* this step followed by the same actions.
ExportDone ==
    /\ job \in {"loading", "printing"}
    /\ inline' = Restored
    /\ undo' = <<>>
    /\ job' = "idle"
    /\ UNCHANGED <<removed, picker, hovered>>

-----------------------------------------------------------------------------
(* User actions *)

\* background.js startPicker -> content.js ps:start-picker
StartPicker ==
    /\ ~picker
    /\ PickerGuard => job = "idle"
    /\ picker' = TRUE
    /\ hovered' = FALSE
    /\ UNCHANGED <<inline, undo, removed, job>>

\* Done button or Escape: content.js stopPicker
StopPicker ==
    /\ picker
    /\ picker' = FALSE
    /\ hovered' = FALSE
    /\ UNCHANGED <<inline, undo, removed, job>>

\* mousemove over X (elementAt, setCurrent): p.current = X
Hover ==
    /\ picker
    /\ Visible
    /\ hovered' = TRUE
    /\ UNCHANGED <<inline, undo, removed, picker, job>>

\* mousemove over another element. p.current keeps X when X is hidden
\* under the pointer and nothing else is hovered.
Unhover ==
    /\ hovered' = FALSE
    /\ UNCHANGED <<inline, undo, removed, picker, job>>

\* content.js pick(), remove mode: a click on X, or on anything while
\* p.current is still X
PickRemove ==
    /\ picker
    /\ Visible \/ hovered
    /\ removed' = Append(removed, inline)
    /\ inline' = None
    /\ hovered' = FALSE
    /\ UNCHANGED <<undo, picker, job>>

\* Undo button in the picker bar: content.js undoRemoval -> restoreRemoval
UndoRemoval ==
    /\ picker
    /\ removed # <<>>
    /\ inline' = removed[Len(removed)]
    /\ removed' = SubSeq(removed, 1, Len(removed) - 1)
    /\ UNCHANGED <<undo, picker, hovered, job>>

\* Popup "Restore all" or context menu: background.js ps:reset-page guard,
\* then content.js restore() followed by resetRemovals().
\* The model checks job = "idle" in the same step, though handleMessage
\* awaits between its check and the content message. That overstates
\* atomicity but is safe: PageRestoreGuarded.cfg still passes with the
\* guard removed entirely.
ResetPage ==
    /\ job = "idle"
    /\ picker' = FALSE
    /\ hovered' = FALSE
    /\ inline' = IF removed = <<>> THEN Restored ELSE Head(removed)
    /\ undo' = <<>>
    /\ removed' = <<>>
    /\ UNCHANGED job

Next ==
    \/ ClaimTab \/ PrepareStart \/ PrepareIsolate \/ ExportDone
    \/ StartPicker \/ StopPicker \/ Hover \/ Unhover \/ PickRemove
    \/ UndoRemoval \/ ResetPage

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties *)

\* With no export running, X shows the page's own value unless the user's
\* removal of X is still on record, in which case X is hidden. A violation
\* means X is hidden (or shown) in a way that "Restore all" cannot undo.
IdlePageMatchesRemovals ==
    job = "idle" =>
        /\ undo = <<>>
        /\ inline = IF removed = <<>> THEN Orig ELSE None
=============================================================================
