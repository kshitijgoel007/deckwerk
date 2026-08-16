# Working on a deck as an agent

An agent never talks to the Electron app. The contract is **files on disk**;
the app watches them.

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
  comparison). No ping, no IPC, no socket. If the app is not running, nothing
  is needed at all.
- Write the JSON **atomically if possible** (write temp file, rename). The
  watcher tolerates a half-written file — it retries on the next event — but
  atomic writes avoid a flash of the previous state.
- Validate against the schema before writing if you can; the app rejects
  invalid decks with a path-annotated error on reload.
- Geometry is absolute pixels on the deck's `canvas` (usually 1920×1080),
  origin top-left, width before height.
- Do not edit inside the `/* >>> slide-editor theme (generated) */ … */`
  block in `theme.css` — installing a theme replaces it wholesale. Everything
  outside it is yours.

## Seeing what a slide looks like

```bash
npm run export -- path/to/my-talk /tmp/talk-web
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --screenshot=/tmp/slide12.png --window-size=1920,1080 \
  "file:///tmp/talk-web/index.html#12"
```

`#N` selects slide N (1-based). The export runs the identical player the app
uses, so what the screenshot shows is what the projector shows.

## Invariants worth knowing

- Element `id`s must be unique per deck; timeline entries reference them.
- Videos: `start`/`end` are the non-destructive trim (seconds; `end: null` =
  end of file); `sourceBox` is the CSS crop (the element box is the window,
  `sourceBox` places the full frame inside it). Both are honoured by the player
  including looping start→end.
- Only H.264/VP8/VP9/AV1 video plays. Anything else must be transcoded before
  being referenced (the app does this automatically for drops and imports).
- Text styling belongs in `theme.css` via `role-title` / `role-heading` /
  `role-body` / `role-caption` classes; inline `style` on an element overrides
  the stylesheet and is best reserved for deliberate one-offs.
