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
export const LIST_MARKER_COLOR_ATTRIBUTE = 'data-list-marker-color';
export const LIST_MARKER_COLOR_PROPERTY = '--list-marker-color';
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
 * Convert paragraph markup to a bulleted list, one `<li>` per paragraph.
 * Legacy `<br>`-separated text is split the same way the editor would
 * (normalisation promotes each line to a block first).
 */
export function paragraphsToList(html: string, ordered = false): string {
  const template = document.createElement('template');
  template.innerHTML = normalizeParagraphHtml(html, true);
  const marker = ordered ? /^\s*(\d+)[.)]\s+/ : /^\s*[*-]\s+/;
  const children = [...template.content.children] as HTMLElement[];
  let start = children.findIndex((child) => marker.test(child.textContent ?? ''));
  if (start >= 0) {
    // A partially converted/imported numbered list sometimes has its first
    // typed marker stripped while the following paragraphs still say 2., 3.,
    // ... . When the selection begins with that paragraph, infer item 1.
    let inferredFirst = false;
    if (ordered && start === 1) {
      const firstMarked = marker.exec(children[start].textContent ?? '');
      if (firstMarked?.[1] === '2') {
        start = 0;
        inferredFirst = true;
      }
    }
    const run: HTMLElement[] = [];
    for (let i = start; i < children.length; i++) {
      if (!(inferredFirst && i === start) && !marker.test(children[i].textContent ?? '')) break;
      run.push(children[i]);
    }
    const list = document.createElement(ordered ? 'ol' : 'ul');
    if (ordered) {
      const first = marker.exec(run[inferredFirst ? 1 : 0].textContent ?? '');
      if (!inferredFirst && first?.[1] && first[1] !== '1') list.setAttribute('start', first[1]);
    }
    run[0].parentNode?.insertBefore(list, run[0]);
    for (const block of run) {
      const match = marker.exec(block.textContent ?? '');
      if (match) removeLeadingText(block, match[0].length);
      const li = document.createElement('li');
      for (const attr of [...block.attributes]) li.setAttribute(attr.name, attr.value);
      while (block.firstChild) li.appendChild(block.firstChild);
      list.appendChild(li);
      block.remove();
    }
    const out = document.createElement('div');
    out.append(template.content.cloneNode(true));
    return out.innerHTML;
  }
  const items = paragraphUnits(template.content)
    .map((unit) => `<li>${unit.innerHTML}</li>`)
    .join('');
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items || '<li>Item</li>'}</${tag}>`;
}

/** Convert paragraph markup to an ordered list. */
export function paragraphsToOrderedList(html: string): string {
  return paragraphsToList(html, true);
}

/** Whether the authored text contains a top-level bullet/numbered list. */
export function hasList(html: string, ordered: boolean): boolean {
  const template = document.createElement('template');
  template.innerHTML = html;
  const tag = ordered ? 'OL' : 'UL';
  return [...template.content.children].some((child) => child.tagName === tag);
}

export type ListMarkerColorState = {
  hasList: boolean;
  mixed: boolean;
  value: string | null;
};

/** The explicit marker paint shared by the list items in authored text. */
export function listMarkerColorState(html: string): ListMarkerColorState {
  const template = document.createElement('template');
  template.innerHTML = html;
  const items = [...template.content.querySelectorAll<HTMLElement>('li')];
  if (items.length === 0) return { hasList: false, mixed: false, value: null };
  const values = items.map((item) => item.hasAttribute(LIST_MARKER_COLOR_ATTRIBUTE)
    ? item.style.getPropertyValue(LIST_MARKER_COLOR_PROPERTY).trim() || null
    : null);
  const mixed = !values.every((value) => value === values[0]);
  return { hasList: true, mixed, value: mixed ? null : values[0] };
}

/** Set or clear marker paint on every list item without changing its text paint. */
export function setListMarkerColor(html: string, value: string | null): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const items = [...template.content.querySelectorAll<HTMLElement>('li')];
  if (items.length === 0) return html;
  for (const item of items) {
    if (value) {
      item.setAttribute(LIST_MARKER_COLOR_ATTRIBUTE, 'true');
      item.style.setProperty(LIST_MARKER_COLOR_PROPERTY, value);
    } else {
      item.removeAttribute(LIST_MARKER_COLOR_ATTRIBUTE);
      item.style.removeProperty(LIST_MARKER_COLOR_PROPERTY);
      if (!item.getAttribute('style')?.trim()) item.removeAttribute('style');
    }
  }
  const out = document.createElement('div');
  out.append(template.content.cloneNode(true));
  return out.innerHTML;
}

/** Switch an existing top-level list between bullets and numbers in place. */
export function changeListType(html: string, ordered: boolean): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const from = ordered ? 'UL' : 'OL';
  const to = ordered ? 'ol' : 'ul';
  let changed = false;
  for (const list of [...template.content.children]) {
    if (list.tagName !== from) continue;
    const replacement = document.createElement(to);
    for (const attr of [...list.attributes]) {
      if (!ordered && attr.name === 'start') continue;
      replacement.setAttribute(attr.name, attr.value);
    }
    while (list.firstChild) replacement.appendChild(list.firstChild);
    list.replaceWith(replacement);
    changed = true;
  }
  if (!changed) return ordered ? paragraphsToOrderedList(html) : paragraphsToList(html);
  const out = document.createElement('div');
  out.append(template.content.cloneNode(true));
  return out.innerHTML;
}

/** Delete a text prefix while retaining the inline formatting after it. */
function removeLeadingText(root: Element, count: number): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let remaining = count;
  for (const node of nodes) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, node.data.length);
    node.data = node.data.slice(take);
    remaining -= take;
  }
  root.querySelectorAll('span, font').forEach((node) => {
    if (!node.textContent && node.children.length === 0) node.remove();
  });
}

/** Build an editable table from the plain TSV flavour spreadsheet apps place
 *  beside their richer HTML clipboard data. Quoted cells may contain tabs or
 *  line breaks, and doubled quotes decode to one literal quote. */
function pastedTsvTable(text: string): HTMLTableElement | null {
  if (!text.includes('\t')) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/\r\n?/g, '\n');
  const finishCell = () => {
    row.push(cell);
    cell = '';
  };
  const finishRow = () => {
    finishCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === '\t' && !quoted) {
      finishCell();
    } else if (char === '\n' && !quoted) {
      finishRow();
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0 || !source.endsWith('\n')) finishRow();
  if (rows.length === 0 || Math.max(...rows.map((item) => item.length)) < 2) return null;

  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  for (const values of rows) {
    const tr = document.createElement('tr');
    for (const value of values) {
      const td = document.createElement('td');
      value.split('\n').forEach((line, index) => {
        if (index > 0) td.appendChild(document.createElement('br'));
        td.appendChild(document.createTextNode(line));
      });
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

export type PastedTableData = {
  html: string;
  /** Positive relative widths, one per logical column. */
  columnWidths: number[];
  rows: number;
};

const SAFE_TABLE_STYLES = new Set([
  'background-color', 'color', 'font-family', 'font-size', 'font-style',
  'font-weight', 'text-align', 'text-decoration', 'text-decoration-line',
  'vertical-align', 'white-space', 'border', 'border-color', 'border-style',
  'border-width', 'padding', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left',
]);

function positiveWidth(value: string | null | undefined): number | null {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Write a deterministic colgroup from relative column weights. */
export function applyTableColumnWidths(html: string, widths: number[]): string {
  if (widths.length === 0 || !/<table\b/i.test(html)) return html;
  const total = widths.reduce((sum, width) => sum + Math.max(0, width), 0) || widths.length;
  const group = `<colgroup>${widths.map((width) =>
    `<col style="width: ${Math.max(0, width) / total * 100}%;">`).join('')}</colgroup>`;
  const withoutGroup = html.replace(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup>/i, '');
  return withoutGroup.replace(/(<table\b[^>]*>)/i, `$1${group}`);
}

/** Extract and normalise one safe, editable table from a spreadsheet paste. */
export function pastedTableData(html: string, plainText = ''): PastedTableData | null {
  const template = document.createElement('template');
  template.innerHTML = html;
  const table = template.content.querySelector<HTMLTableElement>('table') ?? pastedTsvTable(plainText);
  if (!table) return null;
  const rows = [...table.rows];
  const columns = Math.max(0, ...rows.map((row) =>
    [...row.cells].reduce((count, cell) => count + Math.max(1, cell.colSpan), 0)));
  if (columns < 2) return null;

  const sourceCols = [...table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col')];
  let columnWidths = sourceCols.map((col) =>
    positiveWidth(col.style.width) ?? positiveWidth(col.getAttribute('width')) ?? 0);
  if (columnWidths.length !== columns || columnWidths.some((width) => width <= 0)) {
    const first = rows[0];
    columnWidths = first ? [...first.cells].flatMap((cell) => {
      const width = positiveWidth(cell.style.width) ?? positiveWidth(cell.getAttribute('width')) ?? 1;
      return Array.from({ length: Math.max(1, cell.colSpan) }, () => width / Math.max(1, cell.colSpan));
    }) : [];
  }
  if (columnWidths.length !== columns || columnWidths.some((width) => width <= 0)) {
    columnWidths = Array.from({ length: columns }, () => 1);
  }

  table.querySelectorAll('script, iframe, object, embed, link, style').forEach((node) => node.remove());
  [table, ...table.querySelectorAll<HTMLElement>('*')].forEach((node) => {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      if (/^(?:contenteditable|draggable)$/i.test(attr.name)) node.removeAttribute(attr.name);
      if (/^(?:src|href|xlink:href)$/i.test(attr.name)
        && /^\s*(?:javascript|data):/i.test(attr.value)) node.removeAttribute(attr.name);
    }
    node.removeAttribute('id');
    node.removeAttribute('class');
    if (node.matches('table, thead, tbody, tfoot, tr, colgroup, col')) {
      node.removeAttribute('style');
      node.removeAttribute('width');
      node.removeAttribute('height');
    } else if (node.hasAttribute('style')) {
      const properties = Array.from({ length: node.style.length }, (_, index) => node.style.item(index));
      for (const property of properties) {
        const value = node.style.getPropertyValue(property);
        if (!SAFE_TABLE_STYLES.has(property) || /url\s*\(/i.test(value)) {
          node.style.removeProperty(property);
        }
      }
      node.style.removeProperty('width');
      node.style.removeProperty('height');
      if (!node.getAttribute('style')?.trim()) node.removeAttribute('style');
    }
    if (node.matches('td, th')) {
      node.removeAttribute('width');
      node.removeAttribute('height');
    }
  });
  return {
    html: applyTableColumnWidths(table.outerHTML, columnWidths),
    columnWidths,
    rows: rows.length,
  };
}

/** Compatibility wrapper for callers that only need the safe HTML. */
export function pastedTableHtml(html: string, plainText = ''): string | null {
  return pastedTableData(html, plainText)?.html ?? null;
}

/**
 * Convert a bulleted list back to paragraph markup, one paragraph per item.
 * Normalisation keeps the single-paragraph case as bare inline markup.
 */
export function listToParagraphs(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  let changed = false;
  for (const list of [...template.content.children]) {
    if (!LIST_TAGS.has(list.tagName)) continue;
    const fragment = document.createDocumentFragment();
    for (const item of [...list.children]) {
      if (item.tagName !== 'LI') continue;
      const p = document.createElement('p');
      for (const attr of [...item.attributes]) {
        if (attr.name !== LIST_MARKER_COLOR_ATTRIBUTE) p.setAttribute(attr.name, attr.value);
      }
      p.style.removeProperty(LIST_MARKER_COLOR_PROPERTY);
      if (!p.getAttribute('style')?.trim()) p.removeAttribute('style');
      p.innerHTML = item.innerHTML;
      fragment.appendChild(p);
    }
    list.replaceWith(fragment);
    changed = true;
  }
  if (!changed) return html;
  const out = document.createElement('div');
  out.append(template.content.cloneNode(true));
  return out.innerHTML;
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
 * Chrome's indent command nests a list as a *sibling* of the `<li>`s
 * (`<ul><li>a</li><ul>…`), which is invalid HTML and invisible to the
 * paragraph segmentation above. Fold each such list into the `<li>` before
 * it, where nested lists belong.
 */
function nestStrayLists(root: ParentNode & Node): void {
  for (const list of [...root.querySelectorAll(':is(ul, ol) > :is(ul, ol)')]) {
    const prev = list.previousElementSibling;
    if (prev?.tagName === 'LI') {
      prev.appendChild(list);
    } else {
      // No item to attach to (indented the first bullet): give it one.
      const li = (root.ownerDocument ?? document).createElement('li');
      list.parentNode?.insertBefore(li, list);
      li.appendChild(list);
    }
  }
}

/** Contenteditable can split one list into adjacent sibling lists on Return. */
function mergeAdjacentLists(root: ParentNode & Node): void {
  let current = root.firstElementChild;
  while (current) {
    const next = current.nextElementSibling;
    if (next && LIST_TAGS.has(current.tagName) && next.tagName === current.tagName) {
      while (next.firstChild) current.appendChild(next.firstChild);
      next.remove();
      continue;
    }
    current = next;
  }
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
  nestStrayLists(template.content);
  mergeAdjacentLists(template.content);
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
