# Working on this deck

This folder is a DeckWerk presentation. Author slides as semantic HTML and CSS;
a browser computes the layout and DeckWerk bakes it into ordinary editable
objects.

    deck.json   compiled output — never read, edit, or imitate it
    theme.css   typography, colours, and reusable classes
    notes.md    speaker notes, one anchored section per slide
    edit/       watched HTML authoring files
    assets/     deck-relative media and web pages

**“Authoring HTML” is the editable interface, not a presentation export.**
`slide-agent inspect . --html --slide <id|number>` prints a complete page for
the named slide. Redirect it into `edit/work.html`, edit its `<section>`, and
save it. With DeckWerk open the watcher compiles it back into deck objects;
offline, run `slide-agent apply . --html edit/work.html`.

## Single-slide fast path

For a request concerning one slide:

1. Run `slide-agent context . --around <slide>`.
2. Render only the target and immediate neighbours to learn the local visual
   context: `slide-agent render . --slide 8,9,10 --output /tmp/before`.
3. Use `inspect --html` only if native slide objects need editing. Use
   `--elements-only` or `--html-body` for compact, read-only inspection.
4. If the target is an existing web element, use `web inspect`, then
   `web check --replace`, then `web replace`; do not inspect several slides as
   full HTML just to learn their style.
5. Render and validate only the changed slide.

For an existing web element on slide 9:

    slide-agent web inspect . 9
    slide-agent web check source.html --replace 9 --screenshot /tmp/check.png
    slide-agent web replace . 9 source.html
    slide-agent render . --slide 9 --output /tmp/final
    slide-agent validate . --slide 9

`web check --replace` and `web replace` use the existing element's exact box
size. See `slide-agent docs web` for new web elements and asset rules.

## Choose the right path

- **Edit text, layout, objects, or one slide's styling:** create authoring HTML
  with `inspect --html`, edit it, then save/apply it.
- **Add slides:** use `slide-agent new . --count <n> > edit/add.html`. Do not
  copy scoped authoring HTML.
- **Delete or reorder slides:** inspect every involved slide into one authoring
  file, then remove or reorder complete `<section>` elements.
- **Change one object's font/colour:** use a deliberate inline style. Put a
  reusable class in `theme.css` outside its generated block.
- **Change role or deck typography/colour:** use `theme`; see
  `slide-agent docs themes`.
- **Images/video:** run `slide-agent asset import` and use the exact returned
  `src`; see `slide-agent docs authoring`.
- **Speaker notes:** edit `notes.md`, preserving each slide-id anchor.
- **Interactive JavaScript:** use a web element; normal authoring strips scripts.
- **Builds, Morph, crops, masks, trim, and unusual primitives:** read only the
  matching named `slide-agent capabilities <id>` recipe.

## Start safely

Run `slide-agent context` and read `theme.css` before authoring. `context`
provides the outline, selection, canvas, roles, and deck style; use `--around`
for a local window. If the user mentions comments or gives no other task, read:

    slide-agent comments . --unresolved

Resolve comments only after acting on them. Reply with `comments --add`; never
delete a human's comment.

Do not explore the source repository for mutation operations. There is no
`slide-agent delete`, `move`, or `reorder` command: the ordered section list in
authoring HTML is the structural API.

## The authoring loop

    slide-agent inspect . --html --slide <id|number> > edit/work.html
    # edit edit/work.html; give deckwerk-change-label a concise intent
    slide-agent apply . --html edit/work.html
    slide-agent validate . --slide <id|number>
    slide-agent render . --slide <id|number> --output /tmp/final

With the editor open, saving is sufficient; explicit `apply` gives a
deterministic reply. Read its `changes` object. A non-empty `deleted` you did
not intend means stop and undo. If apply times out, run `context` before
retrying because the editor may still land the change.

An inspected page is lossless, so existing objects may be absolutely
positioned. Small edits can change that markup in place. For a redesign, keep
the section's `data-slide-id` but replace its contents with clean flex/grid
markup. Removing the slide id turns it into a new slide.

Structural examples:

    # delete 44: remove its section
    slide-agent inspect . --html --slide 44 > edit/work.html

    # reorder 43–45: rearrange the three complete sections
    slide-agent inspect . --html --slide 43,44,45 > edit/work.html

    # move 44 next to 12: inspect both and order them 12,44 (or 44,12)
    slide-agent inspect . --html --slide 12,44 > edit/work.html

After a successful sync, DeckWerk rewrites the file with ids for new slides.
Re-read it before further edits. When duplicating a section, remove the copied
slide id, child element/lineage ids, and duplicated SVG marker ids.

## Design and style rules

- Match the existing deck's typography, palette, spacing, density, and level of
  ornament. Read `theme.css`; use `role-title`, `role-heading`, `role-body`,
  `role-caption`, and `role-base`.
- Use semantic HTML, flexbox/grid, aligned edges, and generous space. Do not
  hand-compute geometry or imitate machine-generated positioning for new work.
- Put reusable classes in `theme.css` outside the generated theme markers.
  File-local `<style>` may affect measurement but is not the deck stylesheet.
- Use real lists, tables, media tags, and KaTeX (`$…$`, `$$…$$`). Use
  `data-autofit="true"` for unpredictable text and validate after copy changes.
- Render the edited scope and inspect composition, hierarchy, alignment,
  crowding, and dead space before finishing.

## Assets inside web elements

Interactive pages must be self-contained. Remote requests are blocked, and
`web add`/`web replace` do not recursively copy relative dependencies. For
small images or data, embed optimized data URIs. Otherwise stage dependencies
under `assets/web/` and reference their final paths. Do not assume files beside
the source HTML will be copied beside its content-hashed staged page.

Use `web inspect` to report the staged source, poster, size, and statically
detectable missing assets. Use `web check` to catch runtime failures, network
requests, and overflow before replacing the page.

## Verification and focused reference

`validate --slide` checks structure, assets, import gaps, and canvas overflow.
`render --slide` shows the actual player output. Use `preview --open` only when
a human needs a playable deck.

Load detail only when the task needs it:

    slide-agent docs authoring   # HTML, structure, native objects, notes
    slide-agent docs web         # check/add/replace, box sizing, asset rules
    slide-agent docs themes      # fonts, role-scoped and deck-wide themes
    slide-agent docs internals   # scope markers, sync, transaction fallback
    slide-agent capabilities <id>

The JSON transaction API is a last resort for settings none of these surfaces
can express. It is not the slide-authoring workflow.

## Collaboration

For a hosted `http://…:58xx/?deck=…` session, open its **Agent…** panel and run
the exact connect command. Work in the resulting local mirror with the same
commands. In a mirror, either save or apply once; do not wait for the watcher
and then apply the unchanged page again.

{{LAUNCHER_HINT}}
## About this file

DeckWerk regenerates this `AGENTS.md` when the deck opens. Delete the generated
marker on its first line only if you intentionally want to own and maintain a
custom copy. Keep talk-specific prose in `notes.md`.
