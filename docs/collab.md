# Collaborative editing

A standalone server hosts a **directory of deck folders**; any number of
people edit them from their browsers — over tailscale or any trusted network.
Everyone sees everyone's cursors, selections, and which slide each person is
on. The server never reads or writes anything outside the directory it was
launched on: every immediate subdirectory containing a `deck.json` is an
openable deck, new decks and Keynote imports are created inside it, and over
HTTP only each deck's `assets/` subtree is servable.

## Hosting from the desktop app

The **Collaborate** toolbar button shares the deck currently open in the
desktop app. The main process starts the same collab server pinned to that
one deck (port 5800, or a free port if taken) and hands the editor window off
to the browser client over localhost. The old shell stays visible until the
new one is ready, and its bounds, maximized state, active slide, and selection
carry across. The host becomes an ordinary peer, so
there is never a second writer on `deck.json`. The status bar shows the
invite URL (the LAN/tailscale address); anyone opening it lands directly in
the shared presentation. In a hosted session the New / Open / Import
Keynote… controls are absent for everyone: the server refuses deck listing
beyond the shared deck, deck creation, and Keynote import. The host's window
has an **End collaboration** button (also: just closing the window) that
ends the session for everyone — joiners see "session ended by the host" and
stop reconnecting — then reloads the deck from disk and brings the ordinary
editor back through the same continuous handoff. The button only appears (and
`/api/end` only works) for the
loopback client in a hosted session, i.e. the host machine.

Requires the built browser client (`npm run build:collab`); packaged builds
ship it in `dist/collab`.

## Agent sessions

The **Agent…** toolbar button starts the established deck-scoped collaboration
server and opens a small companion chat window backed by Codex App Server. The
editor hands off to the collaboration shell, so the HTTP API remains the one
authoritative writer while the chat is active.

On the first message in a chat, DeckWerk:

1. Wraps `AGENT_BRIEF` with the loopback session URL, API origin, and hosted
   deck ID using `agentClipboardPrompt`—the exact prompt copied by the previous
   Agent workflow.
2. Passes that complete prompt as the Codex thread's developer instructions.
3. Runs turns from a neutral scratch workspace with approvals disabled and
   network access enabled. The live deck is reachable only through the
   loopback HTTP API.
4. Streams text and activity into the companion window while API transactions
   appear in the collaboration shell and History panel.

Follow-up messages reuse both the Codex thread and live HTTP session. **New
chat** clears only the Codex thread; **Stop** interrupts the active turn.
Closing the companion window ends the hosted session, flushes the server, and
hands the presentation back to the ordinary editor.

## Comments

Slides and elements carry `comments: [{id, author, text, ts, resolved}]`
arrays in `deck.json`, so comments sync, merge, and export like any other
edit. In the UI: hover a slide row in the rail for the comment bubble
(bottom-right; it stays visible with the open count once comments exist);
on the canvas, elements with comments show a bubble at their top-right
corner, and right-click → "Add comment…" starts a thread on any object.
Comments from a collab session carry the author's display name.

## Running a standalone server

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
- **Save As… → Deck archive (.zip)…** — everyone, at any point, can save
  the whole deck folder (`deck.json`, `theme.css`, `assets/`). The server
  flushes the live session first, so the archive is exactly what everyone
  currently sees; unzip it and open the folder in the desktop app.
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
