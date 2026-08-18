# Collaborative editing

A standalone server hosts a **directory of deck folders**; any number of
people edit them from their browsers — over tailscale or any trusted network.
Everyone sees everyone's cursors, selections, and which slide each person is
on. The server never reads or writes anything outside the directory it was
launched on: every immediate subdirectory containing a `deck.json` is an
openable deck, new decks and Keynote imports are created inside it, and over
HTTP only each deck's `assets/` subtree is servable.

## Running

Build the browser client once (rebuild after pulling client changes):

```bash
npm run build:collab
```

Start the server on a directory of decks:

```bash
npm run collab -- path/to/decks            # binds 0.0.0.0:5800
npm run collab -- path/to/decks --port 6000 --host 127.0.0.1
```

It prints every reachable URL (localhost plus each network interface — the
tailscale address is among them). Collaborators open the URL in a browser and
pick a presentation; `?name=Alice` sets the display name, otherwise the client
asks once and the server falls back to `Guest n`.

## In the client

- **Open / New** — the toolbar lists every deck on the server, creates new
  ones (server-side `createDeck`, so theme.css and the agent brief stub come
  along).
- **Import Keynote…** — uploads a `.key` file; the server runs the same
  importer sidecar as the desktop app and the deck opens when it finishes.
- **Present** — opens the real Player in a new browser tab, fed by the same
  WebSocket session: edits made while presenting land on the presentation
  live, exactly like the desktop projector window. Arrow keys/space/click
  advance, double-click toggles fullscreen.
- **Sidebar tabs** — Props, Theme (the full preset gallery + adoption
  controls, shared code with the desktop app), Build, History. Restoring a
  history snapshot broadcasts as an ordinary transaction.

## Local development

Run the vite dev client instead of the built bundle — it proxies `/ws`,
`/assets`, and `/api` to `localhost:5800`:

```bash
npm run collab -- path/to/decks        # terminal 1
npx vite --config vite.collab.config.ts --port 5651   # terminal 2 (or the
                                                      # "collab-client" launch entry)
```

Then open `http://localhost:5651/?name=A` and `…?name=B` in two tabs.
`window.store`, `window.canvas`, `window.rail`, and `window.bridge` are
exposed for console driving.

## How it syncs

- The server holds the authoritative deck, applies each incoming transaction
  in arrival order, stamps it with a monotonically increasing `seq`, and
  broadcasts it to every client (including the sender, which is how a client
  confirms its own pending edits).
- Clients are optimistic: local edits apply immediately, are diffed into
  element-level operations (`src/shared/deckDiff.ts`), and sent. Each client
  keeps a `shadow` deck (the server's decided state) plus its pending
  transactions; the visible deck is always `shadow + pending`, replayed
  through the deterministic lenient apply (`src/shared/collabApply.ts`). Same
  op stream, same order, same result — that is the convergence guarantee.
- Merging is element-level last-write-wins: concurrent edits to different
  elements or slides both survive; two edits to the same element resolve in
  server-arrival order; a delete beats a concurrent edit; inserts are
  idempotent. Slide-level properties (name, background, layout, timeline)
  travel separately from elements, so renaming a slide never stomps a
  concurrent element edit on it.
- Undo is op-based and selective: Cmd+Z inverts *your* last edit against the
  *current* deck and broadcasts it as an ordinary transaction. It never
  reverts other people's work; if a peer deleted what you were about to
  restore, that part is skipped.
- Persistence mirrors the desktop autosave: debounced whole-file writes of
  `deck.json` by the server, which also watches the folder — an offline
  `slide-agent apply`, a git checkout, or a hand edit broadcasts a resync to
  every client.

## Media

Drag-and-drop works exactly like the desktop app: dropped files upload to the
server, land in `assets/` via the content-hash importer (H.264 transcode for
non-web-safe codecs included), and the new element is sized from a server-side
ffprobe. Videos stream with HTTP Range support, so playback and seeking work
in every tab. The inspector's non-destructive in/out trim sliders work
unchanged — they write `start`/`end` on the element and sync like any edit.

The one desktop-only media feature is the destructive "Edit w/ ffmpeg…"
trim-and-crop window; its button is hidden in the browser.

## Not in the browser client (v1)

Agent workflow launching, web export, and the presenter (notes/timer) view.
Like the desktop app, there is no raw-CSS sidebar tab; theme.css is edited on
disk (the server watcher broadcasts it) or through theme adoption.

## Known limits

- Do not open the same deck folder in the Electron app while the collab
  server is hosting it: both are debounced whole-file writers and will
  overwrite each other. Use the browser client, or an offline
  `slide-agent apply` (the watcher picks it up).
- Timeline (build) edits are slide-granular: two people editing builds on the
  same slide at the same moment resolve last-write-wins.
- Two people typing in the same text box at once: the last one to finish
  (blur) wins. The presence badge shows who is editing what.
- Presence and edits are unauthenticated by design — trusted networks only.
