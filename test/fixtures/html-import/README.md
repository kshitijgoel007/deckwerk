# HTML importer fixtures

- `grid-flex.html` tests nested Grid and Flexbox, lists, gradients, and box paint.
- `media-svg.html` tests inline SVG, data URL extraction, images, video, and crops.
- `unsupported-css.html` tests pseudo-elements and unsupported CSS fallback scope.
- `unsafe-malformed.html` tests parser recovery, script removal, event removal,
  JavaScript URLs, and presentation-time external network blocking.
- `agent-vincent.html`, `agent-team.html`, and `agent-timeline.html` are the
  untouched professional-agent drafts from the design-gap evaluation. They are
  permanent real-world regressions for typography, portrait masks, pseudo-elements,
  gradients, dense absolute composition, and publication-media timelines.
- `agent-paper-showcase.html` is the final overflow-free four-slide agent draft
  for SRNs, SIREN, Light Field Networks, and MetaSDF. Its four local videos,
  KaTeX equations, SVG, gradients, decorative frames, and dense mixed native /
  fallback composition make it the permanent multi-slide collaboration/import
  regression from the paper-showcase evaluation.

The real-player pixel harness can render each fixture at 1920 x 1080. Failed
comparisons must retain the source, imported, and diff images.
