# Beautify deck

**UI**: *Beautify deck* button; optional text box for taste directions
("keep it monochrome", "match our lab template", …).

**Artifacts the editor prepares**
- PNGs of every slide plus `contact-sheet.png` in `{RENDER_DIR}`.
- The full deck exported and editable at `{EXPORT_PATH}`.

**Prompt template**

---

Make the deck at `{DECK_DIR}` beautiful. The editor is open and live, and
everything you need is already prepared — do not run `slide-agent docs`,
`context`, or `inspect`; start working immediately.

User taste directions (may be empty):

> {INSTRUCTIONS}

Already prepared for you:

- **Current look**: `{RENDER_DIR}/contact-sheet.png` is the whole deck in
  one image — read it first; open individual PNGs only where you need
  detail.
- **Editable deck**: `{EXPORT_PATH}` holds every slide; save it and the
  deck updates live as one undoable change.
- **Design system**: `theme.css` in the deck folder.

Outline:

{OUTLINE}

Method (in this order):

1. From the contact sheet, triage each slide: restyle in place
   (figure-heavy: geometry untouched), rebuild from scratch (text walls:
   fresh semantic `<section>` keeping its `data-slide-id`), or leave alone
   (deliberately designed outliers — photo titles, intricate diagrams).
2. Define the system in `theme.css`: one font family, one `role-title`
   treatment (size, weight, position), `role-body`/`role-caption`, one
   accent color used for emphasis only. Selectors must cover both DOMs:
   `.text-body ul, .slide ul { … }`. Don't touch the marked generated block.
3. Normalize in `{EXPORT_PATH}`: strip inline
   `font-family`/`font-size`/`font-weight`/`text-align` from role-following
   elements (title heuristic: wide, near the top, height ≤ ~260px — never
   tall body blocks), standardize the title box, add the role class.
   Style attributes entity-escape quotes (`&quot;`) — never edit them with
   a naive `;`-terminated regex.
4. Rebuild the text walls: padding/flex/gap, structured lists, bold
   lead-ins, accent sparingly. Text renders pre-wrap: collapse whitespace
   between `<li>` tags.
5. The save/apply response is your test suite — iterate until `warnings`
   and `overflows` are empty. Then render changed slides
   (`slide-agent render . --slide <ids> --output /tmp/wf --contact-sheet`),
   look, fix.

Work style: be terse. No preamble, no narration, no plan-restating. Edit,
verify, then one short report: the system you chose, one line per changed
slide, and which slides you deliberately left alone. Then iterate on the
user's critique the same way.

---
