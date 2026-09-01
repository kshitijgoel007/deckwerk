# Working on a deck as an agent

## Repository test environment

When working in the slide-editor repository, run only the targeted tests that
cover your change unless the user or task explicitly asks for broader coverage.
Focused pure unit tests can run inside the sandbox with
`npx vitest run test/<name>.test.ts`. If a complete `npm test` run is explicitly
required, run it outside restricted agent sandboxes: the integration suite binds
localhost and launches real Electron/Chromium, ffmpeg, importer, semaphore, and
filesystem-watcher processes. Sandbox failures otherwise surface as misleading
`EPERM`, timeouts, `EMFILE`, or null child-process exits; `npm test` has a
fail-fast preflight for the localhost restriction.

## UI consistency

Every new UI element must match the rest of the application. Reuse the shared
chrome and established component styles for all controls, including buttons,
dropdowns, text fields, text areas, toggles, and color pickers. Do not ship a
browser-native default or a one-off visual treatment; check the control's
normal, hover, focus, disabled, and open states against neighboring UI before
considering the work complete.

## Long-running operation feedback

Any user-initiated operation that can take longer than roughly 500 ms must
provide visible activity feedback. Keep fast operations quiet by delaying the
indicator for 500 ms; if work is still running, use the shared status/progress
chrome rather than inventing a one-off loader. Open, create, import, export,
Save As, media processing, rendering, and similar filesystem or subprocess
work all fall under this rule. Prefer specific, changing phase text that names
the file or resource currently being read, written, copied, rendered, uploaded,
or converted. Report determinate progress when totals are known, otherwise show
an indeterminate indicator. Clear the busy state on success, cancellation, and
failure, and leave a useful completion or error message where appropriate.

An agent never talks to the Electron app directly, and should almost never
touch `deck.json`. **You edit an HTML file; the editor watches it and syncs
what you saved into the presentation.**

## The loop

```bash
slide-agent context                                    # 1. the outline
slide-agent inspect --html --selected > edit/work.html # 2. export a range
#                                                        3. edit and save it
```

That is the whole thing. There is no fourth step: with the editor open, saving
`edit/work.html` updates exactly those slides about 200 ms later, as one named,
undoable change. Keep editing and keep saving.

**1. `context` — the map.** Every slide in order with its id and its title, the
text roles this deck actually uses, and whether the editor is live. This is how
you find "the middle of the talk" without reading the talk.

### Resolve the visual direction before creating slides

Treat the existing deck as the default style brief. When it has a coherent visual
language, match its typography, palette, spacing, density, composition, imagery,
diagram treatment, and overall level of ornament unless the user asks for a
restyle. New slides should feel native to the deck, not like a separate template
or a sales pitch. "Professional" does not mean elaborate: do not add decorative
cards, gradients, badges, oversized marketing copy, or other visual flourish just
to make a slide look designed.

Before creating slides, make sure the intended style is actually constrained by
either the user's request or clear examples in the existing deck. If it is, proceed
without asking and follow that direction. If it is not — for example, the deck is
blank, visually inconsistent, or too sparse to establish a precedent — ask the
user one brief question about the desired style before authoring. Offer a small
number of concrete directions when helpful, including a basic or understated
option. Do not silently choose a more elaborate aesthetic.

**2. `inspect --html` — the export.** A complete web page: **open it in a
browser and it is the slide**, at its true 1920×1080, with the deck's own
`theme.css` and its real assets. Use that. Reload to see a change, save to put
it in the deck. It is the same document the editor measures, so what the
browser shows you is what the deck gets — that is checked, slide by slide,
against the projector's own renderer.

**3. Edit it as a web page.** Flexbox, grid, semantic HTML; the browser
computes the geometry and the editor bakes it into ordinary draggable objects.
Add, delete and reorder `<section>`s and the deck gains, loses and reorders
those slides — the file *is* the document for the range it was exported with.
Slides outside that range are never touched.

Two rules about the file itself:

- **Keep it in `edit/`.** Its `<base href="../">` is what makes
  `assets/figure.png` and `theme.css` resolve; move it and the page stops
  looking like the slide.
- **Save it as often as you like.** After every successful sync the file is
  rewritten in place: each new `<section>` gets the `data-slide-id` the compile
  assigned, and the scope marker is updated to what the file now governs. That
  is what makes the loop idempotent — saving or applying the same file again
  replaces those slides rather than inserting them a second time — and it means
  dropping a section (its id now recorded) deletes that slide on the next save.
  Re-read the file after a sync rather than editing a stale copy of it.

If `apply` times out, **do not apply again**: the editor may still land the
change. Check `slide-agent context` for the outline first — the id write-back
makes an accidental double-apply harmless only once the file has been stamped.

**Appending needs no export.** A new file in `edit/` holding only new
`<section class="slide">`s (no `data-slide-id`) appends at the end of the deck
— on save, or via `apply` (`--after <slideId>` to place it elsewhere). Export a
range only to change it; exporting a slide purely as an "anchor" risks the
slide for nothing.

`slide-agent validate` also reports `overflows`: every element whose authored
box extends past the canvas, from geometry alone. Deliberate bleeds show up
there too — the list is a checklist, not an error. Scope it to the slides you
are actually editing with `--slide <id>` (repeatable, or comma-separated) or
`--selected`; structural `errors` stay deck-wide either way.

**Write semantic markup; put reusable classes in `theme.css`.** The walk bakes
layout from any CSS, keeps a dissolving container's paint (background, border,
radius) wherever it was styled, keeps a `<ul>`/`<ol>` as one list object, and
preserves a container that mixes prose with blocks verbatim rather than losing
the prose. What it cannot do is carry a file-local `<style>` block into the
deck: text colour and fonts from such classes affect only the preview, so
define them in `theme.css`, which the deck actually loads.

**Edit style attributes as attributes, not as text.** The export entity-escapes
quotes inside `style="…"` — a font stack reads
`font-family:&quot;Avenir&quot;, sans-serif`. A regex that scans for `;` will
stop inside `&quot;` and leave a truncated declaration behind, and the failure
is silent and worse than it looks: the browser's CSS parser treats the dangling
quote as an unterminated string and swallows every declaration after it
(`text-align`, `color`, …), so the compile quietly bakes defaults for
properties you never meant to touch. Parse the file with a real HTML parser, or
at minimum treat `&quot;`/`&#39;` as atoms in any pattern that edits a style
attribute. Deck-wide restyles rarely need this at all: delete the inline
declaration entirely and put the replacement in `theme.css`.

With the editor **closed** there is no watcher, so apply the same file
explicitly, which does the identical thing:

```bash
slide-agent apply . --html edit/work.html
```

Its JSON reply includes `overflows`: every text element in the applied slides
whose content still spills past its box after auto-fit has settled, with how
far (`beyond`, in canvas pixels) and the size auto-fit reached. A non-empty
list means the slide clips text — fix it (shorter text, a bigger box, a
smaller size, or `data-autofit="true"`) rather than rendering a PNG to look
for it.

Use `slide-agent capabilities` for the data attributes that carry builds, Magic
Move, crops, video trim and KaTeX. Use `render` only when you want a PNG to
look at.

## What not to do any more

The JSON transaction API below still works, and everything still lands through
it — but it is **no longer the way to author slides**, and reaching for it is
usually a mistake:

- **Do not compute geometry.** Absolute pixel arithmetic is the one thing a
  model is reliably bad at, and hand-placed boxes were the reason this
  interface was replaced. Write CSS and let the browser measure.
- **Do not read `deck.json`** to find out what is on a slide. `context` gives
  you the outline; `inspect --html` gives you the slide itself, in a form you
  can edit.
- **Do not write `deck.json`.**
- **Do not build `insertSlides` / `replaceElement` transactions** for ordinary
  authoring. Everything they do — insert, delete, reorder, restyle — is a
  section added, removed, moved or edited in the HTML file.

Keep the JSON path for what HTML genuinely cannot say: a deck-wide setting via
`updateDeck`, or tooling of your own that has no browser to lay a page out in.
`style.slideTemplate` from `context` exists for that case.

## The contract

A deck is a folder:

```
my-talk/
  deck.json    content, geometry, builds — schema: src/shared/deck.ts (zod)
  theme.css    typography and colour; a marked block is theme-generated
  edit/        watched HTML authoring files
  assets/      media, referenced by deck-relative path
```

- **Save `edit/*.html` → the editor syncs that slide range into the deck**
  within ~200 ms, as one undoable entry named after your file. The file records
  its original ordered scope, so removing and moving sections is structural
  editing, not merely content replacement.
- The editor lays the page out itself, in the same engine that draws the
  slides, so the geometry comes from your CSS and the deck's `theme.css` — not
  from an approximation of them.
- `theme.css` is yours to edit directly; the running app reloads it.
- **Never write `deck.json` by hand.** If some tool of yours must change the
  deck without a browser, go through `slide-agent transaction apply`: it is
  revision-checked, validated and atomic, and with the app running it lands in
  the undo history under your own label.
- Geometry is absolute pixels on the deck's `canvas` (usually 1920×1080),
  origin top-left, width before height. `rot` is clockwise degrees about the
  element's centre; `z` is paint order.
- Do not edit inside the `/* >>> slide-editor theme (generated) */ … */`
  block in `theme.css` — installing a theme replaces it wholesale. Everything
  outside it is yours. Agent transactions do not touch the theme at all.

## Getting this guide, from a deck folder

You are probably working in a deck folder, not in the editor's source tree.
DeckWerk no longer writes an `AGENTS.md` into each deck folder. This repository
guide remains available from any deck folder through the CLI:

```bash
slide-agent docs        # this document
slide-agent help        # the command list
```

If `slide-agent` is not on your PATH, it lives at `bin/slide-agent` in the
editor's checkout and can be run by its full path from anywhere. There is also
`npm run agent --silent -- <command>`, but only from inside that checkout, and
only with an **absolute** deck path — npm runs scripts from its own directory,
not yours.

## The CLI

```bash
slide-agent <command> [options]
```

Everything on stdout is JSON except `docs`, `help`, and `inspect --html`.
Diagnostics go to stderr. Exit codes are `0` ok, `1` error,
`2` usage, `3` revision conflict.

| Command | What it answers |
| --- | --- |
| `docs` | This guide |
| `capabilities [ids...]` | Every feature (or just the named ones), with a working example, screenshot and markup |
| `context [deck]` | What is selected, what revision is the deck, is the editor live |
| `inspect [deck] [--selected\|--slide id\|--all] [--html\|--dom]` | Editable HTML, or computed inspection data |
| `apply [deck] --html <file>` | Explicitly compile and sync an HTML range |
| `render [deck] [--selected\|--slide id\|--all] --output <dir> [--annotate] [--built] [--contact-sheet]` | Optional PNGs; `--contact-sheet` adds one tiled overview of everything rendered |
| `preview [deck] [--port n] [--open]` | Export through the real player and serve on localhost; prints its URL as JSON, then blocks — run it in the background and give the user the URL |
| `validate [deck]` | Schema, duplicate ids, timeline references, missing assets |
| `asset import <deck> <paths...>` | Media copied into `assets/`, deduped, probed, transcoded |
| `transaction apply <deck> <file.json>` | One atomic, named change |

The deck argument defaults to the current directory.

### Repair import gaps

`slide-agent validate` reports `importGaps` separately from structural errors.
For each gap, export its slide with `inspect --html --slide <id>`, replace the
conspicuous `data-element="unsupported"` placeholder with real HTML, and save.
The replacement becomes an editable text, media, shape, or HTML object on the
way back; a clean `importGaps: []` confirms that the repair loop is complete.

### Start with `context`

```bash
slide-agent context ~/talks/millivid
```

```json
{
  "live": true,
  "deckRevision": "8764d91c…",
  "activeSlideId": "slide-18",
  "selectedSlideIds": ["slide-18", "slide-19", "slide-20", "slide-21"],
  "selectedElementIds": ["equation-18"],
  "stale": false,
  "outline": [
    { "index": 17, "id": "slide-18", "title": "Scaling is the bitter lesson",
      "elements": { "text": 2, "image": 1 }, "builds": 1,
      "magicMoveFromPrevious": false, "skipped": false }
  ],
  "style": {
    "canvas": { "w": 1920, "h": 1080 },
    "roles": [
      { "class": "role-title", "count": 42,
        "box": { "x": 160, "y": 120, "w": 1600, "h": 200 }, "align": "left" }
    ],
    "slideTemplate": { "…": "a slide in this deck's conventions" }
  }
}
```

The outline is the map: slide ids in order, each with the text that identifies
it. "Add three slides about MilliVid around the middle" is answered by scanning
it and picking the `afterSlideId` to insert after — no slide-by-slide reading
required.

`live` tells you which world you are in:

- **`live: true`** — the editor is open. Its in-memory deck is the real
  document, `deckRevision` is that deck's hash (which may lead `diskRevision`
  by an autosave), and transactions are applied by the editor itself.
- **`live: false`** — no editor. `deck.json` is the document. Any selection
  shown is a *hint* recovered from the last session's sidecar, filtered to ids
  that still exist; `stale: true` means that sidecar was left behind by an app
  that never shut down cleanly.

The sidecar lives in `~/.slide-editor/runtime/<deck>-<hash>/`, never in the
deck folder — it is ephemeral state, not part of the document, and it stays out
of git.

### Computed scenes, for inspection rather than authoring

Bare `inspect` (without `--html`) returns a computed scene per slide: what the
renderer actually produced, not what the JSON says. It is for *answering
questions* — does this text overflow, what size did auto-fit settle on — not
for authoring, which is the HTML file's job.

```bash
slide-agent inspect ~/talks/millivid --selected
```

Each element carries:

- `authored` — the geometry in `deck.json` (`x, y, w, h, rot, z, opacity`).
- `rendered` — the measured box, relative to the slide's top-left. `null` when
  no editor was running to measure it.
- `computedStyle` — resolved typography and colour, merged across the element
  wrapper, its text body and its fitted content.
- `text` — `html`, `plain`, the size auto-fit settled on (`fittedFontSize`),
  and `overflowX` / `overflowY`. The overflow flags are `null` offline: they
  are measurements, and without an editor none was taken.
- `media` — `src`, `fit`, `sourceBox` (the crop), `effects`, border, duration.
- `shape` — kind, stroke, fill, arrowheads, curve `control` point, `path`.
- `magicMoveId` and `lineageId` — explicit pairing and duplication ancestry.
- `selected` — whether the user has it selected right now.

Offline, `rendered` is `null` and `computedStyle` is empty: authored inspection
never guesses at measurements it cannot take.

Reach for `--dom` only to debug layout — it returns the live rendered HTML with
every computed style inlined and the selection marked
`data-agent-selected="true"`. It needs the editor running.

Screenshots are optional verification, not the primary view:

```bash
slide-agent render ~/talks/millivid --selected \
  --output /tmp/shots --annotate --built
```

`--annotate` outlines every object and labels it with its element id, marking
the selection in red. `--built` fires every build so the finished slide is
captured rather than its opening state. Renders go through the same player the
projector runs, and need `npm run build:export` once.

### Change the deck with a transaction — the fallback path

**Reach for this only when HTML cannot express what you need**: a deck-wide
setting, or tooling with no browser. Authoring slides this way means computing
geometry by hand, which is exactly what the HTML loop exists to avoid. Note
that saving an `edit/*.html` file becomes one of these transactions anyway —
you are not gaining atomicity by writing it yourself, only losing the browser.

A transaction is all-or-nothing, named, and refuses to run if the deck moved
after you read it:

```json
{
  "version": 1,
  "expectedRevision": "8764d91c…",
  "label": "Pair the equation across the derivation",
  "operations": [
    { "op": "replaceElement", "slideId": "slide-19", "elementId": "equation-19",
      "element": { "…": "the whole element, with magicMoveId set" } },
    { "op": "replaceSlide", "slideId": "slide-19",
      "slide": { "…": "the whole slide, with magicMoveFromPrevious: true" } }
  ]
}
```

```bash
slide-agent transaction apply ~/talks/millivid /tmp/pair.json
```

Operations, applied in array order:

| `op` | Effect |
| --- | --- |
| `insertSlides` | Insert slides after `afterSlideId` (`null` = at the start) |
| `replaceSlide` | Replace a slide wholesale, including its `timeline` |
| `deleteSlide` | Remove a slide (a deck must keep at least one) |
| `moveSlide` | Move a slide after `afterSlideId` (`null` = to the start) |
| `insertElements` | Append elements to a slide |
| `replaceElement` | Replace one element; its `id` must not change |
| `deleteElements` | Remove elements and any timeline entries referencing them |
| `updateDeck` | `title`, `magicMoveEasing` |

Rules worth internalising:

- **Later operations see earlier ones.** A `replaceSlide` after a
  `replaceElement` on the same slide will overwrite it. Order accordingly.
- **Ids are the addressing scheme.** Unknown ids, duplicate ids, an id changed
  by a replacement, a timeline pointing at a removed element, or an asset that
  is not on disk all abort the whole transaction with the deck untouched.
- **A stale `expectedRevision` is a conflict, not an overwrite.** Exit code
  `3`, with the current revision in the response: re-read `context` and rebuild
  the transaction against it.
- With the editor **running**, the transaction is applied to the live document
  and appears as a single undo entry labelled with your `label`; the user's
  slide and object selection survive it. With the editor **closed**, the same
  transaction is applied to `deck.json` under an advisory lock, so two agents
  cannot interleave a read-modify-write.

### Media and citations

Bring media in through `asset import` rather than copying files yourself — it
dedupes by content hash, probes dimensions and duration, keeps vectors and PDFs
as vectors, and transcodes video Chromium cannot decode (which is otherwise a
silent black box on the projector):

```bash
slide-agent asset import ~/talks/millivid ~/Downloads/teaser.mov
```

It returns deck-relative `src` paths ready to drop into an element. One
unsupported file does not lose the rest of a batch — check `failures`.

Research, figure extraction and citation lookup are yours, not the editor's. A
reference is an ordinary text element ("SIREN, Sitzmann et al."); there is no
bibliography system to learn.

### A whole task, end to end

```bash
DECK=~/talks/millivid
slide-agent context $DECK                      # revision + selection
slide-agent inspect $DECK --selected           # what is on those slides
slide-agent asset import $DECK ~/Downloads/fig.png
# …build the transaction against the revision you just read…
slide-agent transaction apply $DECK /tmp/txn.json
slide-agent validate $DECK
slide-agent inspect $DECK --slide results      # confirm the result
```

## Invariants worth knowing

- Element `id`s must be unique per deck; timeline entries reference them.
- Videos: `start`/`end` are the non-destructive trim (seconds; `end: null` =
  end of file); `sourceBox` is the CSS crop (the element box is the window,
  `sourceBox` places the full frame inside it). Both are honoured by the player
  including looping start→end.
- Only H.264/VP8/VP9/AV1 video plays. Anything else must be transcoded before
  being referenced (`asset import` does this automatically).
- Text styling belongs in `theme.css` via `role-title` / `role-heading` /
  `role-body` / `role-caption` classes; inline `style` on an element overrides
  the stylesheet and is best reserved for deliberate one-offs.

## Seeing a deck without the app at all

```bash
npm run export -- path/to/my-talk /tmp/talk-web
```

`index.html#N` selects slide N (1-based). The export runs the identical player
the app uses, so what it shows is what the projector shows.

## Reliability rules (from the 2026-09 review — keep the bug classes extinct)

The Sep 2026 reliability review confirmed 23 editing/selection/undo/collab
bugs, traced them to a handful of architectural seams, fixed them, and left
guards. These rules keep the seams closed:

- **Comments are not invariants.** A rule another call site can silently
  violate (coalesce-key ordering, mode exclusivity, teardown symmetry) must be
  owned by a type/single function or asserted by a checker
  (`renderInvariants.ts`, `selectionInvariants.ts`) — never enforced only by a
  comment. If you find yourself writing "must not / must always" in a comment,
  add the assertion.
- **New interaction ⟹ new fuzz op.** A change that adds a gesture, panel
  control, or editing mode adds an operation to the cross-context fuzz
  alphabet (`test/crossContextFuzzBrowser.test.ts`) or the relevant fuzz walk
  in the same PR. Single-textbox fixtures hid cross-box selection bugs for
  months.
- **Bug fixes land red-to-green.** No fix merges without the failing
  real-input test that proves it (see the `*Bugs.test.ts` suites for the
  conventions: real CDP key/pointer input, soundness controls, `// BUG:`
  markers while red).
- **Text-edit session rules** (all guarded by tests — breaking one turns a
  suite red, but know why): commit targets resolve by element id deck-wide,
  never through `slideIndex` at fire time; a formatting/list/table commit
  *claims* the coalesce key (`advanceClaimedTextEditKey`); seals never run
  mid-IME-composition; `authoredTextHtml` must strip every piece of
  editor-only chrome the session stamps on the DOM; everything
  `beginTextEdit` sets on a node, `commitTextEdit` removes.
- **Collab editing rules:** the element being edited adopts remote html when
  nothing local is unsent (`adoptRemoteEditedHtml`); commits never re-assert
  a stale DOM over a store that moved past the session's sync point; remote
  decks landing mid-transaction are rebased, not applied
  (`applyRemote`/`txnBase`); a rebuild that ends an edit session re-enters it
  with the caret restored (`processEditReentry`).
- **Measurement is not an edit.** Renderer observations (auto-height fits)
  commit with `{ measurement: true }`: no undo slot, no dirty flag, no
  history churn, no broadcast.
- **Harness recoveries are findings.** Test helpers that repair lost
  selections/sessions must record it (`recordRecovery`) — a silent retry hides
  exactly the bug class these suites exist to catch.

**OS-event input smoke tier** (`npm run test:osinput`,
`test/osInputSmokeBrowser.test.ts` + `test/support/osInput.ts`): every other
browser tier injects input via CDP, which exercises Chromium's pipeline but
nothing above it. This macOS-only, opt-in tier (`RUN_OS_INPUT_SMOKE=1`; never
runs in CI) launches the real desktop app in a visible frontmost window and
sends genuine OS keystrokes/clicks through System Events, covering native
menu/accelerator routing (real Cmd+B/Cmd+Z) and real inter-application focus
loss — the app-switch blur exemption only OS focus changes can reach. It
requires Accessibility permission for the terminal app (System Settings >
Privacy & Security > Accessibility); once opted in, a missing permission is a
loud actionable failure, never a silent skip. Expect it to steal keyboard and
focus while it runs.
