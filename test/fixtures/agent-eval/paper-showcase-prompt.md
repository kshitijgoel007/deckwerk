# Four-paper showcase benchmark

Act as both a senior presentation designer and a technically exact ML/graphics
communicator. Create a coherent four-slide mini-deck for an expert conference
audience. Use one slide for each paper, in this order:

1. Scene Representation Networks (SRNs)
2. Implicit Neural Representations with Periodic Activation Functions (SIREN)
3. Light Field Networks (LFNs)
4. MetaSDF

The design bar is a professionally art-directed conference keynote—not a paper
web page, dashboard, or grid of interchangeable cards. Each slide should make
one visual argument and may use a different composition while remaining part of
one recognizable visual system.

Research from the first-party project pages and papers. For every slide include:

- a short, takeaway-style headline that states the paper's contribution;
- compact paper identity (paper name, venue/year, and authors);
- a one-sentence TL;DR;
- one prominent, genuinely playable muted looping video, with a useful poster or
  first frame, imported into the deck rather than loaded from the network;
- one or two central equations, typeset as maths—not assembled from positioned
  glyphs—and connected visually to the method;
- one concrete result or “why it matters” takeaway supported by visible evidence;
- speaker notes containing the project-page, paper, and media source URLs.

Keep the content legible from the back of a room: no body text below 28 px, no
equation below 30 px, no title overflow, no clipped portraits/media, and generous
safe margins. The canvas is exactly 1920×1080. Avoid ornamental UI chrome,
gratuitous card grids, and long prose. HTML and CSS may otherwise be freely
designed using semantic markup, grid, flexbox, inline SVG, and CSS animation.

Use the editor's HTTP agent API for context, comments, asset import, preview,
apply, and real-player rendering. Do not assume a repository checkout or source
tree. Use these first-party pages and direct media candidates:

- https://www.vincentsitzmann.com/srns/
  - https://www.vincentsitzmann.com/srns/img/many_training_cars.mp4
- https://www.vincentsitzmann.com/siren/
  - https://www.vincentsitzmann.com/siren/img/image_convergence_15s_label.mp4
- https://www.vincentsitzmann.com/lfns/
  - https://www.vincentsitzmann.com/lfns/img/lfn_vs_pixelnerf_compressed.mp4
- https://www.vincentsitzmann.com/metasdf/
  - https://www.vincentsitzmann.com/metasdf/img/metasdf_steps_comp.mp4

## Preserve the real first draft

After research and asset import, submit one complete four-slide HTML document to
preview **before** making any importer-driven simplifications. Do not optimize
for native conversion in this first draft. Record its draft ID as
`initialDraftId`, open both its Source and Imported views, and inspect both at
1920×1080. This archived draft is the control for distinguishing design failure
from importer failure.

Then iterate through the normal look → change → look loop. Compare Source,
Imported, and the real player—not just diagnostics. Fix clipping, overflow,
broken video, illegible equations, weak hierarchy, and visible import drift.
Apply all four replacements atomically and without duplication. Reply to and
resolve the four seeded comments only after the real-player versions pass.

In the final record report the initial and final draft IDs, native-object ratios,
fallback reasons, pixel differences, imported asset paths, and any design changes
made because of importer behavior.
