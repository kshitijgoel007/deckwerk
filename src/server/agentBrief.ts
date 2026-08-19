/** Onboarding served by every agent-scoped collaboration session. */
export const AGENT_BRIEF = `# Work on this presentation as an agent

You can edit only the presentation in this session. Do not edit deck JSON.
Create slides as ordinary HTML and CSS.

## Control plane and viewer

Use the HTTP API for all programmatic work. Send HTML in the request body.
Do not use editor controls for authoring.

The browser is a read-only real-player viewer. Request a slide URL through
\`GET /api/render-slide\`, open it, and inspect the result. The viewer updates
when the deck changes.

A human can add \`debug=1\` to the editor URL to open the old diagnostic
workspace. Agents must not depend on that workspace.

## Required workflow

1. Get the deck context.
2. Get the open comments.
3. Import each public asset through \`POST /api/import-url\`.
4. Write a complete 1920×1080 HTML document.
5. Send the HTML and target to \`POST /api/preview-html\`.
6. Open the Source preview and capture a screenshot.
7. Open the Imported preview and capture a screenshot.
8. Compare the screenshots visually. Fetching HTML or checking byte counts is
   not visual verification.
9. Read the import report. Fix every overflow and missing or blocked asset.
10. Repeat preview and screenshot inspection until those lists are empty.
11. Send the returned draft data to \`POST /api/apply-html\`.
12. Get the real player URL from \`GET /api/render-slide\`.
13. Open the player URL and capture a screenshot at the full 16:9 slide.
14. Check for clipping, overlap, broken media, tiny text, and poor hierarchy.
15. Re-read the request and make a content inventory: count every required person,
    item, asset, and section. A clean render is still a failure if content is missing
    or the composition is perfunctory or overly sparse.
16. If the player is wrong or the inventory is incomplete, preview and apply a
    revision. Verify it again.
17. Reply to useful comments. Resolve comments only after both the screenshot and
    content inventory pass.

Preview does not change the presentation. Apply creates one named collaboration
revision in the editor's History panel. Any earlier revision can be restored;
the restoration is itself a new collaborative revision.
If the revision changed, preview again. Never reuse a draft after a revision conflict.

Do not apply a draft with reported overflow, missing assets, or blocked resources.
Do not claim that you inspected a render when you only fetched its HTML. If you
cannot capture screenshots, stop and report that visual verification is blocked.
Do not use an empty diagnostics report as proof that the requested design is
complete: diagnostics check import mechanics, not editorial completeness or quality.

## Author HTML freely

Use semantic HTML, CSS grid, flexbox, inline SVG, images, video, and CSS animation.
Wrap each slide in \`<section class="slide">\`.
Give each section a concise \`data-name\` so the deck outline stays useful.
The slide canvas is 1920×1080 unless \`getContext()\` reports another size.
Write inline maths as \`$…$\` and display maths as \`$$…$$\`; the player and
import measurement render both with bundled KaTeX.

JavaScript is not allowed. Event handlers are removed. External presentation-time
network resources are blocked. Upload assets first or use data URLs. Data URLs are
extracted into the presentation asset folder during preview.

The importer converts text, lists, images, video, simple shapes, and box paint into
editable native objects. It keeps the smallest unsupported region as isolated HTML.
The report lists each fallback reason and the native-object ratio. Visual fidelity
has priority over native editing.

Prefer flat text elements with classes over nested formatting tags. For example,
use \`<p class="person-name">Name</p>\` instead of a nested \`<b>\`. A fallback is
acceptable only when Source and Imported screenshots still match visually.

## Targets

Insert after a slide:

\`\`\`js
const target = { mode: "insert", afterSlideId: "slide-id" };
\`\`\`

Replace one slide:

\`\`\`js
const target = { mode: "replace", slideIds: ["slide-id"] };
\`\`\`

Replacement keeps the slide ID, comments, speaker notes, and hidden state. It
replaces visual content and builds. A multi-slide draft applies as one change.

## Comments

\`\`\`js
const open = await agent.listComments("open");
await agent.addComment({ slideId, parentId: commentId, text: "Implemented and verified." });
await agent.resolveComment(commentId);
await agent.reopenComment(commentId);
\`\`\`

Do not delete another person's comment. Navigate with \`agent.goToSlide(number)\`.

## HTTP example

Use the session origin and add the deck ID to each request. This example works
in the page and in any programmatic browser that can call \`fetch\`.

\`\`\`js
const deck = new URLSearchParams(location.search).get("deck");
const endpoint = (path) => \`\${location.origin}\${path}?deck=\${encodeURIComponent(deck)}\`;
const post = async (path, body) => {
  const response = await fetch(endpoint(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
};

const context = await (await fetch(endpoint("/api/context"))).json();
const comments = await (await fetch(endpoint("/api/comments"))).json();
const draft = await post("/api/preview-html", { html, target });
const result = await post("/api/apply-html", {
  draftId: draft.draftId,
  expectedRevision: draft.revision,
  idempotencyKey: crypto.randomUUID(),
  label: "Agent: add project timeline",
  target: draft.target,
});
\`\`\`

The JSON request for \`POST /api/import-url\` is
\`{ "url": "https://…", "name": "portrait.jpg" }\`. The response gives a
deck-relative \`src\` value. Use that value in the slide HTML.

Command-line agents can preview a large HTML file without JSON escaping:

\`curl -H 'content-type: text/html' --data-binary @slides.html\`
\`'<origin>/api/preview-html?deck=<deck>&mode=replace&slideIds=slide-a,slide-b'\`

For insertion, use \`mode=insert&afterSlideId=<id>\`. Omitting \`afterSlideId\`
inserts at the start. The JSON form remains available to browser agents.

Use a new idempotency key for each intended change. Reusing a key returns the first
result and does not duplicate slides.

## HTTP and browser access

The session provides these HTTP endpoints:

- \`GET /api/brief\`
- \`GET /api/context?deck=…\`
- \`GET /api/comments?deck=…\`
- \`POST /api/comments?deck=…\`
- \`POST /api/comments/resolve?deck=…\`
- \`POST /api/upload?deck=…&name=…\`
- \`POST /api/import-url?deck=…\`
- \`POST /api/preview-html?deck=…\`
- \`GET /api/html-drafts/<draftId>/source?deck=…\`
- \`GET /api/html-drafts/<draftId>/imported?deck=…\`
- \`POST /api/apply-html?deck=…\`
- \`GET /api/render-slide?deck=…&slideId=…\`

The HTTP API is the authoritative path. The browser is only the visual output.
`;
