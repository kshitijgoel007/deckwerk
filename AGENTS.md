# Working on a deck as an agent

An agent never talks to the Electron app directly. The contract is **files on
disk**: `deck.json` and `theme.css` are the document, and everything an agent
needs to read the editor's mind or change the deck safely goes through the
`slide-agent` CLI, which is itself only files.

## The contract

A deck is a folder:

```
my-talk/
  deck.json    content, geometry, builds — schema: src/shared/deck.ts (zod)
  theme.css    typography and colour; a marked block is theme-generated
  assets/      media, referenced by deck-relative path
```

- **Write `deck.json` or `theme.css` → the running app reloads itself** within
  ~200ms (main process watches both; its own saves are ignored by content
  comparison). An external rewrite of the open deck becomes one undoable
  "External edit" entry, and the user stays on the slide they were on.
- Prefer `slide-agent transaction apply` over writing `deck.json` yourself: it
  is revision-checked, validated and atomic, and with the app running it lands
  in the undo history under your own label.
- If you do write by hand, write **atomically** (temp file, rename) and
  validate against the schema first.
- Geometry is absolute pixels on the deck's `canvas` (usually 1920×1080),
  origin top-left, width before height. `rot` is clockwise degrees about the
  element's centre; `z` is paint order.
- Do not edit inside the `/* >>> slide-editor theme (generated) */ … */`
  block in `theme.css` — installing a theme replaces it wholesale. Everything
  outside it is yours. Agent transactions do not touch the theme at all.

## The CLI

```bash
npm run agent --silent -- <command> [options]
```

`--silent` matters: everything the CLI prints on stdout is JSON, and npm's
banner would otherwise land in front of it. Diagnostics go to stderr. Exit
codes are `0` ok, `1` error, `2` usage, `3` revision conflict.

| Command | What it answers |
| --- | --- |
| `context [deck]` | What is selected, what revision is the deck, is the editor live |
| `inspect [deck] [--selected\|--slide id\|--all] [--dom]` | What is actually on those slides |
| `render [deck] [--selected\|--slide id\|--all] --output <dir> [--annotate] [--built]` | Optional PNGs |
| `validate [deck]` | Schema, duplicate ids, timeline references, missing assets |
| `asset import <deck> <paths...>` | Media copied into `assets/`, deduped, probed, transcoded |
| `transaction apply <deck> <file.json>` | One atomic, named change |

The deck argument defaults to the current directory.

### Start with `context`

```bash
npm run agent --silent -- context ~/talks/millivid
```

```json
{
  "live": true,
  "deckRevision": "8764d91c…",
  "activeSlideId": "slide-18",
  "selectedSlideIds": ["slide-18", "slide-19", "slide-20", "slide-21"],
  "selectedElementIds": ["equation-18"],
  "stale": false
}
```

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

### Prefer computed scenes

`inspect` returns a computed scene per slide: what the renderer actually
produced, not what the JSON says.

```bash
npm run agent --silent -- inspect ~/talks/millivid --selected
```

Each element carries:

- `authored` — the geometry in `deck.json` (`x, y, w, h, rot, z, opacity`).
- `rendered` — the measured box, relative to the slide's top-left. `null` when
  no editor was running to measure it.
- `computedStyle` — resolved typography and colour, merged across the element
  wrapper, its text body and its fitted content.
- `text` — `html`, `plain`, the size auto-fit settled on (`fittedFontSize`),
  and `overflowX` / `overflowY`.
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
npm run agent --silent -- render ~/talks/millivid --selected \
  --output /tmp/shots --annotate --built
```

`--annotate` outlines every object and labels it with its element id, marking
the selection in red. `--built` fires every build so the finished slide is
captured rather than its opening state. Renders go through the same player the
projector runs, and need `npm run build:export` once.

### Change the deck with a transaction

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
npm run agent --silent -- transaction apply ~/talks/millivid /tmp/pair.json
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
| `updateDeck` | `title`, `magicMoveDuration` |

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
npm run agent --silent -- asset import ~/talks/millivid ~/Downloads/teaser.mov
```

It returns deck-relative `src` paths ready to drop into an element. One
unsupported file does not lose the rest of a batch — check `failures`.

Research, figure extraction and citation lookup are yours, not the editor's. A
reference is an ordinary text element ("SIREN, Sitzmann et al."); there is no
bibliography system to learn.

### A whole task, end to end

```bash
DECK=~/talks/millivid
npm run agent --silent -- context $DECK                      # revision + selection
npm run agent --silent -- inspect $DECK --selected           # what is on those slides
npm run agent --silent -- asset import $DECK ~/Downloads/fig.png
# …build the transaction against the revision you just read…
npm run agent --silent -- transaction apply $DECK /tmp/txn.json
npm run agent --silent -- validate $DECK
npm run agent --silent -- inspect $DECK --slide results      # confirm the result
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
