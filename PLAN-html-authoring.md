# HTML as the agent authoring surface

## Why

Agents are excellent at frontend work and bad at bounding-box arithmetic. The
first agent interface (context sidecar + JSON transactions, now committed) asked
them to think in absolute pixels — out of distribution, and it showed: hardcoded
equations, invented coordinates, whole-deck reads before acting.

So: **let the agent edit slides as HTML/CSS.** A real browser lays the markup
out, we bake the geometry it computed into ordinary deck objects. What comes
back is not a blob — it is the same draggable, snappable, Morph-pairable
objects you get by placing them by hand.

The JSON transaction path stays underneath as the commit mechanism; HTML is the
surface.

## The intended workflow

1. The deck's `AGENTS.md` tells the agent to ask for rendered HTML, optionally
   for a subset of slides.
2. The editor's renderer compiles those slides to HTML.
3. The user and agent iterate on that HTML asynchronously, outside the editor.
4. On save, the HTML is baked back into the deck.
5. The merge appears in history as one labelled, revertible entry.
6. Structural edits (insert/delete/reorder) need no separate tool: the exported
   file *is* the document for the range it was exported with.

Decisions taken (2026-08-16):

- **Bake-back trigger: the editor watches the HTML file.** The main process
  already watches `deck.json` and `theme.css`; it will also watch
  `<deck>/edit/*.html`. The agent edits and saves; slides update ~200ms later.
  No CLI call in the everyday loop. `slide-agent apply --html` remains the
  explicit and editor-closed path.
- **Scope: the exported range is synced.** Slides in the file are replaced or
  inserted, slides that were exported but are now missing are deleted, and the
  file's order is applied — all in one transaction, one undo entry.

## What exists and is verified

- `src/shared/htmlSlides.ts` — the pure half: measured facts → deck objects, and
  deck objects → authored HTML. No DOM, fully unit-testable.
- `src/shared/htmlMeasure.ts` — the browser half: the authoring page (deck theme
  + shared `type.css`, *without* the player's absolute-positioning stylesheet)
  and the walk that decides which nodes are content vs. layout and measures
  them. One implementation, used by both browsers below.
- `src/renderer/editor/htmlCompile.ts` — the live path. The editor writes the
  page into an offscreen iframe at canvas size and calls the walk directly, so
  a watched save starts no process at all.
- `scripts/compile-slides.cjs` + `src/cli/compileHtml.ts` — the editor-closed
  path, behind `slide-agent apply --html`. A headless Electron window is handed
  the walk's own source (it has no bundler), which is what keeps the two
  browsers from drifting apart.
- `slide-agent inspect --html [--selected|--slide|--all]` — export.
- `slide-agent apply --html <file>` — bake back through the normal transaction
  path (so: revision-checked, validated, one undo entry, selection preserved).
- `src/renderer/player/type.css` — semantic type rules extracted so the player
  and the compile page share one source; `player.css` `@import`s it.

**Round-trip fidelity is verified.** Export → compile → deck on
`examples/reference` (22 slides, imported from Keynote): **2 diffs**, both `z`
renumbering that preserves relative paint order. Geometry, text, inline styles,
rotations, crops, shapes, curved arrows, builds and backgrounds all survive.

## Bugs found and fixed getting there

Each of these silently corrupted the deck; they are the reason the round-trip
test matters more than any unit test here.

1. **Backtick inside a template literal** in `compile-slides.cjs` — Electron
   threw during load and then sat there, so the CLI hung for five minutes.
   Fixed, plus a hard `COMPILE_TIMEOUT_MS` kill so a wedged child can never
   hang the CLI again.
2. **Missing `<base href>`** on the compile page: deck-relative asset paths did
   not resolve.
3. **Rotation.** `getBoundingClientRect()` is axis-aligned, so a 543×1 rule at
   90° measured 1×543 and came back a different shape. Now: record the angle,
   set `transform: none`, measure the untransformed box (which is what the deck
   stores), restore.
4. **Computed styles baked onto elements.** Every object was acquiring
   `color`, `font-family` etc. from the *computed* style — freezing theme values
   into the deck so later `theme.css` edits would stop working. Now only inline
   declarations are carried.
5. **CSSOM normalisation.** Assigning `node.style.transform` re-serialises the
   whole style attribute, rewriting authored `#000000` as `rgb(0, 0, 0)`. Now
   the raw `style` attribute is snapshotted *before* any mutation.
6. **Shapes and unsupported elements were destroyed** on export (they have no
   markup of their own). They now carry their parameters on data attributes and
   reconstruct exactly.

## Outstanding

- [x] **Regression to fix first:** `test/slideLayouts.test.ts` reads
      `player.css` raw and jsdom does not follow the new `@import './type.css'`,
      so role sizes come back empty. Resolve the import in the test.
- [x] Scope sync: the export carries its ordered slide ids and apply diffs
      against them, so delete and reorder work.
- [x] Editor watches `<deck>/edit/*.html`: the save, the compile and the
      undoable transaction all happen in the editor. The main process only
      reads the file and hands the contents to the renderer, which lays it out
      in an offscreen iframe — no process is spawned in the everyday loop, and
      the geometry is measured by the engine that will draw it.
- [x] A file governs the range it was exported with *plus* whatever it has
      since inserted, so the same file can be saved over and over. Without
      that, the second save of a file that added a slide read as an attempt to
      take over a slide belonging to someone else, and the loop stopped after
      one edit. (Deletion still keys off the recorded scope alone: a slide goes
      because it was exported and then removed, never because it is absent.)
- [x] A toolbar action writes the current selection to `edit/<scope>.html` and
      opens it in the operating system's default application.
- [x] **The exported file is a page, not a fragment.** It was a fragment: no
      doctype (so quirks mode), no canvas box (so every absolutely positioned
      object positioned against the viewport), no theme, and `assets/…`
      resolving one folder too deep. Opening one in a browser showed nothing
      like the slide — which is fatal, because looking at it in a browser is
      the whole loop. It now carries the doctype, the canvas box, `type.css`,
      a `<link>` to the deck's `theme.css` and a `<base href="../">`, and the
      compiler measures *that* document with only the base retargeted and the
      theme link resolved to text.
- [x] **`type.css` travels inside the bundle.** The export button read it from
      `../renderer/player/type.css`, which from `out/main/index.js` means
      `out/renderer/player/type.css` — a path that exists in neither a dev nor
      a packaged build, so every export failed with ENOENT while every test
      passed from source. It is imported as text now (`shared/playerTypeCss.ts`)
      and inlined at build time. Vitest stubs CSS imports to `''`, `?raw`
      included, so `vitest.config.ts` exempts this one file: otherwise the tests
      would agree with each other about a page the app never produces.
- [x] **Every slide of a real talk, exported one at a time.**
      `test/bitterLessonExport.test.ts` imports the 58-slide Bitter Lesson deck
      from `example_presentations/`, writes one file per slide through the
      toolbar's own call, loads all 58 in one browser and demands the whole
      slide back — background, styles, text, timeline, geometry, paint order.
      It found five bugs on its first run, four of them silent:

      1. **Quoted font stacks ended the `style` attribute.**
         `font-family:"Helvetica Neue", sans-serif` written unescaped into
         `style="…"` truncates it at the first quote, so colour, weight and the
         `text-align` appended after it were dropped — every centred line came
         back left-aligned, every text box in the browser's default face. Every
         Keynote import has quoted stacks on nearly every text box, which is
         why the reference deck (theme-driven fonts, no inline stacks) never
         showed it. All style attributes are escaped now.
      2. **Slide background images were never exported at all** — only
         `background.color` was written. This is the one that was reported.
      3. **`max-width: 100%` in the authoring CSS silently resized** anything
         wider than the canvas: a 1992px video bleeding off the slide edge came
         back 1920px. Removed; the slide clips overflow, as the player does.
      4. **The theme's background colour was frozen into the deck.** The walker
         fell back to the *computed* colour, so a title slide with
         `color: null` and a photograph behind it came back opaque white and
         stopped following `theme.css`. Inline only now, as for element styles.
      5. **Two lists of presentational properties had drifted**, and the
         walker's was shorter: it had never heard of `background-clip`, so
         gradient-filled text came back as a solid box over the words. The
         walker now reports every inline declaration and
         `PRESENTATIONAL_STYLE` does the filtering, once.
- [x] **The export must *look* like the slide, and only pixels can say.**
      Deck JSON in, deck JSON out is close to a tautology here: the exporter
      writes `left/top/width/height` and the compiler reads the same numbers
      back, so five rendering bugs round-tripped perfectly while the file in
      the browser was visibly wrong. `test/exportLooksLikeSlide.test.ts` paints
      each slide twice — once with the Player from an export bundle, once by
      opening the authoring file — and counts disagreeing pixels. It started at
      39 of 58 slides differing, mean 13.5%, and found:

      1. **Shapes exported as empty divs.** 610 of this deck's 894 elements are
         shapes; every one was invisible. The drawing now comes from one shared
         `shapeSvg`, which the player parses and the exporter writes.
      2. **Cropped media exported squashed** — the whole frame forced into the
         crop window instead of the player's window-onto-a-larger-picture. The
         export now emits the player's structure, and a wrapper marked
         `data-element="image"`/`"video"` reads back as real media.
      3. **Vertical alignment was ignored**, so every centred caption sat at
         the top of its box.
      4. **Auto-fit never ran**, so titles the player shrinks to two lines
         wrapped onto three and overflowed the slide.
      5. **Empty imported Keynote boxes showed the literal word "Text"**, and
         `pre-wrap`, list and import-gap styling were missing: they lived in
         `player.css`, which the authoring page deliberately does not load.
         They are shared presentation, so they moved to `type.css`.

      Text is now exported as the player's own markup and fitted by the
      player's own function, serialised into the page — approximating either
      one left titles a few pixels off. All 58 slides match at 0.00%, stable
      across repeated runs.
- [x] Tests: pure mapping tests for `htmlSlides.ts`; the walk, the export's
      shape and both compile routes in `test/htmlMeasure.test.ts` (jsdom lays
      nothing out, so that one is about structure, not geometry); the round
      trip for whether the geometry survives a compile; and
      `test/htmlBrowserFidelity.test.ts`, which loads the exported file *by its
      own URL with nothing assembled around it* and demands standards mode, a
      1920×1080 slide, the deck's typography, every asset actually loaded, and
      every element within a pixel of the deck.

      That last one is the test whose absence let the fragment bug through: the
      round trip fed the fragment to the compiler, and the compiler injected
      everything the browser was missing, so the author's page and the measured
      page were never the same document and were never compared. Reverting the
      export to a fragment now fails it five ways.
- [x] Docs: rewrite the deck stub and `AGENTS.md` around "ask for HTML, edit it
      like a web page, save".
- [x] **Import gaps as an agent task.** `unsupported` elements already carry
      `originalType`, note and geometry, and now export as editable HTML — so an
      agent can replace one with real markup and bake it back. Needs surfacing:
      list gaps in `validate`, and document the fix loop.
- [x] **The importer feedback loop** (the point of all this): author beautiful
      HTML slides, import them, diff what broke, improve the importer, repeat.
      First run (2026-08-16): three hand-authored MilliVid slides — dark hero
      with three videos, an editorial serif diagram slide, a dense
      coarse-to-fine slide with builds, rect grids, stats and display maths —
      inserted into the Bitter Lesson deck. Authored page vs player started at
      2.1% / 17.1% / 12.2% differing pixels and ended at 2.1% / 3.7% / 2.6%,
      the remainder glyph antialiasing and video decode noise. Three importer
      bugs found and fixed:

      1. **Nested layout collapsed into one text object.** `isContent` only
         checked whether a node's *direct children* were content, so a row of
         columns of leaves — every child a layout node — read as a leaf itself,
         and a whole diagram was baked as a single text element that reflowed
         arbitrarily in the player. The walk now descends: a block is content
         only if nothing anywhere inside it is, and exported `.element`
         wrappers / `data-element` nodes stay atomic by marker, not by shape.
      2. **Styled layout containers vanished.** A card's background, border
         and radius died with the container that carried them (and an empty
         styled div became an empty text box). Both now become real `rect`
         shape objects — draggable, restylable — with the paint moved onto the
         shape and stripped from the carried inline style, and layout styles
         (padding!) dropped so the drawing fills its measured box. A
         `data-build` on a dissolving container is inherited by its first
         baked child, `withPrev` for the rest.
      3. **Maths measured raw.** The compiler measured `$…$` as literal text —
         a subtitle that wraps onto three unrendered lines was baked three
         lines tall while the player renders two — and the author's browser
         showed raw dollars, which no pixel comparison could call honest.
         KaTeX (library + auto-render + stylesheet with woff2 fonts as data:
         URIs, ~640KB, regenerated by `npm run build:katex` into
         `src/shared/katexInline.ts`) now travels inside the exported page and
         runs the player's own delimiter pass before auto-fit; the measuring
         page injects it into documents that predate it, and the editor's
         script-blocking iframe calls the same pass directly with its bundled
         KaTeX. All three browsers and the player agree.

## Conventions the compiler assumes

- A node is a slide **object** if it is media, or a block with no block children
  (a content-tree leaf). Everything above that is layout: it positions its
  children, contributes geometry, and disappears.
- `data-element="html"` forces verbatim preservation; `data-element="none"`
  excludes a node.
- Builds ride on `data-build="click"` / `data-build="afterPrev+500"`.
- Morph pairing rides on `data-morph="<identity>"`.
- Video trim is `data-trim="start,end"`; crops are `data-crop="x,y,w,h"`.
- Vertical alignment is `data-valign`; auto-fit is `data-autofit`.
- Presentational CSS must be inline or in `theme.css`. A `<style>` block in the
  authored file affects measurement but is not carried into the deck.
