# Native CSS and layout benchmark

Use only the native surgical-editing interface. Do not rebuild or replace any
slide through HTML.

Work on slides 2 through 8 of the already-reformatted all-hands deck:

- Inventory every native video and every title before editing.
- On each slide that contains both a primary body-text block and a primary
  video, exchange the regions occupied by those two objects. Start by swapping
  their `x`, `y`, `w`, and `h` boxes; make only the smallest adjustments needed
  to avoid text overflow, clipping, or a visibly damaged composition. Do not
  swap the title, captions, labels, or secondary media by mistake.
- Give every native video on slides 2–8 a round mask with `maskShape: "circle"`.
  Preserve its existing effects and append a moderate blur effect with an
  8-pixel radius. Do not blur still images or shapes.
- Give every title on slides 2–8 a left-to-right text gradient from pink
  `#ff4fa3` to green `#52d273`. The gradient must paint the glyphs rather than
  the title box. Use the documented `contentStyle.<css-property>` channel with
  a linear gradient, text background clipping, and transparent text fill.
- Preserve the title typography established by the previous task, all wording,
  slide order and IDs, builds, comments, notes, media sources and playback,
  and every unrelated property.

Submit the complete change as one revision-bound native preview batch. Compare
every affected Before and After slide at 1920×1080. Revise any incorrect object
pairing, ugly crop, excessive blur, clipping, or new/worsened overflow. Apply
once with the label `Agent: swap content and add gradient media styling`, then
verify every affected slide in the real player.

In the final record, list: titles receiving the gradient; every video receiving
the round mask and blur; each body/video pair whose regions were exchanged;
any slide where no valid pair existed; any geometry exception; the preview
draft ID; and the applied revision.
