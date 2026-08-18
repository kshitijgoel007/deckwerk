# Agent workflows

Each file here is a **workflow template**: the contract between a UI action
(a button in the editor) and an agent session (claude / codex) spawned to
carry it out.

A template has three parts:

1. **Artifacts** — what the editor prepares *before* spawning the agent, so
   the agent starts with eyes: rendered PNGs of the relevant slides, the
   deck path, the current selection, the user's typed instructions.
2. **Prompt** — the text the editor assembles from the template by filling
   `{PLACEHOLDERS}`, then hands to the agent as its opening message.
3. **Iteration contract** — how the agent must work and show results, so
   the user can go back and forth with it.

## The invariants every workflow shares

- The agent works **only through `slide-agent`** from the deck folder
  (`docs`, `context`, `inspect --html`, `apply`, `render`, `validate`).
  It never edits `deck.json`.
- **Look before touching**: render the affected slides and read the images
  before making any edit.
- **Triage before editing**: figure-dense slides get style normalization
  only; text-heavy slides may be rebuilt from scratch as semantic HTML;
  deliberately designed outliers are left alone (say so instead).
- **System first**: deck-wide style belongs in `theme.css` roles; inline
  style on elements is for deliberate one-offs only.
- **The apply response is the test result**: iterate until `warnings` and
  `overflows` are clean *before* spending renders on aesthetics.
- **Show, don't describe**: with the editor open, every save of
  `edit/*.html` lands live in the editor within ~200 ms as one undoable
  entry — that is the primary display. When asked for a review pass or when
  the editor is closed, render PNGs of the changed slides and show them.
- **Never rebuild what you weren't asked to touch.** Slides outside the
  exported range must not change; the export's recorded scope enforces this,
  so export exactly the slides in scope.

## Placeholders

| Placeholder | Filled with |
| --- | --- |
| `{DECK_DIR}` | Absolute path of the deck folder |
| `{SELECTED_IDS}` | Comma-separated slide ids of the user's selection |
| `{INSTRUCTIONS}` | The user's typed instructions, verbatim |
| `{RENDER_DIR}` | Directory of pre-rendered PNGs (one per selected slide, plus `contact-sheet.png` when available) |
| `{OUTLINE}` | The `slide-agent context` outline, pretty-printed |
