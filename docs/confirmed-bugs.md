# Confirmed bugs from the seam review

A review of the seams where state crosses a boundary -- editor to DOM, model to
player, local to remote -- produced 29 candidate defects; each was then handed to a
separate reviewer whose job was to refute it. 26 survived, and all but one are fixed.
They are kept here because the repro is the part that is expensive to rediscover.

Alongside these, three defenses were added so the *classes* stay closed:

- `src/renderer/editor/renderInvariants.ts` -- the canvas DOM must match a fresh
  render of the deck. Reported to the console in development, asserted in tests.
- `test/renderInvariants.test.ts` -- one case per editor operation.
- `test/operationFuzz.test.ts` -- random operation sequences over 40 fixed seeds,
  with the invariants checked after every step.

Regressions for the individually-fixed defects live in `test/confirmedBugFixes.test.ts`.

## Editor model/DOM sync

### Slide background change is never applied to the live DOM — fixed

`src/renderer/editor/canvas.ts:296` · severity high

`slide.background` is only ever applied in `renderSlide`; `sameStructure` compares elements only, so a background edit takes the in-place `applyGeometry` path, which syncs the slide root's className but never its background color/image.

**Repro.** With nothing selected, the Layout section's Background colorField (src/renderer/editor/inspector.ts:184) commits a deck where only slides[i].background changed. Canvas.render() takes the sameStructure fast path (canvas.ts:217) since sameStructure (canvas.ts:1978) ignores slide-level fields, and applyGeometry (canvas.ts ~296) syncs only the root className — so the .slide root keeps the inline background the last renderSlide (src/renderer/player/render.ts:35) wrote. The new colour shows only after switching slides or any structural edit forces a rebuild; clearing to "Use theme background" likewise leaves the stale inline background. The rail thumbnail does update (slideRail.ts:267), which makes it look applied.

### Text edit that ends unchanged leaves raw KaTeX/TeX source on screen — fixed

`src/renderer/editor/canvas.ts:1637` · severity high

`beginTextEdit` replaces `.text-content` innerHTML with the authored source (un-rendered `$...$`), but `commitTextEdit` returns early when the html is unchanged, so no re-render restores the KaTeX DOM.

**Repro.** In the plain editor (no collab): a text element whose html contains TeX, e.g. `Energy: $E=mc^2$`, renders as KaTeX. Double-click it (beginTextEdit swaps in the raw source), then blur or press Escape without typing. commitTextEdit hits the unchanged early-return (`if (current.html === html && html === (originalHtml ?? html)) return;` in src/renderer/editor/canvas.ts), no commit fires, no render happens, and the box keeps showing literal `$E=mc^2$` until an unrelated redraw (e.g. leaving and returning to the slide).

### Video Mute / Loop / Autoplay toggles do not reach the live <video> — fixed

`src/renderer/editor/canvas.ts:379` · severity high

`applyGeometry` syncs only `video.controls`; `el.muted`, `el.loop` and the trim-aware loop rule from `renderVideo` are never re-applied, and none of those fields are treated as structural by `sameStructure`, so no rebuild happens either.

**Repro.** Render a slide with a video element (muted:true, loop:false, start:0, end:null) so this.renderedSlide is set. Then flip only element.muted to false via the inspector checkbox (store.updateSelected) — no other field changes. sameStructure() returns true, so canvas.render takes the applyGeometry fast path; the live <video>.muted stays true and 'Play preview' (toggleVideo) plays silently. Same for loop: setting el.loop=true leaves video.loop===false, so the on-canvas preview does not repeat. Switching slides and back forces the full rebuild through renderSlide and the flags then take effect.

### Text colour picked over an imported gradient/clipped-text style has no visible effect — fixed

`src/renderer/editor/canvas.ts:334` · severity medium

`renderBody` writes `el.contentStyle` onto `.text-content` at build time, but `applyGeometry` only mirrors MIRRORED_TEXT_STYLE_PROPERTIES from `el.style`; `contentStyle` changes (and stale `-webkit-text-fill-color` / `background-clip` declarations it left inline) are never removed, and `sameStructure` does not compare contentStyle.

**Repro.** Text element with contentStyle {'background-image': 'linear-gradient(...)', '-webkit-background-clip': 'text', '-webkit-text-fill-color': 'transparent'} (imported HTML gradient text, or the nativeEdits path in test/nativeEdits.test.ts:53-55). Select it and pick a solid colour in the inspector Colour field: setTextPaint strips those keys and sets style.color; canvas.render takes the sameStructure fast path -> applyGeometry -> applyTextRenderState mirrors `color` but leaves the previously set inline `-webkit-text-fill-color: transparent`, `-webkit-background-clip: text`, `background-image` on .text-content, so glyphs stay transparent/gradient until a full rebuild (leaving and re-entering the slide).

### Turning off no-wrap leaves the condense scaleX squeeze on the text — fixed

`src/renderer/editor/canvas.ts:370` · severity medium

When neither `autoFit` nor `noWrap` is set, `applyGeometry` removes only `font-size` from `.text-content`; the `transform: scaleX(...)`/`transform-origin` written by the condense branch of `fitAutoTextElement` is only cleared inside a subsequent autofit pass, which no longer runs.

**Repro.** Render a text element with noWrap: true, noWrapMode: 'condense' whose line overflows, so `fitAutoTextElement` sets `.text-content` style.transform = 'scaleX(0.495)', transformOrigin '0 50%', dataset.fittedScaleX. Then update the same element to noWrap: false, autoFit: false and let the editor take the patch path (canvas.ts applyGeometry -> applyTextRenderState). The else branch removes only font-size: `.text-content` keeps transform 'scaleX(0.495)', transform-origin, and dataset.fittedScaleX, so the re-wrapped text stays horizontally distorted until the slide is rebuilt from scratch.

## Media lifecycle

### Pending media is resolved by element id, so any copy of an uploading element keeps its placeholder forever — fixed

`src/renderer/editor/canvas.ts:1886` · severity high

`importDroppedFile` swaps the `pending:<token>` src only on the element whose id equals the drop id, but `duplicateSelection` (and any copy/paste) clones the pending src onto a new id, so the clone's placeholder is never resolved and its HUD state has already been deleted by `clearPending(drop.id)`.

**Repro.** Drop any media file onto the canvas (importDroppedFile still in flight, element src = `pending:<dropId>:<name>`; the drop auto-selects it), then press Cmd+D (canvas.ts:1035 / shellWiring.ts:107) before the import resolves. store.duplicateSelection clones the element with a fresh id but the same `pending:<dropId>` src. When the import lands, canvas.ts:1886 matches only the original id and rewrites only it; the clone keeps the pending src forever, and clearPending(drop.id) has already removed its HUD state, so it stays a placeholder in the editor, in present mode, in export, and after reload since the dead src is saved into the deck. (No large file needed — any import slow enough to press Cmd+D during reproduces it.)

### Videos playing on the outgoing slide are never paused, so their audio keeps playing after the slide change — fixed

`src/renderer/player/player.ts:164` · severity high

`goTo` calls `this.stage.replaceChildren(rendered)` without pausing the old slide's `<video>` elements; a detached media element keeps playing in Chromium, and only videos still found under the stage are ever paused by `applyState`, so any playing video that is not adopted by the carry loop plays on forever.

**Repro.** Deck with slide A containing an autoplaying video "clip.mp4" and slide B containing no element with src "clip.mp4". Play slide A so the video is actually playing (`!paused && currentTime > 0`), then advance to slide B. goTo puts the element in `carry`, `replaceChildren` detaches it, the adoption loop finds no video on B with src "clip.mp4" to hand it to, and no code path pauses it — audio continues on B and on all later slides, including after toggleBlank, since that only pauses videos still under `this.stage`. The duplicate-count variant is equally reachable: two playing elements of the same clip on A, one slot for it on B — the second queued element is orphaned and keeps playing.

### Video 'carry' matches live elements by src and DOM order, not by element id, so continuity lands on the wrong element — fixed

`src/renderer/player/player.ts:169` · severity medium

The carry queue is keyed by the `src` attribute and consumed in the new slide's DOM (z) order, so when a file appears in more than one element the live playing element is adopted by whichever element paints first rather than by the element it belongs to; `applyState` then pauses the adopter (it is not in `state.playing`) and starts a freshly created element for the element that was actually playing.

**Repro.** Two slides each holding two video elements with the SAME src: a hero (z=2, autoplay) and a thumbnail (z=1, autoplay false), paired across slides. Start playback of the hero on slide 1 (paused=false, currentTime>0) and advance. Because renderSlide emits elements sorted by ascending z, the thumbnail's <video> comes first in querySelectorAll order and shifts the live element off the src-keyed queue; the live element is grafted into the thumbnail wrapper and then paused by applyState, while the hero gets a newly created <video> that plays from 0. Magic Move is not required — the carry block runs on any slide change.

### Magic-move ghosts clone <video> nodes, which paint no frame — the video reads as vanished behind its border for the whole fade — fixed

`src/renderer/player/player.ts:325` · severity medium

Unpaired source elements are animated as `cloneNode(true)` copies taken in `goTo`; a cloned <video> carries no decoded frame and (unless the element has a poster) paints its CSS `background:#000` until it loads, while the cloned `.media-border-overlay` div paints immediately.

**Repro.** Player on a slide whose next slide has magicMoveFromPrevious; slide 1 has a video element (poster null, border optional) that gets no magic-move pair — no shared magicMoveId and offset geometry so neither unchangedMagicMovePairs nor essentialMagicMovePairs match it. Advance: player.ts:158 has already cloned the wrapper, so the ghost appended at :332 contains a fresh <video> with no decoded frame and currentTime 0, and `.element video { background:#000 }` (player.css:48) makes it an opaque black rectangle for the whole 0→25% fade-out, with the cloned border overlay drawn around the black. Even after the clone's own load completes it would show frame 0, not the frame that was on screen. Fix direction: for ghosts, replace cloned <video> bodies with a canvas snapshot of the live element (drawn before replaceChildren) or a static frame image, or at minimum strip the #000 background on ghost videos.

## Magic Move runtime

### Transition z-index puts movers in front of unchanged objects that should cover them — fixed

`src/renderer/player/player.ts:274` · severity high

renderSlide never writes z-index (paint order is DOM order, render.ts:44), but every mover and every fading-in object gets an explicit non-negative z-index for the whole transition, while visually-unchanged objects only get stacking keyframes when hasGhosts is true — so in a transition with no removed elements the animated objects paint above every static element regardless of authored z.

**Repro.** Slide A elements: `bg` (full-bleed rect, z=1), `shape` (small rect at x=0, z=2, magicMoveId 'p'), `card` (large opaque rect covering x=400..1200, z=3). Slide B: same bg and card (unchanged, so they pair via unchangedMagicMovePairs), `shape` moved to x=700 (still z=2, magicMoveId 'p'), magicMoveFromPrevious true. Nothing removed -> hasGhosts stays false. Advance A->B: the mover's only animation is [zIndex "1" x4] (source rank 1, target dom rank 1), while `card` gets no animation and stays z-index:auto; the moving shape therefore travels visibly in front of the opaque card for the full magicMoveDuration and snaps behind it when the fill:'none' animation ends. Fix: run the `unchanged` stacking pass unconditionally (or give every non-participating target its domRank), not only when hasGhosts.

### An object paired to a target that is hidden until a later build step disappears with no fade — fixed

`src/renderer/player/player.ts:264` · severity medium

The mover loop does not check node.style.visibility (unlike the fade-in loop at line 309 and the unchanged loop at line 359), and the source is still added to pairedSources, so no ghost is created — the source object pops out instantly instead of animating or fading.

**Repro.** Slide A has a title; slide B has a title with the same magicMoveId plus a timeline `appear` action on it (hidden at step 0). Navigate A -> B with magic move on: applyStaticSlideState sets B's title visibility:hidden (staticState.ts:25) before runMagicMove; the mover loop at player.ts:264 animates that hidden node with no visibility guard, and the A title being in pairedSources (player.ts:206) makes the ghost loop at player.ts:323 skip it — so A's title vanishes with no fade or motion. The next click reveals B's title with no animation.

### Clicking a distant slide in the rail plays a magic-move between unrelated slides — fixed

`src/renderer/player/player.ts:121` · severity medium

goTo only requires previousSlideIndex !== the new index — there is no adjacency check — so any jump (rail click, goToSlide, or pressing Left) runs the magic-move machinery between the slide you came from and the slide you land on.

**Repro.** Give slide 5 `magicMoveFromPrevious: true` (or give slides 2 and 9 elements sharing a magicMoveId). Then: (a) sit on slide 1 and jump to slide 5 (rail click / goTo command / player.goToSlide(4)) — magicMove is true and runMagicMove(slide1, slide5) plays the 4->5 transition for a 1->5 jump; (b) from slide 5 press Left to slide 4 — magicMoveEnabled reads slide 4's flag, not slide 5's, so the reverse of the 4->5 transition does not animate while 4->5 does.

## Geometry and transforms

### Resize drag ignores element rotation: handles move the box in the wrong direction — fixed

`src/renderer/editor/canvas.ts:1159` · severity high

The resize branch applies the raw canvas-space pointer delta (dx, dy) to the unrotated box edges, while the selection box and its handles are rendered rotated with the element (canvas.ts:786), so on a rotated element every handle grows/shrinks the wrong axis and the box also drifts because CSS rotates about the centre.

**Repro.** Select a non-line element and set rot = 90 (e.g. Cmd-drag a corner handle a quarter turn). The 'e' handle now renders on the visual bottom edge and the 'n' handle on the visual right edge. Drag the handle on the visual right edge (dataset.handle === 'n') to the right by dx: the code computes dy from the pointer's vertical motion only, so rect.h barely changes and rect.y/h shift by the small vertical jitter while nothing follows the cursor horizontally. Symmetrically, dragging the visual bottom handle ('e') downward does nothing because only dx feeds rect.w. Concretely, with origin {x:100,y:100,w:400,h:100,rot:90} and a pure +100px horizontal drag on handle 'e', the element becomes w:500 — which after the centre rotation renders as growing 100px vertically and shifting the box 50px away from the pointer, instead of widening toward it.

### Snapping runs after the aspect-ratio constraint, so shift/keep-aspect resizes silently distort — fixed

`src/renderer/editor/canvas.ts:1204` · severity high

constrainAspect is applied to the rect and then snapResize adjusts a single edge of that rect without re-imposing the ratio, so the committed w/h no longer match drag.aspect.

**Repro.** Corner (or single-axis) resize where exactly one of the two dimensions gets snapped. Concretely, in the non-alt branch of the 'resize' case in canvas.ts: select an image with fit != 'fill' and no sourceBox (or hold Shift on any element), drag the SE handle so the right edge lands within `threshold` of another element's / the canvas's x-target while the bottom edge is NOT near any y-target. constrainAspect makes h = w/aspect, then snapResize overwrites w with `hit.at - out.x` and leaves h alone, so the element commits with w/h != drag.aspect (off by up to `threshold` on the width). The mirror case is a snapped bottom edge with an unsnapped right edge. Only the Option/alt path is unaffected, since line 1149 skips snapResize entirely when ev.altKey is set.

### Magic Move start transform folds the anchor without the source rotation, so rotated text pairs fly in — fixed

`src/renderer/player/magicMoveTransform.ts:145` · severity medium

foldAnchor computes d = (A_s - A) + (1-S)(A - C), which is only exact when the source transform R is the identity; the transform list is translate(d) R scale(S) about C, mapping p to C + d + R*S*(p-C), so the residual error is (I-R)[S*(A_t-C_t) - (A_s-C_s)] — nonzero for any rotated source whose ink sits differently inside its box than the target's does (the module header's claim of rotation-independence holds only for the centre anchors used by non-text pairs).

**Repro.** Pure-function repro (no DOM needed): from = text{x:200,y:300,w:400,h:160,rot:30,align:'left',valign:'top'}, to = same but w:200; measured ink identical on both sides (text did not move): {x:200,y:318,w:180,h:74}, fontScale 1, squeeze 1. magicMoveTransforms returns start = "translate(0px, 0px) rotate(30deg) scale(1, 1)"; applying it about center(to) puts the target ink's top-left at (244.40, 276.31) while the source painted it at (257.79, 226.31) — 51.8 slide px of drift (a visible jump/slide-in). With rot:90 and w 400 -> 100 the drift is 212 px. Fix: rotate the fold, e.g. d = C_f + R(A_s - C_f) - C_t - R·S·(A_t - C_t), which reduces to the current formula when R = I.

### Snap targets and guides are built from unrotated boxes, so guides do not match rotated elements on screen — fixed

`src/renderer/editor/canvas.ts:1125` · severity medium

Both the move and resize paths pass {x,y,w,h} of the other elements (and the moving union rect) to snapTargets, ignoring el.rot, even though rotatedBounds() already exists and is used for marquee selection.

**Repro.** Place shape A at x=100,y=100,w=200,h=200 and set ROT=45 in the inspector; its rendered axis-aligned left edge is at x = 100 + (200 - 200*sqrt(2))/2 ≈ 58.6. Drag shape B (rot=0) so its left edge comes within the snap threshold of x=100. snapMove receives A as {x:100,y:100,w:200,h:200}, so B locks its left edge to x=100 and a guide is drawn at 100 — about 41 canvas px inside A's visible left edge, leaving the two shapes visibly unaligned along the guide. Same defect on the resize path via snapResize (canvas.ts:1146-1151).

## Collaboration and history

### Remote structural edit while typing rebuilds the canvas from the pre-commit slide, so the text you just typed disappears — fixed

`src/renderer/editor/canvas.ts:231` · severity high

render() sets this.renderedSlide = slide and then calls commitTextEdit(), which re-enters the store (commit -> emit -> render) and advances state.deck; when the nested call unwinds, the outer render continues and does slideLayer.replaceChildren(renderSlide(slide, ...)) using the now-stale local `slide` variable, wiping the just-committed text from the DOM while renderedSlide points at the new slide object, so no later render repaints it.

**Repro.** Local user is editing a text box (editingId set, uncommitted markup in the contenteditable). Any store change that makes sameStructure(renderedSlide, newSlide, true) false for the current slide — a remote collaborator adding/removing an element on that slide, or a class change — triggers render()'s full-rebuild branch: renderedSlide is set to the new slide, commitTextEdit() re-enters the store and a nested render() runs to completion, then the outer render calls slideLayer.replaceChildren(renderSlide(slide)) with the pre-commit `slide`. Result: the just-typed text is gone from the canvas while the store/server hold it, and because renderedSlide === the post-commit slide object, later renders short-circuit at canvas.ts:205 until the user navigates away and back. Minimal unit-level repro: begin a text edit, type into the .text-content node, then dispatch a store mutation that adds an element to the same slide, and assert the rendered text node still shows the typed html.

### A transient WebSocket reconnect wipes the entire History panel and element selection — fixed

`src/renderer/collab/main.ts:184` · severity high

On every reconnect the bridge re-sends hello and the server replies with a full `welcome`; onWelcome calls store.load(welcome.deck, ...) which unconditionally resets historyLog to `opts.history ?? []` (store.ts:128), clears both undo stacks and resets `selection` to an empty set — so a network blip destroys all restorable revisions even though the document itself is unchanged.

**Repro.** In a collab session, make at least one edit so History lists a revision and select an element on the current slide. Cause the WebSocket to close without an 'ended' message (kill/restart the collab server or drop the network). The bridge reconnects, sends hello, receives a second 'welcome', and main.ts:184 calls store.load(...) → historyLog reset to [], store undo/redo cleared, and state.selection reset to empty; slideIndex alone survives via keepView.

### Reconnect discards unconfirmed transactions but keeps the undo stack, so Cmd-Z replays inverses against a base the server never saw — fixed

`src/renderer/collab/collabBridge.ts:217` · severity medium

The `welcome` branch sets `this.pending = []` ("a reconnect abandons unconfirmed work: the server state wins") but, unlike the `deck`/resync branch at lines 256-261 which clears undoStack/redoStack for exactly this reason, it leaves both history stacks intact. Inverse ops computed against the discarded optimistic base then apply to the new server base as ordinary transactions.

**Repro.** Single client suffices for the core defect (the second user only makes the damage visible). Confirmed by reading code: (1) client is connected, shadow at seq N; (2) local edit calls `localEdit` (line 116) which pushes an UndoEntry onto `undoStack` and pushes the txn onto `pending`, then `send` — the socket drops before the server applies it, and `send` (202-206) silently no-ops for anything sent after readyState leaves OPEN; (3) the 'close' handler reconnects the same instance, the server replies `welcome`, and line 217 clears `pending` while `undoStack` keeps the entry for the never-applied edit; (4) Cmd-Z → `bridge.undo(store.get().deck)` pops that entry and `applyHistoryOps` applies its `inverse` (e.g. `replaceElement` restoring the pre-drag geometry) to the current server deck and broadcasts it as a fresh txn — an undo of an edit that was never applied, which overwrites whatever the element looks like now (including a concurrent peer's move) on every client. Fix is one line-pair: clear `undoStack`/`redoStack` in the `welcome` branch, matching lines 259-260.

### setSlideProperties carries the whole non-element slide blob, so a notes/layout edit silently deletes a peer's concurrent build animation (and vice versa) — fixed

`src/shared/collabApply.ts:131` · severity medium

diffDecks emits `setSlideProperties` with every non-element slide field — including `timeline`, `notes`, `comments`, `skipped` (deckDiff.ts:120) — and the lenient apply replaces the live slide wholesale, preserving only `elements`: `deck.slides[at] = { ...structuredClone(op.slide), elements: deck.slides[at].elements }`. The deliberate carve-out for elements has no counterpart for timeline/notes/comments, so last-writer-wins on the blob drops a concurrent edit to any of those fields.

**Repro.** A and B both on slide s3 at the same seq. Within one server round-trip (before either txn is echoed): B adds a timeline build for an element on s3, sending setSlideProperties{slide:{...s3props, timeline:[build]}}; A types speaker notes, sending setSlideProperties{slide:{...s3props, notes:'…', timeline:[]}} computed from A's pre-build copy. Server orders B then A; the setSlideProperties branch overwrites the slide blob wholesale (elements alone preserved), so B's build disappears on the server and on every client, including B's Timeline panel, with nothing reported in LenientApplyResult.skipped. Reversed order loses A's notes. Same applies to comments/skipped and any other non-element slide field.

## Divergence between render paths

### Web export opens on a hidden slide; Present and PDF exclude it — fixed

`src/renderer/player/player.ts:71` · severity high

The Player always boots at {slide:0} with no `skipped` check, so a standalone web export opens on a hidden slide, while the Present window explicitly walks to the nearest non-skipped slide (src/renderer/present/main.ts:73-83) and the PDF exporter drops skipped slides entirely (src/renderer/print/pages.ts:51).

**Repro.** Requires the FIRST slide (index 0) to be hidden, since Player only ever auto-lands on slide 0: mark deck.slides[0].skipped = true, File > Export web deck, open index.html with no hash. The Player renders the hidden slide 0; pressing Right calls nextCursor which lands on slide 1, and slide 0 is unreachable afterwards (prevCursor also skips it). A hidden slide at any other index is not affected by this path, and an explicit `index.html#1` deep link reproduces it too.

### Video Mute/Loop toggles never reach the editor canvas's live <video> — fixed

`src/renderer/editor/canvas.ts:318` · severity medium

The non-structural patch path syncs only `video.controls`; `el.muted` and `el.loop` (both of which renderVideo sets, including the trim-aware `loop && start<=0 && end===null` rule) are never re-applied, and sameStructure() treats these flag changes as non-structural so no rebuild happens.

**Repro.** In the editor, select a video element with muted=true and toggle 'Mute' off in the inspector. The store deep-clones the slide, render() sees sameStructure()==true (muted is not compared), so applyGeometry runs and syncs only video.controls — the live <video> node keeps muted=true, so the canvas preview stays silent while Present/exported HTML plays with sound. No playback needs to be in progress; the DOM flag is simply never updated. Same for 'Loop' (DOM keeps the old native loop). Additional confirmed variant: setting a trim in-point (start>0) or out-point does not clear the native video.loop attribute on the canvas node, so a previously looping clip keeps restarting at 0 in the editor instead of following the trim.

### Web export silently drops any asset not directly inside <deck>/assets — fixed

`src/main/exportDeck.ts:93` · severity medium

copyAssets flattens each referenced path with `rel.split('/').pop()` and only looks it up in a non-recursive readdir of `<deck>/assets`, so `assets/figures/plot.png` or `figures/plot.png` is skipped without error even though the editor/present/print paths load any deck-relative path through assetUrl (src/main/assetProtocol.ts:119).

**Repro.** Deck with assets/figures/plot.png on disk and an image element whose src is "assets/figures/plot.png". referencedAssets yields "assets/figures/plot.png"; copyAssets computes name="plot.png"; readdir(<deck>/assets) returns ["figures"], so available.has("plot.png") is false and the file is never copied — no assets/figures directory is created, no error is raised, and the exported index.html requests assets/figures/plot.png (standalone.ts resolveSrc is identity), yielding a broken image. Same for a non-assets-prefixed src like "figures/plot.png" (also collected by referencedAssets from el.src) and for slide.background.image.

### object-position edits do not repaint on the editor canvas patch path — fixed

`src/renderer/editor/canvas.ts:329` · severity medium

renderBody puts `el.style['object-position']` on the inner <img>/<video>, but the patch path only re-applies `objectFit` to the inner media and writes the rest of el.style onto the absolutely-positioned wrapper, where object-position has no effect and does not inherit.

**Repro.** Editor canvas with an uncropped image element already rendered (sourceBox null, fit 'cover'). Apply a style-only edit setting style.object-position to 'top left' (e.g. agent nativeEdits set {'style.object-position': 'top left'}). sameStructure returns true, so applyGeometry patches in place: the wrapper div gets object-position: top left (no effect on a div), while the inner <img> keeps its original object-position. The canvas framing is unchanged; present/PDF/web-export paths call renderElement and show the re-framed image. Switching slides forces a rebuild and the canvas then agrees. Same for video via renderVideo (render.ts:649). Reverse case: an element that already has style.object-position and then has it unset keeps the stale value on the inner media, since applyElementBoxStyles' cleanup loop only removes keys from the wrapper.

### Relative asset URLs inside a non-sandboxed html element are never resolved — fixed

`src/renderer/player/render.ts:541` · severity medium

For an html element without `sandboxed`, renderBody does a bare `div.innerHTML = el.html` with no src/poster rewriting and no CSS url() rewriting — the sandboxed branch above does both — so relative asset references resolve against the host page instead of the deck.

**Repro.** renderElement({type:'html', html:'<img src="assets/logo.png">'} /* sandboxed unset */, { resolveSrc: s => `/decks/test/${s}` }) leaves the img src as 'assets/logo.png' instead of '/decks/test/assets/logo.png' (render.ts 'html' case, else branch). In-app: such an element (agent-authored, hand-edited deck JSON, or a legacy pre-sandbox deck) shows a broken image in canvas, Present and PDF while the standalone web export renders it; el.css url() references are dropped entirely in that branch.

### A PDF used as an image element is blank in the exported PDF — partially fixed

`src/renderer/player/render.ts:476` · severity low

An image element whose src ends in .pdf is rendered as an <embed type="application/pdf">, which the print paths hand to Chromium printToPDF / window.print(); plugin-rendered content is not painted into printed output, and print/readiness.ts waits only on <img> and <video>, never on <embed>.

**Repro.** In the browser collab client (Chrome), add an image element whose src ends in .pdf (rendered as <embed type="application/pdf"> at src/renderer/player/render.ts:475). It displays on the slide; opening the print tab (src/renderer/collab/print.ts -> window.print()) produces a page with that region blank, since buildPrintPages reuses the same embed and waitForPdfPage (src/renderer/print/readiness.ts) settles only img/video. Same code path for Electron Export to PDF (createPdfWindow + printToPDF, src/main/index.ts:1097).

**Still open.** The readiness gap is closed (the print path now waits on
`<embed>`), but a PDF used as an image still cannot paint into printed
output: Chromium does not print plugin-rendered content, and rasterising the
page ourselves would mean taking on a PDF rendering dependency. That is a
deliberate choice to make rather than something to slip in with a bug fix.

