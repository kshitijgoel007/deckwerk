import type { SlideState } from './timeline.js';

/**
 * Paragraph segmentation for by-paragraph builds.
 *
 * A "paragraph" is what pressing return creates while editing text: a
 * top-level block of the text content, with each list item counted on its
 * own. Deliberately the same unit that `paragraphSpacing` spaces (see
 * type.css), so builds and spacing always agree on the text's structure.
 *
 * DOM-backed on purpose: the one segmentation is used for counting steps,
 * for the Build panel's sub-list and for the player's reveals, so the three
 * can never disagree. Callers run in renderer or jsdom contexts.
 */

const LIST_TAGS = new Set(['UL', 'OL']);
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'TABLE', 'FIGURE', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI',
]);

/** Marker class for the span wrapped around a run of top-level inline nodes. */
const RUN_CLASS = 'build-paragraph-run';

/** A soft-break line (`<div><br></div>`, whitespace, bare `&nbsp;`) is not a step. */
function hasContent(nodes: Node[]): boolean {
  for (const node of nodes) {
    if (node.textContent?.replace(/[\s ]+/g, '')) return true;
    if (node instanceof Element) {
      if (/^(IMG|VIDEO|svg|EMBED)$/i.test(node.tagName)) return true;
      if (node.querySelector?.('img, video, svg, embed')) return true;
    }
  }
  return false;
}

/**
 * The styleable element for each paragraph of a rendered `.text-content`,
 * in document order. Top-level inline runs (bare text before the first
 * block, KaTeX spans, ...) are wrapped in a plain inline span so they can
 * be toggled like any block; the wrap is idempotent across calls. Empty
 * lines are skipped — revealing nothing is not a build step.
 */
export function paragraphUnits(content: ParentNode & Node): HTMLElement[] {
  const doc = content.ownerDocument;
  const units: HTMLElement[] = [];
  let run: Node[] = [];
  const flushRun = () => {
    if (run.length > 0 && hasContent(run)) {
      const first = run[0];
      if (run.length === 1 && first instanceof HTMLElement && first.classList.contains(RUN_CLASS)) {
        units.push(first);
      } else {
        const wrap = (doc ?? document).createElement('span');
        wrap.className = RUN_CLASS;
        first.parentNode?.insertBefore(wrap, first);
        for (const node of run) wrap.appendChild(node);
        units.push(wrap);
      }
    }
    run = [];
  };
  for (const child of [...content.childNodes]) {
    const el = child instanceof HTMLElement ? child : null;
    if (el?.classList.contains(RUN_CLASS)) {
      flushRun();
      run = [el];
      flushRun();
      continue;
    }
    if (el && BLOCK_TAGS.has(el.tagName)) {
      flushRun();
      if (LIST_TAGS.has(el.tagName)) {
        // A list builds item by item; nested lists ride along inside their item.
        for (const li of el.children) {
          if (li.tagName === 'LI' && hasContent([li])) units.push(li as HTMLElement);
        }
      } else if (hasContent([el])) {
        units.push(el);
      }
      continue;
    }
    run.push(child);
  }
  flushRun();
  return units;
}

function unitsFromHtml(html: string): HTMLElement[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return paragraphUnits(template.content);
}

/** How many build steps a by-paragraph reveal of this text expands to. */
export function countParagraphs(html: string): number {
  return Math.max(1, unitsFromHtml(html).length);
}

/** One collapsed-whitespace text snippet per paragraph, for lists and labels. */
export function paragraphTexts(html: string): string[] {
  return unitsFromHtml(html).map(
    (unit) => (unit.textContent ?? '').replace(/[\s ]+/g, ' ').trim(),
  );
}

/**
 * Reconcile per-paragraph visibility with a resolved slide state: for every
 * element the state tracks parts for, the first `revealed` paragraphs are
 * shown and the rest hidden. Layout is untouched (visibility, not display),
 * so text never reflows as it builds.
 */
export function applyParagraphVisibility(stage: ParentNode, state: SlideState): void {
  for (const [id, revealed] of state.parts) {
    // jsdom builds may lack the CSS global; ids are quoted, so escaping only
    // has to worry about quotes and backslashes.
    const escaped = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(id)
      : id.replace(/[\\"]/g, '\\$&');
    const content = stage.querySelector<HTMLElement>(
      `[data-element-id="${escaped}"] .text-content`,
    );
    if (!content) continue;
    paragraphUnits(content).forEach((unit, i) => {
      unit.style.visibility = i < revealed ? '' : 'hidden';
    });
  }
}

/**
 * A block element the editor generated rather than the author: contenteditable
 * wraps what you type in a bare `<div>` with no attributes. Authored
 * containers (a flex row, a styled box) always carry class or style, so this
 * distinguishes an editing artefact from slide structure.
 */
function isEditorBlock(el: Element): boolean {
  return el.tagName === 'DIV' && el.attributes.length === 0;
}

/**
 * Flatten one container's children into a flat list of paragraph elements.
 *
 * Editor-generated `<div>`s become `<p>`, and a nested one is lifted to a
 * sibling: Chrome's return nests the tail of the text inside the block it
 * splits, which buries every later paragraph one level down, where neither the
 * build segmentation nor `--paragraph-spacing` (a rule on `.text-content`'s
 * own children) can see it. Elements the author wrote are passed through.
 */
function collectParagraphs(
  source: ParentNode & Node,
  out: HTMLElement[],
  generated: Set<HTMLElement>,
  splitBreaks: boolean,
): void {
  const doc = source.ownerDocument ?? document;
  let run: Node[] = [];
  /** `force` emits the empty paragraph a deliberate blank line asks for. */
  const flush = (force = false) => {
    if (run.length === 0 && !force) return;
    const p = doc.createElement('p');
    for (const node of run) p.appendChild(node);
    if (!hasContent([...p.childNodes])) p.replaceChildren(doc.createElement('br'));
    out.push(p);
    generated.add(p);
    run = [];
  };
  for (const child of [...source.childNodes]) {
    const el = child instanceof Element ? child : null;
    if (el && splitBreaks && el.tagName === 'BR') {
      // Legacy import markup separates paragraphs with `<br>`; make each side
      // a real block so return, spacing and builds all agree on the unit.
      flush(true);
      continue;
    }
    if (el && isEditorBlock(el)) {
      flush();
      // Splitting `a<br>b` leaves the old separator stranded at the head of
      // the new block, where it would read as a blank first line. It is the
      // break that just became this block, so drop it — unless it is all the
      // block holds, which is how a deliberate empty line is written.
      if (splitBreaks && el.firstChild instanceof Element
        && el.firstChild.tagName === 'BR' && el.childNodes.length > 1) {
        el.removeChild(el.firstChild);
      }
      collectParagraphs(el, out, generated, splitBreaks);
      continue;
    }
    if (el && BLOCK_TAGS.has(el.tagName)) {
      flush();
      out.push(el as HTMLElement);
      continue;
    }
    run.push(child);
  }
  flush();
}

/**
 * Rewrite text markup so that every paragraph is a top-level block of
 * `.text-content`.
 *
 * Called on the way into an edit (with `splitBreaks`, to promote imported
 * `<br>` separators to blocks) and on the way out (without it, so a deliberate
 * shift-return stays a soft break inside its paragraph).
 */
export function normalizeParagraphHtml(html: string, splitBreaks = false): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const paragraphs: HTMLElement[] = [];
  const generated = new Set<HTMLElement>();
  collectParagraphs(template.content, paragraphs, generated, splitBreaks);
  if (paragraphs.length === 0) return '';
  // One plain paragraph needs no wrapper: a single-line label stays the bare
  // markup it was imported as.
  const only = paragraphs.length === 1 ? paragraphs[0] : null;
  if (only && generated.has(only)) return only.innerHTML === '<br>' ? '' : only.innerHTML;
  const out = document.createElement('div');
  for (const p of paragraphs) out.appendChild(p);
  return out.innerHTML;
}
