# Agent Collaboration Interface

## Summary

Create a filesystem-first agent interface around the existing deck format. Agents will inspect selected slides through a computed scene graph, modify decks through revision-checked transactions, import researched assets, and optionally request DOM or screenshot artifacts.

The MilliVid example requires heterogeneous project-page media and paper source material: its [project page](https://davidcharatan.com/millivid/) contains videos and interactive figures, while [arXiv](https://arxiv.org/abs/2606.09056) exposes the paper and TeX source. The editor will provide general primitives rather than a paper-specific scraper.

The first execution step is to commit the current worktree as a checkpoint before implementing this system.

## Agent Context and Inspection

- Add a versioned `AgentContextV1` sidecar under `~/.slide-editor/runtime/<deck-path-hash>/context.json`; keep ephemeral state outside deck folders and Git.
- The running editor updates it atomically after selections, deck edits, theme changes, font loading, and auto-fit settle.
- Include:
  - Canonical deck path and SHA-256 revision.
  - Active slide and ordered selected slide IDs.
  - Selected element IDs.
  - Full computed scenes for every selected slide.
  - Authored and rendered bounds, rotation, opacity, stacking order, and selection flags.
  - Text HTML/plain text, resolved typography, alignment, fitted size, and overflow state.
  - Media paths, crop, border, effects, natural dimensions, and duration.
  - Shape geometry, arrow endpoints/control points, builds, and Morph identities.
- Treat computed scene JSON as the default agent view.
- Add an on-demand live DOM request that returns rendered HTML with computed styles and explicit selection attributes.
- Keep screenshots optional. Render them through the shared presentation renderer, with an option to annotate selected objects and element IDs.
- Detect stale contexts using the app session ID, process state, timestamp, and deck revision; fall back to authored deck inspection when the editor is offline.

## CLI and Safe Editing

Provide a `slide-agent` CLI:

- `context [deck]`: return current selection and revision.
- `inspect [deck] --selected`: return computed scenes; `--dom` requests the live DOM artifact.
- `render [deck] --selected|--slide <id> --output <dir> [--annotate]`: produce optional PNGs.
- `validate <deck>`: validate schema, IDs, asset references, builds, and Morph references.
- `asset import <deck> <paths...>`: reuse existing deduplication, probing, vector preservation, and video transcoding; return deck-relative paths and media metadata.
- `transaction apply <deck> <transaction.json>`: apply one atomic, named change.

Define `AgentTransactionV1` with `expectedRevision`, a history label, and ID-addressed operations:

- Insert, replace, delete, or reorder slides.
- Insert, replace, or delete elements.
- Update whitelisted deck fields such as title and Morph duration.
- Replace a slide’s timeline as part of a slide replacement.
- Pair Morph objects by replacing their explicit identity fields in one transaction.

Transactions are all-or-nothing and validated against the deck schema. Invalid IDs, duplicate IDs, broken references, or stale revisions leave the deck unchanged.

When the editor is running:

- The CLI writes requests to a filesystem inbox.
- The editor applies them against its current in-memory revision.
- Each transaction becomes one named undo-history entry.
- Existing slide and object selections are preserved by stable IDs.
- A stale request returns a conflict and the latest revision for retry.

When the editor is offline:

- The CLI acquires an advisory deck lock, rechecks the revision, validates the result, and atomically replaces `deck.json`.
- The same transaction format and validation rules apply.
- Direct external deck reloads should become undoable “External edit” entries instead of clearing history.

Paper research, figure extraction, and citation lookup remain agent responsibilities. Downloaded media enters through `asset import`; references such as “SIREN, Sitzmann et al.” are ordinary text elements rather than a new bibliography system.

## Tests and Documentation

- Test active-slide, range-slide, and object selection publication, including stable IDs after edits and reordering.
- Test computed typography, inline overrides, auto-fit results, overflow, media geometry, arrows, builds, and selection flags against the live renderer.
- Test stale sidecars, crashed-app leftovers, and offline authored-scene fallback.
- Test online transactions, offline transactions, revision conflicts, atomic failure, undo/redo, selection preservation, and concurrent UI edits.
- Test selected slides 18–21 flowing from context into a single Morph pairing transaction.
- Test asset import for PNG, JPEG, SVG, PDF, and supported/unsupported video codecs.
- Add an end-to-end fixture where an agent creates several slides, imports media, inserts a plain-text paper reference, validates the deck, and inspects the computed result.
- Extend `AGENTS.md` with the CLI workflow, transaction examples, coordinate conventions, and guidance to prefer computed scenes, use DOM for layout debugging, and use screenshots only as optional verification.

## Assumptions

- Version one targets local filesystem-capable agents such as Codex; no MCP server or in-app chat is required.
- No dedicated arXiv/project-page ingestion command is included.
- `deck.json` and `theme.css` remain the durable document format; agent runtime state is ephemeral.
- Agent transactions modify deck content only in version one. Theme-wide CSS changes continue through the existing theme workflow.
