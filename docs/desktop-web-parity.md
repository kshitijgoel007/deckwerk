# Desktop → web feature parity

This is the working TODO list for features present in the desktop editor but
missing or materially weaker in the browser collaboration editor. It compares
the native editor in `src/renderer/editor/main.ts` with the browser shell in
`src/renderer/collab/main.ts`; shared editing controls are already parity and
are intentionally omitted.

## Presentation

- [ ] **P0 — Speaker View.** Add a browser controller view with current and
  next-slide previews, build position, presentation and slide timers, wall
  clock, previous/next, blank-screen, and end controls. Keep an audience tab in
  sync through the collaboration session. Browser security means display
  placement may remain user-driven, but the two-view workflow should work.
- [ ] **P0 — Display-role controls.** Let a browser presenter identify the
  audience and controller windows and swap their roles. The desktop app can
  place them on enumerated displays automatically; document the browser's
  manual placement fallback where automatic placement is unavailable.
- [ ] **P1 — Present a selected slide range.** Desktop Present honors a
  contiguous multi-slide selection and stops at its end. Browser Present only
  accepts the starting slide today.

## Media editing

- [ ] **P0 — Video trim and crop.** Expose the desktop Trim & Crop workflow in
  the browser, backed by a deck-scoped server job with the same progress,
  cancellation, codec validation, and derived-asset behavior.
- [ ] **P1 — Rasterize and paint images.** Port the desktop raster paint
  workflow to the browser and upload the derived image through the existing
  content-hash asset importer. Preserve the PDF exclusion and destructive-edit
  warning.

## Agents and authoring workflows

- [x] **P1 — Personal embedded Agent for the desktop host.** A desktop-hosted
  collaboration keeps the host's private Agent account, saved conversation,
  model, reasoning, speed, history, steering, and stop controls. Agent edits
  join the same live transaction stream as human edits. Remote collaborators
  see the edits and Agent presence but cannot access the host's panel or account.
- [ ] **P2 — External-file authoring round trip.** Desktop watches `theme.css`
  and `edit/*.html` on disk. Define a browser-safe equivalent, such as a local
  File System Access handle where supported plus explicit import/export
  elsewhere; do not imply that a downloaded archive remains live-linked.

## Export and local files

- [ ] **P1 — Standalone Web export.** Add the desktop's self-contained web
  bundle export to the browser Save As menu, generated from the server's live
  deck snapshot.
- [ ] **P2 — Direct PDF download.** Browser PDF export currently opens a print
  document and relies on the browser's print dialog. Add a one-click generated
  PDF download where the deployment has a rendering service; retain print as
  the no-Chromium server fallback.
- [ ] **P2 — Folder-style Open and Save As.** Desktop can open a deck folder
  and save a copy as another folder. The browser can open server decks and
  download a ZIP. Add a File System Access implementation where supported and
  keep ZIP upload/download as the portable fallback.

## Already at parity

Both clients already share slide and element editing, text/shape/table
insertion, Props, Theme, Build, History, comments, undo/redo, live presence,
asset upload/drop, Keynote import, deck archive export, PDF-by-print, and
fullscreen audience presentation. These should stay on shared components so
new controls do not create a second parity backlog.
