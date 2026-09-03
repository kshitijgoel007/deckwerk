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
- `native-conversion.html` is the editability regression: every region on its
  two slides has a native deck object waiting for it — one-primitive SVG
  (circle, stroked rect, arrow line, path icon), a picture and a video inside
  bordered frames, a circular portrait, a hand-authored `<table>`, `<dl>`
  semantics, a quotation rule, a badge and an arrowhead that exist only as CSS
  pseudo-elements, and a card with a photograph behind its words. It compiles
  with no HTML fallback at all, and the eval asserts exactly that
  (`minNativeRatio: 1`). Its third slide is the cropped-picture case: round
  and rounded windows with ring shadows, holding deliberately non-square
  photographs framed by `object-fit`/`object-position` (percentages, a keyword
  pair, and the default). Each must arrive as *one* image object carrying the
  ring, the mask and a real `sourceBox` — the framing is what the editor's
  crop tool starts from, so a mis-read crop shows the wrong part of the
  photograph and the near-zero pixel bar catches it.
- `agent-paper-showcase.html` is the final overflow-free four-slide agent draft
  for SRNs, SIREN, Light Field Networks, and MetaSDF. Its four local videos,
  KaTeX equations, SVG, gradients, decorative frames, and dense mixed native /
  fallback composition make it the permanent multi-slide collaboration/import
  regression from the paper-showcase evaluation.

`scripts/stress-html-import.mts` compiles any HTML file the way
`slide-agent apply` does and prints what each region became, which is the
quickest way to see where editability is being lost:

```bash
npx vite-node --config vitest.config.ts scripts/stress-html-import.mts -- page.html
```

The real-player pixel harness can render each fixture at 1920 x 1080. Failed
comparisons must retain the source, imported, and diff images.
