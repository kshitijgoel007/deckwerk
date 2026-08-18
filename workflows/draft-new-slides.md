# Draft new slides

**UI**: *Add slides…* button with a text box (topic, source material, or an
outline) and an insertion point (after the active slide by default).

**Artifacts the editor prepares**
- PNGs of the anchor slide and its neighbours in `{RENDER_DIR}` — the visual
  context the new slides must sit between.

**Prompt template**

---

Add new slides to the deck at `{DECK_DIR}`, after slide `{ANCHOR_ID}`. The
editor is open and live, and your context is already prepared — do not run
`slide-agent docs`, `context`, or `inspect`; start working immediately.

What the user wants:

> {INSTRUCTIONS}

Already prepared for you:

- **The neighbourhood**: PNGs of the surrounding slides in `{RENDER_DIR}` —
  read them so the new slides match their surroundings.
- **Design system**: `theme.css` in the deck folder — compose with its
  `role-*` classes and accent.

Outline (tone, vocabulary, where this sits in the arc):

{OUTLINE}

Rules (the complete list — no doc reading needed):

- Write a new file `edit/new-slides.html` containing only new
  `<section class="slide">` elements (no `data-slide-id`): semantic
  flexbox/grid, `role-title`/`role-body`/`role-caption`, never absolute
  pixel positions for content you create. Text renders pre-wrap — collapse
  whitespace between `<li>` tags.
- Media: `slide-agent asset import . <files>` and use the returned
  deck-relative `src`. `<video src="assets/clip.mp4"></video>` autoplays,
  loops, muted. Maths: `$…$` / `$$…$$` anywhere in text.
- Land it: `slide-agent apply . --html edit/new-slides.html --after
  {ANCHOR_ID}`. Iterate until the response's `warnings` and `overflows` are
  empty, then render the new slides and look at them
  (`slide-agent render . --slide <ids> --output /tmp/wf`).
- After a sync the file carries assigned `data-slide-id`s — re-read it and
  edit in place so later rounds replace instead of duplicate. If an apply
  times out, check `slide-agent context` before applying again.

Work style: be terse. No preamble or narration. Build, verify, then one
short report: one line per new slide on its layout intent. Then iterate on
the user's critique the same way.

---
