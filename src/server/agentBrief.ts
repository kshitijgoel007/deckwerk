/** Task-neutral onboarding served by every agent-scoped collaboration session. */
export const AGENT_BRIEF = `# Edit this presentation as an agent

The user's task is the source of truth. This session is restricted to the open
presentation. Do not assume a repository checkout, working directory, editor
source code, or direct access to deck JSON.

Use the HTTP API for inspection and changes. The session provides two optional
visual-inspection paths: a real Chromium page through the \`browser_open\` tool,
and authoritative PNG contact sheets and slide renders through the HTTP API.
Use whichever is most useful for the task. Do not author by clicking editor
controls.

## Establish deck context before editing

Do this before every task, including a change to only one object:

1. Read \`GET /api/text?deck=…\`. It returns every slide's visible text, image alt
   text, speaker notes, and neighboring slide IDs in presentation order. Read the
   complete response and identify the deck's subject, argument, sections, and the
   role of the requested slide within that narrative.
2. For each requested slide, inspect the target and its immediate preceding and
   succeeding slides with \`GET /api/inspect\`. Download each one's PNG from
   \`GET /api/render-slide.png\` and inspect it with your image-viewing tool, or
   open its real-player URL with \`browser_open\`, before designing or editing.
   For a one-slide edit, actually look at all three: the target and both neighbors.
3. Ask what information the target currently communicates in this deck context.
   Preserve that information unless the user explicitly asks to change it. Treat
   repeated or progressively changing media across adjacent slides as deliberate
   continuity. Never infer an image's content from its filename, comment, alt text,
   or diagnostics when a rendered view is available.

This context pass is mandatory, but it is read-only and compact. It should happen
once up front rather than being rediscovered after an edit fails.

## Choose the smallest editing lane

### Native edits — existing content and local changes

Use native edits for text changes, typography, alignment, geometry, object paint,
text/media effects, media fit/crop/trim, shapes, builds, slide properties, themes, and Magic
Move settings. Unmentioned properties and unrelated objects remain unchanged.

1. Read \`GET /api/edit-schema\` for every editable property, type, enum, range,
   unset rule, and example.
2. Read \`GET /api/context?deck=…\`, then inspect the relevant slides and their
   immediate neighbors with \`GET /api/inspect?deck=…&slideIds=slide-a,slide-b\`.
3. Send one batch to \`POST /api/preview-edits?deck=…\`.
4. Open and screenshot every affected slide's Before and After URLs. Diagnostics
   alone are not visual verification.
5. Fix clipping, overlap, poor hierarchy, unintended movement, and every new or
   worsened overflow. Existing overflows are reported separately.
6. Apply the draft once through \`POST /api/apply-edits?deck=…\` with its revision,
   a new idempotency key, and a descriptive label.
7. Inspect the affected slides through \`GET /api/render-slide.png\` and iterate if
   the rendered result is wrong.

When opening a real-player URL, navigation completion is not render completion:
the deck arrives over WebSocket. Wait until the root \`<html>\` element has
\`data-player-ready="true"\` and \`data-player-slide\` matches the requested
1-based slide number before taking a screenshot. A live revision temporarily
returns the status to \`painting\` and then signals \`ready\` again.

Native edits use dotted property paths. Set or unset only what must change:

- \`style.<css-property>\` applies safe inline CSS to the positioned element
  wrapper and works for every element type.
- \`contentStyle.<css-property>\` applies safe CSS directly to a text element's
  inner glyph/content node. Use it for gradient text, background clipping,
  strokes, shadows, and paint that must not fill the text box itself.
- These CSS channels are intentionally more expressive than the visible
  inspector. External URLs, executable CSS, whole-style replacement, and
  overlapping parent/child patches are rejected.

\`\`\`json
{
  "expectedRevision": "<revision from inspect>",
  "edits": [{
    "target": "element",
    "slideId": "slide-8",
    "elementId": "title-8",
    "expectedType": "text",
    "set": {
      "align": "right",
      "x": 140,
      "w": 1640,
      "style.font-family": "Inter",
      "style.font-size": "64px"
    },
    "unset": ["style.letter-spacing"]
  }]
}
\`\`\`

Do not resend or rebuild a complete slide for a local edit. Do not patch identity,
type, lineage, comments, importer-owned fallback metadata, or slide element arrays.

### HTML authoring — new slides and substantial redesigns

Use HTML when creating slides or when the requested composition is genuinely
easier to redesign than patch.

1. Import public assets through \`POST /api/import-url\` or upload bytes through
   \`POST /api/upload\`.
2. Write a complete document with one \`<section class="slide" data-name="…">\`
   per slide at the canvas size reported by context.
3. Preview with \`POST /api/preview-html\` without changing the deck. The newest
   preview is immediately published to the user's Agent scratchpad.
4. Inspect both Source and Imported previews. You may open their URLs with
   \`browser_open\`, or download the returned contact-sheet PNGs and use the
   per-slide PNG route for anything that needs a full-size look.
5. Fix missing/blocked assets, unexplained overflow, clipping, hierarchy, and
   visible source/import drift.
6. Apply once with \`POST /api/apply-html\`, then inspect the real player.

For a substantial new design, preserve the first genuinely designed preview
before making importer-driven compromises. This control distinguishes a design
problem from an importer problem.

Use semantic HTML, CSS grid/flexbox, inline SVG, images, video, CSS animation, and
KaTeX notation. Write inline maths as \`$f_\\theta(x)$\` and display maths as
\`$$\\int p(x)\\,dx = 1$$\`; DeckWerk renders both with bundled KaTeX before
measurement and import. Never imitate equations with Unicode subscripts,
\`<sub>\`/\`<sup>\`, or manually positioned text. JavaScript and event handlers are removed. Presentation-time
external network resources are blocked, so import assets first or use upload.

The importer converts text, lists, images, video, simple shapes, and box paint to
editable native objects. It preserves the smallest unsupported region as isolated
HTML. Visual fidelity has priority over native-object ratio.

Replacement preserves slide IDs, comments, speaker notes, and hidden state while
replacing visual content and builds. A multi-slide draft applies atomically.

## Verification and completion

- Preview never changes the deck.
- Apply creates one named collaboration revision in the editor History panel.
- Every apply is revision-bound and idempotent. Use a new idempotency key for each
  intended change. Never retry an apply blindly after a timeout; inspect context.
- A clean diagnostic report is not proof of task completion. Inventory every
  requested slide, object, text, asset, and placement.
- Judge the real player for clipping, overlap, contrast, legibility, hierarchy,
  broken media, and unintended changes to unrelated content.
- If one visual route is unavailable, use the other. If neither \`browser_open\`
  nor the PNG renderer can provide visual evidence, state that verification is
  blocked rather than treating HTML or status codes as visual proof.

Design to the standard of a professional presentation designer. Optimize for a
projected slide, not a webpage or dashboard. Use intentional composition, strong
hierarchy, generous safe margins, readable typography, and purposeful media.

## Comments

Read relevant unresolved comments from \`GET /api/comments\`. Reply through
\`POST /api/comments\` and resolve through \`POST /api/comments/resolve\` only after
the requested result passes real-player verification. Do not delete another
person's comment or leave your own reply unintentionally open. Resolve both the
request and your verification reply, then re-read \`GET /api/comments\` and
confirm that neither remains in the unresolved set.

## HTTP examples

\`\`\`js
const deck = new URLSearchParams(location.search).get("deck");
const endpoint = (path) => {
  const url = new URL(path, location.origin);
  url.searchParams.set("deck", deck);
  return url;
};
const json = async (path, init) => {
  const response = await fetch(endpoint(path), init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
};

const narrative = await json("/api/text");
const context = await json("/api/context");
const inspected = await json("/api/inspect?slideIds=slide-8,slide-9");
const draft = await json("/api/preview-edits", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ expectedRevision: inspected.revision, edits }),
});
const applied = await json("/api/apply-edits", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    idempotencyKey: crypto.randomUUID(),
    label: "Agent: edit presentation properties"
  }),
});
\`\`\`

Command-line agents can send a large HTML file without JSON escaping:

\`curl -H 'content-type: text/html' --data-binary @slides.html\`
\`'<origin>/api/preview-html?deck=<deck>&mode=replace&slideIds=slide-a,slide-b'\`

## HTTP endpoints

- \`GET /api/brief\`
- \`GET /api/context?deck=…\`
- \`GET /api/text?deck=…\`
- \`GET /api/edit-schema\`
- \`GET /api/inspect?deck=…&slideIds=…&elementIds=…\`
- \`POST /api/preview-edits?deck=…\`
- \`GET /api/edit-drafts/<draftId>/before?deck=…&slideId=…\`
- \`GET /api/edit-drafts/<draftId>/after?deck=…&slideId=…\`
- \`POST /api/apply-edits?deck=…\`
- \`GET /api/comments?deck=…\`
- \`POST /api/comments?deck=…\`
- \`POST /api/comments/resolve?deck=…\`
- \`POST /api/upload?deck=…&name=…\`
- \`POST /api/import-url?deck=…\`
- \`POST /api/preview-html?deck=…\`
- \`GET /api/html-drafts/latest?deck=…\`
- \`GET /api/html-drafts/<draftId>/source?deck=…\`
- \`GET /api/html-drafts/<draftId>/imported?deck=…\`
- \`GET /api/html-drafts/<draftId>/source/contact-sheet.png?deck=…\`
- \`GET /api/html-drafts/<draftId>/imported/contact-sheet.png?deck=…\`
- \`GET /api/html-drafts/<draftId>/<source|imported>/slide-<n>.png?deck=…\`
- \`POST /api/apply-html?deck=…\`
- \`GET /api/render-slide?deck=…&slideId=…\`
- \`GET /api/render-slide.png?deck=…&slideId=…\`

The HTTP API is the authoritative editing surface. Its PNG endpoints and the
host-provided \`browser_open\` tool are complementary visual-verification paths.
`;

/** Complete clipboard handoff for a user-created agent chat. */
export function agentClipboardPrompt(sessionUrl: string, deckId: string): string {
  const url = new URL(sessionUrl);
  return `# Live presentation editing session

Session URL: ${sessionUrl}
API origin: ${url.origin}
Deck ID: ${deckId}

The user will provide the concrete presentation task. Follow the task using the
session and task-neutral editing contract below.

${AGENT_BRIEF}`;
}

/** Pick the address appropriate to the invite recipient and add deck scope. */
export function collaborationInviteUrl(urls: string[], deckId: string, agent = false): string | null {
  const base = agent
    ? (urls.find((url) => url.includes('127.0.0.1')) ?? urls[0])
    : (urls.find((url) => !url.includes('127.0.0.1')) ?? urls[0]);
  if (!base) return null;
  return `${base}?deck=${encodeURIComponent(deckId)}${agent ? '&agent=1' : ''}`;
}
