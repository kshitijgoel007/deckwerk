/**
 * The onboarding document served at /api/brief: everything an agent joining a
 * collab session by URL needs to know to edit slides like a peer. Embedded as
 * a string (not a file read) so packaged builds carry it without extra assets.
 */
export const AGENT_BRIEF = `# Slide-editor collaboration session — agent brief

You are connected to a live collaborative slide editor. Open the session URL
in a browser; every edit you make syncs instantly to every human in the
session, and theirs to you. Do not edit deck.json on disk — the server owns
persistence.

**Element JSON is the native language of this session, and screenshots are
your eyes.** You edit by committing small changes to the deck structure and
verifying each one visually. There is no separate HTML authoring step here:
the canvas in front of you renders exactly what the projector will show.

## The workflow

Every task follows the same loop. Worked example — "add an intro slide":

1. \`window.agent.seeComments()\` — comments are how humans leave you
   instructions, each row carries its 1-based slide number. Start here.
2. \`window.store.selectSlide(n)\` and **screenshot the page** — see what the
   slide looks like now. Read 2–3 neighboring slides' elements
   (\`window.agent.getDeck().slides[n]\`) to learn the deck's fonts, sizes,
   colors, and background conventions. Match them; do not invent your own.
3. **Check the cookbook before building anything that feels like a feature.**
   GET \`/api/capabilities\` lists every editor capability with a minimal,
   valid example element: bulleted lists (real \`<ul><li>\` markup — never
   literal "•" characters), KaTeX maths (\`$…$\` in text — never positioned
   glyphs), crops (\`sourceBox\` — never re-encoding), circular masks,
   builds, Magic Move, shapes, borders and effects. If you hand-build
   something the editor already does, humans cannot edit it with their
   tools afterwards. Filter with \`?only=lists,builds\` once oriented.
4. Commit one logical change:
   \`\`\`js
   window.store.commit((deck) => {
     deck.slides.splice(1, 0, {
       id: 'slide-agent-x7f2a', name: 'Intro', notes: '',
       background: { color: '#0b0b10', image: null },
       elements: [ /* see element shapes below */ ], timeline: [],
     });
   }, { label: 'Agent: add intro slide' });
   \`\`\`
   Always pass a short label — it names the undo/history entry humans see.
5. **Screenshot again.** If something is off (overflowing text, misaligned
   boxes, an unclipped corner), fix it with another commit and re-check.
   Never assume a commit looked right without seeing it.
6. **Critique before you call it done — this step is not optional.** You are
   an expert slide designer; these slides go on a projector next to
   professionally made ones, and "renders without errors" is the floor, not
   the bar. Look at the final screenshot as if reviewing a stranger's work
   and write down at least three concrete deficiencies — composition, dead
   space, alignment, hierarchy, crowding, anything — then fix the ones that
   matter and look again. You have just built the slide, which is exactly
   when your judgment is most generous; the deficiencies are there, find
   them. A slide is finished when you would put your name on it as a
   designer, not when it merely contains the requested content. (Match the
   deck's *conventions* — fonts, colors, backgrounds — but do not treat its
   existing slides as the quality bar; many were made in a hurry.)
7. When a comment is dealt with: \`window.agent.resolveComment(id)\`, and
   reply with \`window.agent.addComment({...})\` when context helps. Never
   delete a human's comment.

## The page you are on

The client at \`/?deck=<deckId>&name=<yourName>\` exposes, on \`window\`:

- \`store\` — the deck store. \`store.state.deck\` is the live deck (do not
  mutate it directly); \`store.state.slideIndex\` the current slide.
- \`store.commit(fn, {label})\` — \`fn(deck)\` receives a deep clone, mutate
  it freely; the change is diffed into element-level operations, applied
  optimistically, and broadcast.
- \`store.selectSlide(i)\` — navigate (also drives your presence indicator).
- \`agent\` — helpers: \`brief()\`, \`getDeck()\`, \`goToSlide(n)\`,
  \`commit(fn, label)\`, \`seeComments()\`, \`addComment()\`,
  \`resolveComment()\`, \`uploadAsset(name, data)\`.
- \`canvas\`, \`rail\`, \`bridge\` — the UI objects, for advanced use.

## Deck shape (deck.json schema, abridged)

Canvas is fixed (default 1920x1080); all geometry is absolute pixels.
A slide: \`{id, name, background: {color, image}, notes, elements, timeline,
comments?}\`. Every element has \`{id, x, y, w, h, rot, z, opacity, class:
string[], style: Record<string,string>, comments?}\` plus per-type fields:

- text: \`html\` (inline HTML, <p> per paragraph), \`autoFit\`, \`align\`,
  \`valign\`. Give text \`class: ["kn-text", "role-title"|"role-heading"|
  "role-body"|"role-caption"]\` so theme.css styles it; set explicit
  font-size/family/color in \`style\` only to override the theme.
- image: \`src\` (deck-relative, "assets/…"), \`fit\` (contain|cover|fill),
  \`maskShape: "circle"\` for a circular mask, \`sourceBox\` to pan/zoom the
  picture behind the element box (the box is the visible window),
  \`borderRadius\` (px) for rounded corners.
- video: like image — \`maskShape\`, \`sourceBox\`, \`borderRadius\` all work
  the same — plus \`start\`/\`end\` trim (seconds), \`autoplay\`, \`loop\`,
  \`muted\`.
- shape: \`shape: rect|ellipse|line|arrow|path\`, \`fill\`, \`stroke\`,
  \`strokeWidth\`.

Fields not in the schema are silently dropped on parse — if you set a field
and it vanishes from the deck, you invented it; re-read this list.

New ids: any unique string works; prefix with your name
(e.g. \`text-agent-x7f2a\`).

## Uploading media

POST raw file bytes to \`/api/upload?deck=<deckId>&name=<filename>\` (same
origin). Response: \`{src, kind, width, height, duration}\` — use \`src\`
directly in an image/video element and size the element from width/height.
Or use \`window.agent.uploadAsset(name, blobOrBuffer)\`.

## Etiquette

- Small, labelled commits: one logical change per commit so humans can undo
  selectively.
- Do not touch elements a human is actively editing (presence badges show
  who edits what; concurrent edits to one element resolve last-write-wins).
- The theme file is shared: change theme.css only when asked.

## Other endpoints

- GET \`/api/capabilities[?only=id,id]\` — the feature cookbook: every
  capability with copy-pasteable example elements. Read it before building.
- GET \`/api/comments?deck=…\` — every comment with its 1-based slide
  number, as JSON, without touching the page. Same rows as
  \`window.agent.seeComments()\`.
- GET \`/api/deck?deck=…\` — the live deck as JSON (read-only; edits still
  go through \`store.commit\` in the page).
- GET \`/api/decks\` — list decks; POST \`?name=…\` creates one.
- GET \`/api/theme?deck=…\` — the deck's theme.css.
- GET \`/api/download?deck=…\` — zip of the whole deck folder.
- Present view: \`/present.html?deck=…&slide=<n>\` — the real player, fed by
  the same live session; edits land on it as they happen.
`;
