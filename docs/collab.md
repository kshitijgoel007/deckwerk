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
server and opens a compact chat panel beneath the toolbar, backed by Codex App
Server. The native editor stays visible and joins that server as a collaboration
peer, so the HTTP API remains the one authoritative writer while the chat is active.

On the first message in a chat, DeckWerk:

1. Wraps `AGENT_BRIEF` with the loopback session URL, API origin, and hosted
   deck ID using `agentClipboardPrompt`—the exact prompt copied by the previous
   Agent workflow.
2. Passes that complete prompt as the Codex thread's developer instructions.
3. Runs turns from a neutral scratch workspace with approvals disabled and
   network access enabled. The live deck is reachable only through the
   loopback HTTP API.
4. Streams text and activity into the dropdown chat panel while API transactions
   appear in the native editor and History panel. Real-player requests also
   show the slide the agent is inspecting as a presence dot in the slide rail.

Follow-up messages reuse both the Codex thread and live HTTP session. **New
chat** clears only the Codex thread; **Stop** interrupts the active turn.
Choosing **Close** in the panel ends the hosted session, flushes the server, and
returns the already-open editor to ordinary file-backed persistence.

The panel displays the ChatGPT email used by its embedded agent. **Switch
account** signs out only DeckWerk's isolated Codex profile, discards threads
created by the previous account, and opens the managed ChatGPT sign-in flow.
The **Model** picker is populated from that account's live Codex model catalog;
the server-marked default is selected initially, and changes apply on the next
message in that deck's conversation.

While a turn is running, the composer remains available: another message
steers the active turn instead of waiting for it to finish. **Stop** remains a
separate control. When the selected model advertises a fast service tier, the
lightning button toggles it; lit means fast/priority service, unlit means the
standard service tier. Model and speed changes wait until the active turn ends.

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

### Shared-agent test mode

For demos, the headless server can run one Codex App Server identity that every
browser participant shares:

```bash
npm run collab -- path/to/decks --shared-agent
```

The server machine must have the `codex` executable available. DeckWerk finds
the copy bundled with ChatGPT on macOS or `codex` on `PATH`; set
`DECKWERK_CODEX_PATH=/absolute/path/to/codex` to select one explicitly.

Open the printed `http://127.0.0.1:…` URL on the server machine, choose a deck,
open **Shared Agent**, and sign in with the ChatGPT account that should fund and
own the demo agent. Login and account switching are accepted only over loopback;
remote collaborators can use the resulting agent but cannot replace its account.

The credentials live in an isolated Codex home at
`~/.deckwerk/shared-agent-codex`, not in the normal Codex profile. Override it
with `--agent-codex-home <dir>` or `DECKWERK_AGENT_CODEX_HOME`; set the visible
name with `--agent-name "Workshop Agent"`. Every browser participant gets an
independent conversation for each deck, so **New chat**, Stop, model settings,
follow-ups, and transcript selection affect only that participant. The browser
identity survives reloads through local storage; these test-mode conversations
remain in server memory until the headless server exits.

This is intentionally a trusted-network test mode: all participants share the
same account and model allowance, even though their conversations are separate.
Do not expose it to an untrusted network.

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
- **Save As… → PDF…** — opens a print tab (`print.html?deck=…&mode=…`) that
  builds the same `.pdf-page` document the desktop exporter renders — one page
  per slide, or per build stage when "Include each stage of builds" is ticked —
  at the deck's native pixel canvas, then opens the browser's print dialog:
  choose "Save as PDF". The headless server is plain Node with no Chromium, so
  there is no server-side equivalent of the desktop app's `printToPDF`; the
  page layout is shared with it (`src/renderer/print/pages.ts`) so both
  produce the same document. The deck comes from `/api/deck`, so the export is
  the live session. Because the readiness wait needs painted frames and
  browsers suspend those in a background tab, the tab asks to be brought
  forward, and offers the pages anyway after 20s rather than hanging.
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
