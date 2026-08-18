# Rework selected slides

**UI**: user selects slides in the rail, clicks *Rework selected slides*,
types instructions into the text box.

**Artifacts the editor prepares**
- PNGs of the selected slides plus `contact-sheet.png` in `{RENDER_DIR}`.
- The exported, editable scope at `{EXPORT_PATH}` — the same file
  `inspect --html` would produce, already in `edit/`.

**Prompt template**

---

Rework slides {SELECTED_IDS} of the deck at `{DECK_DIR}`. The editor is open
and live, and everything you need is already prepared — do not run
`slide-agent docs`, `context`, or `inspect`; start working immediately.

The user's instructions:

> {INSTRUCTIONS}

Already prepared for you:

- **Current look**: PNGs in `{RENDER_DIR}` (one per slide, plus
  `contact-sheet.png`). Read the relevant ones before editing.
- **Editable scope**: `{EXPORT_PATH}`. This file IS those slides: save it and
  the deck updates within ~200 ms as one undoable change the user watches.
  Slides not in this file are out of scope — never touch them.
- **Design system**: `theme.css` in the deck folder — read it, put reusable
  style there (the editor hot-reloads it), keep inline style for one-offs.

Deck outline for orientation:

{OUTLINE}

Rules (the complete list — no doc reading needed):

- Semantic HTML + flexbox/grid; never hand-compute pixel geometry for new
  content. A rebuilt slide is a fresh `<section>` keeping its
  `data-slide-id`; figure-heavy slides get style-only changes.
- Style attributes entity-escape quotes (`&quot;`) — edit them with
  entity-aware patterns, never a naive `;`-terminated regex.
- Theme selectors must cover both DOMs: `.text-body ul, .slide ul { … }`.
- Text renders pre-wrap: collapse whitespace between `<li>` tags.
- The save/apply response is your test suite: iterate until `warnings` and
  `overflows` are empty, then render only what changed
  (`slide-agent render . --slide <ids> --output /tmp/wf`) and look at it.
- After every sync the file is rewritten with assigned ids — re-read it
  before the next edit. If an apply times out, check `slide-agent context`
  before applying again.

Work style: be terse. No preamble, no narration between steps, no restating
the plan. Make the edits, verify, then give the user one short report:
what changed per slide, what you left alone and why. Then iterate on their
critique the same way.

---
