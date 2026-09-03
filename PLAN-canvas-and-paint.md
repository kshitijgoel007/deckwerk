# Boards (pageless canvas) and the Paint tool

Draft, 2026-09-03. Open decisions are marked **[decide]**; everything else is a
recommendation grounded in the current code.

## Why

Two gaps, both about thinking rather than presenting:

- **Brainstorming has no home.** A slide is a 1920×1080 commitment. Sketching a
  story, clustering ideas, or arranging fragments before they are slides wants
  an unbounded surface with pan and zoom, closer to Docs' pageless view or an
  Illustrator artboard than to a deck.
- **Collaboration has no gesture.** Peers can select, move and type, but they
  cannot point at something by circling it. A pen that everyone can pick up,
  each in their own colour, is the cheapest way to make a shared session feel
  live.

Both should reuse the element model, inspector, themes, history, collab
transactions and the agent HTML loop rather than adding a parallel system.

---

## Part 1 — Paint

### What the user sees

- A **Paint** button in the centre bar group, after Text, Shape and Table, in
  both toolbars (`src/renderer/collab/main.ts` builds the collab bar with
  `barIconButton`; the desktop editor has the equivalent in `main.ts` /
  `designWorkspace.ts`). Shortcut `P`. Unlike the insert buttons it is a
  *modal* tool: it stays on until `Esc`, `V`, or clicking it again.
- While active the cursor is a pen dot in the current ink colour, and a small
  popover under the button offers: colour swatches, three widths, an eraser.
- Dragging on the slide draws a live stroke. Releasing commits it as one
  undoable step. Strokes are ordinary objects afterwards: select, move,
  delete, appear in thumbnails, PDF and web export, and in the player.
- Eraser: click or drag over strokes to delete them (whole-stroke erase, not
  pixel erase).
- Context menu on a slide gains **Clear ink on this slide**.

### Colour

- **In collaboration** each peer's pen defaults to their presence colour, and
  presence colours become theme-derived. Today `pickColor` in
  `collabServer.ts` picks the least-used entry of a hardcoded ten-colour
  `PALETTE`. Change it to draw from `deck.themeStyle.palette` first: palette
  rows are `[ink, muted, accent×4, surface, background]`, so use indices 2–5,
  then fall back to the hardcoded list once those are taken. Skip any entry
  with insufficient contrast against `themeStyle.colors.background`
  (`themeMode` in `shared/themes.ts` already classifies light/dark grounds).
  Re-pick when the deck theme changes so pens track the theme.
- **Solo** the pen defaults to the theme accent.
- Overriding the colour is a local, per-session preference, not a deck field.

### Data model

No new element type. A stroke is a `shape` element with `shape: 'path'`,
`fill: null`, `stroke: <colour>`, `strokeWidth`, `path` and `pathSize` set to
the stroke's own bounding box, and one marker so ink can be told apart from
imported vector art:

```ts
// ShapeElement, optional
ink: z.object({
  author: z.string().default(''),   // presence name, for tooltips and per-author clear
  smoothing: z.enum(['none', 'smooth']).default('smooth'),
}).optional(),
```

Also add `class: ['ink']` so theme.css and the agent can address strokes
without knowing the field. Everything else — z-order, opacity, comments,
Morph pairing, collab LWW — comes free from `BaseElement`.

`shapeSvg.ts` already renders `path` in every surface (editor, thumbnails,
player, export), so nothing downstream needs to change to *display* ink.

### Editor mechanics (`canvas.ts`)

- Add a `tool: 'select' | 'paint' | 'erase'` field to `EditorStore` state
  (there is no tool state today; the insert buttons are one-shot). The canvas
  reads it in `onPointerDown` before hit-testing and routes to a new drag kind
  `{ kind: 'ink', points: {x,y,p}[] }`.
- During the drag, append pointer samples (canvas space via `toCanvas`, plus
  `pressure` when the device reports it) and redraw a temporary `<svg>` in the
  overlay layer. Nothing is committed and nothing goes over the wire until
  pointer-up, so a stroke costs the collab server one transaction, not one per
  sample.
- On pointer-up: drop samples closer than ~1.5 canvas px, simplify with
  Ramer–Douglas–Peucker (tolerance ~1 px), convert to a smooth path (Catmull–
  Rom → cubic Béziers), compute the bounding box padded by half the stroke
  width, translate the path into that box, and `store.commit` one element with
  label "Draw". Very short strokes (a tap) become a dot: a tiny closed path so
  a click still leaves a mark.
- Pressure: with pointer pressure available, vary width by ±40 % using a
  filled variable-width outline instead of a stroked centreline. Without
  pressure, a stroked centreline. Both are just path data.
- Eraser: hit-test by distance to the stroke geometry, not bounding box. Add a
  `strokeDistance(el, point)` helper next to `hitTest` and reuse it in select
  mode too: today a thin diagonal stroke's bounding box would swallow clicks
  meant for whatever sits behind it. This is the one place ink changes
  existing selection behaviour, and it is an improvement for imported paths
  as well.
- Snapping, alignment guides and the Command-rotate modifier are suppressed
  while the paint tool is active.

### Collaboration

- Phase 1: peers see a stroke when it lands. A one-second stroke appearing all
  at once is acceptable and is how Figma comments and Keynote's live
  collaboration behave.
- Phase 2 (optional): a `strokePreview` message in the presence class (same
  tier as `cursor`, never persisted, coalesced per animation frame) so peers
  watch the line grow. The `PresenceOverlay` already draws remote cursors in
  slide space, so it is the natural host.

### Presenting

Strokes are content and show in the player. If a session wants ink that does
*not* present, that is the per-author Clear command, not a hidden layer.
**[decide]** Confirm ink is persistent content (recommended) rather than an
ephemeral annotation layer. Ephemeral ink would need its own storage, would
not undo, and would not survive the agent's HTML round-trip.

### Tests

- `test/paintTool.test.ts` — unit: sample simplification, path fitting,
  bounding-box translation, dot from a tap, `strokeDistance`.
- `test/paintToolBrowser.test.ts` — real pointer path (the repo's rule: no
  synthetic events for input): draw, expect one element and one undo step;
  erase; Esc returns to select.
- `test/collabServer.test.ts` — extend: colours come from the deck palette,
  contrast filter, fallback after the palette is exhausted, re-pick on theme
  change.
- `test/collabBrowserSmoke.test.ts` — extend: two peers draw, both strokes
  present on both clients with the drawer's colour.

---

## Part 2 — Boards (pageless canvas)

### The core question: is this a mode of a deck, or a different document?

Recommendation: **a different document kind that shares the format.** Call it
a *Board*. Reasons:

- A deck's invariants are all about the fixed canvas: `deck.canvas` drives the
  stage fit in `canvas.ts`, the player's stage transform in `render.ts`,
  thumbnail aspect in `slideRail.ts`, layout masters, Morph, PDF export. A
  live toggle would have to keep two incompatible sets of invariants
  simultaneously true for the same objects.
- "Convert back and forth" is only meaningful if the board knows which parts
  are slides. It does not, unless you tell it. That is what frames are for.

So instead of a two-way conversion the plan is **frames plus one-way
derivations**:

1. A board is an unbounded surface. You put anything on it anywhere.
2. A **Frame** is an object on the board the size of a slide. Draw frames
   around the clusters that are becoming slides. Order them (a frames list
   replaces the slide rail).
3. **Present** or **Export as deck** treats each frame as a slide: the
   elements whose centre lies inside the frame become that slide's elements,
   translated into slide coordinates. Elements outside every frame are simply
   not presented. This produces a real deck folder you can open, edit and
   share; it is a derivation, not a link.
4. **Open deck as board** goes the other way: lays the deck's slides out as
   frames on a fresh board, one per slide, in a row (or grid), keeping every
   element. Also a derivation.

This gives the Docs/Illustrator feel for brainstorming and a clean, honest
path from sketch to talk, without pretending the two are the same file.
**[decide]** Board as a separate document with frames (recommended), versus a
pure infinite canvas with no frames and no path to slides, versus a mode
toggle on the existing deck.

### Data model

Minimal additions to `DeckSchema` / `ElementSchema`:

```ts
// DeckSchema
kind: z.enum(['deck', 'board']).default('deck'),

// New element
const FrameElement = BaseElement.extend({
  type: z.literal('frame'),
  name: z.string().default(''),
  /** Order used when presenting or exporting frames as slides. */
  order: z.number().int().default(0),
});
```

A board has exactly one slide (its `elements` are the board) and
`canvas` keeps meaning "the frame size", which is also what new frames
default to. Everything else in the schema stays valid, so `deck.json`
validation, history, diff/digest, collab and the agent CLI need no format
fork. Frames do not parent elements; membership is geometric, computed at
derivation time. That keeps brainstorming loose (drag a note out of a frame
and it just leaves) and avoids a nesting model the rest of the editor does
not have.

### Editor changes

- **Stage.** `rescale()` currently centres a `canvas.w × canvas.h` stage and
  computes `fitted` from it. In board mode there is no fit: zoom is free,
  pan is unbounded, the stage is a transform origin only. Elements can have
  negative coordinates; CSS handles this already since the stage has
  `overflow: visible`. Add **Zoom to fit** (bounding box of all elements) and
  **Zoom to selection**; both are small given `toCanvas` and `pan` exist.
- **Ground.** Theme background colour behind everything, optional dot grid
  that fades out at low zoom. Frames draw as a white (or theme surface)
  rectangle with a name label above, like Figma.
- **Snapping.** Canvas-edge and canvas-centre guides go away; frame edges and
  centres become snap targets. Element-to-element snapping is unchanged.
- **Rail.** In board mode the slide rail shows the frames in `order`, with
  the same drag-to-reorder it has for slides, and a thumbnail rendered from
  the frame's region. Clicking a frame zooms to it.
- **Panels.** Hide Timeline, Morph and Layouts for boards. Theme applies as
  usual. Inspector gains a Frame section (name).
- **Present.** Runs the frame derivation into an in-memory deck and hands it
  to the existing player. Disabled with an explanatory tooltip when there are
  no frames.
- **New document.** Welcome screen and File menu get **New Board**; the deck
  picker in collab lists boards with a distinct badge.

### Agent and HTML loop

`slide-agent context` and `inspect --html` work per frame in board mode,
with the frame acting as the slide. A frame's export is the same 1920×1080
page the agent already knows how to edit, so no new authoring surface is
needed. Elements outside frames appear in `context` as "loose" items so the
agent can be asked to sort them into frames.

### Collaboration

Boards go through the same room, transaction and presence machinery. The
only presence change is that cursors can be anywhere in board space;
`CursorPositionSchema` already carries slide-space x/y, so nothing changes on
the wire. Paint on a board is the same tool as Paint on a slide.

### What stays out of scope

Element parenting inside frames; nested frames; auto-layout; comments
anchored to board regions; converting a board into a deck *in place*.

### Tests

- `test/boardDerivation.test.ts` — unit: frames→slides (membership by centre,
  translation, order, loose elements ignored), slides→board (layout, ids
  preserved), round trip on a deck with no loose elements is the identity.
- `test/boardCanvasBrowser.test.ts` — pan/zoom without a fit, negative
  coordinates render, zoom-to-fit, frame snap.
- `test/boardRail.test.ts` — frames list order and reorder.
- Extend `test/deckStore.test.ts` for `kind: 'board'` load/save and the
  `kind` default on legacy files.

---

## Phasing

| Phase | Scope | Value on its own |
|------|-------|------------------|
| 0 | `tool` state in the store, modal-tool plumbing, `Esc`/`V`, `strokeDistance` hit-testing for path shapes | Better path selection today |
| 1 | Paint tool, ink schema marker, theme-derived peer colours, eraser, Clear ink | Live collaboration gesture |
| 2 | Board document kind, unbounded stage, ground, zoom-to-fit, New Board, hidden panels | Brainstorming surface |
| 3 | Frame element, frames rail, frame snapping, Present and Export-as-deck derivations, Open-deck-as-board | Sketch-to-talk path |
| 4 | Live stroke preview over presence, pressure-width outlines | Polish |

Phase 1 ships independently and is the smaller of the two. Phase 2 is
mostly `canvas.ts` and chrome; Phase 3 is where the design risk sits, so
the frame derivation should be written first as pure functions with tests
before any UI.

## Open decisions

1. **[decide]** Board as a separate document kind with frames, pure infinite
   canvas, or mode toggle on decks. Recommendation: separate kind with frames.
2. **[decide]** Ink is persistent content (recommended) vs an ephemeral layer
   hidden when presenting.
3. **[decide]** Frames in the first board release (phase 3 folded into 2), or
   ship the bare canvas first. Recommendation: bare canvas first; frames
   change the rail and Present and deserve their own review.
4. **[decide]** Live stroke preview in the first paint release. Recommendation:
   no; commit-on-release is fine and keeps the server quiet.
