import { expect } from 'vitest';
import { Cdp, eventually } from './browserSession.js';

/**
 * Clipboard payloads authors really paste into a slide, and the machinery to
 * paste them through the real clipboard, act on the result, and check that the
 * box is still something the editor can render and edit.
 *
 * Every payload here is markup a real application writes: Apple Notes and
 * Word emit their own class soup, Google Docs wraps everything in a guid
 * `<b>`, spreadsheets emit tables, and web pages emit whatever they like —
 * including markup that is invalid in the editor's block model (a `<ul>` in a
 * `<ul>`, a list inside a `<p>`, an `<li>` with no list) or unsafe (scripts,
 * event handlers, `javascript:` URLs).
 */

export const PASTE_TEXT_ID = 'paste-fuzz-text';
export const PASTE_CONTENT = `#canvas [data-element-id="${PASTE_TEXT_ID}"] .text-content`;
export const PASTE_PANEL = '#inspector';
export const PASTE_MOD = process.platform === 'darwin' ? 4 : 2;

export interface ClipboardPayload {
  name: string;
  /** Omitted for a plain-text-only clipboard, as from a terminal or editor. */
  html?: string;
  text: string;
  /** Visible words that must survive the paste. */
  expected: string[];
}

const NOTES_BULLETS = [
  '<ul class="ul1">',
  '<li class="li1"><span class="s1"></span></li>',
  '<li class="li1"><span class="s1"></span></li>',
  '<li class="li1"><span class="s1"></span></li>',
  '<li class="li1"><span class="s1">learn about yourself to figure out what excites'
    + ' <i>you</i> more than anything else</span></li>',
  '<li class="li1"><span class="s1">Ideally, build a personal brad for that thing.</span></li>',
  '<li class="li1"><span class="s1">Grow as a person: learn taste in problems, learn to'
    + ' operate under extraordinary uncertainty. Hone your perseverance. </span></li>',
  '<ul class="ul2"><li class="li1"><span class="s1">Learn things about the world that'
    + ' nobody else knows yet!</span></li></ul>',
  '</ul>',
].join('');

export const PASTE_CORPUS: ClipboardPayload[] = [
  {
    // The reported case: empty bullets, an italic run, and a sub-bullet that
    // Notes writes as a `<ul>` directly inside the outer `<ul>`.
    name: 'apple-notes-bullets',
    html: NOTES_BULLETS,
    text: [
      '* ', '* ', '* ',
      '* learn about yourself to figure out what excites you more than anything else',
      '* Ideally, build a personal brad for that thing.',
      '* Grow as a person: learn taste in problems, learn to operate under extraordinary'
        + ' uncertainty. Hone your perseverance. ',
      '',
      '• ⁃ Learn things about the world that nobody else knows yet!',
    ].join('\n'),
    expected: ['learn about yourself', 'personal brad', 'perseverance', 'nobody else knows yet'],
  },
  {
    name: 'apple-notes-numbered',
    html: '<ol class="ol1"><li class="li1"><span class="s1">First step</span></li>'
      + '<li class="li1"><span class="s1">Second step</span></li>'
      + '<ol class="ol2"><li class="li1"><span class="s1">Nested detail</span></li></ol></ol>',
    text: '1. First step\n2. Second step\n\t1. Nested detail',
    expected: ['First step', 'Second step', 'Nested detail'],
  },
  {
    name: 'word-list-paragraphs',
    html: '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>'
      + '<!-- p.MsoNormal { margin: 0 } --></style></head><body>'
      + '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1">'
      + '<!--[if !supportLists]--><span style="mso-list:Ignore">·<span>&nbsp;&nbsp;</span>'
      + '</span><!--[endif]-->Quarterly revenue<o:p></o:p></p>'
      + '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1">'
      + '<!--[if !supportLists]--><span style="mso-list:Ignore">·<span>&nbsp;&nbsp;</span>'
      + '</span><!--[endif]-->Operating margin<o:p></o:p></p></body></html>',
    text: '·\tQuarterly revenue\n·\tOperating margin',
    expected: ['Quarterly revenue', 'Operating margin'],
  },
  {
    name: 'google-docs-list',
    html: '<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-abc">'
      + '<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px">'
      + '<li dir="ltr" style="list-style-type:disc;font-size:11pt"><p dir="ltr" role="presentation">'
      + '<span style="font-weight:700">Findings</span></p></li>'
      + '<li dir="ltr" style="list-style-type:disc"><p dir="ltr" role="presentation">'
      + '<span>Latency dropped by half</span></p></li></ul></b>',
    text: 'Findings\nLatency dropped by half',
    expected: ['Findings', 'Latency dropped by half'],
  },
  {
    name: 'spreadsheet-table',
    html: '<google-sheets-html-origin><table><tbody>'
      + '<tr><td>Quarter</td><td>Revenue</td></tr>'
      + '<tr><td>Q1</td><td>1,250</td></tr></tbody></table>',
    text: 'Quarter\tRevenue\nQ1\t1,250',
    expected: ['Quarter', 'Revenue', 'Q1'],
  },
  {
    name: 'plain-text-markers',
    text: '* First bullet\n* Second bullet\n\n1. First step\n2. Second step\n- dashed item',
    expected: ['First bullet', 'Second bullet', 'First step', 'dashed item'],
  },
  {
    name: 'plain-text-single-line',
    text: 'One single pasted line',
    expected: ['One single pasted line'],
  },
  {
    name: 'plain-text-blank-lines',
    text: 'Above\n\n\n\nBelow',
    expected: ['Above', 'Below'],
  },
  {
    name: 'web-page-headings',
    html: '<div><h1>Chapter one</h1><h2>Background</h2><p>Body text with a '
      + '<a href="https://example.com/docs">link</a> and <strong>bold</strong>.</p>'
      + '<div>Loose div line<br>after a break</div></div>',
    text: 'Chapter one\nBackground\nBody text with a link and bold.\nLoose div line\nafter a break',
    expected: ['Chapter one', 'Background', 'Body text', 'Loose div line'],
  },
  {
    name: 'unsafe-markup',
    html: '<div>Before<script>window.__pasteOwned = true;</script>'
      + '<img src="x" onerror="window.__pasteOwned = true">'
      + '<a href="javascript:window.__pasteOwned = true">click me</a>'
      + '<iframe src="https://example.com"></iframe><p onclick="window.__pasteOwned = true">'
      + 'After</p></div>',
    text: 'Before\nclick me\nAfter',
    expected: ['Before', 'After'],
  },
  {
    name: 'deeply-nested-mixed-lists',
    html: '<ul><li>Top<ol><li>Second level<ul><li>Third level</li></ul></li></ol></li>'
      + '<li>Back to top</li></ul>',
    text: 'Top\n\tSecond level\n\t\tThird level\nBack to top',
    expected: ['Top', 'Second level', 'Third level', 'Back to top'],
  },
  {
    name: 'stray-list-and-orphan-item',
    html: '<ul><ul><li>Orphaned sub item</li></ul></ul><li>Item with no list</li>',
    text: 'Orphaned sub item\nItem with no list',
    expected: ['Orphaned sub item', 'Item with no list'],
  },
  {
    name: 'paragraphs-inside-items',
    html: '<ul><li><p>Paragraph in an item</p><p>Second paragraph</p></li>'
      + '<li><div>Div in an item</div></li></ul>',
    text: 'Paragraph in an item\nSecond paragraph\nDiv in an item',
    expected: ['Paragraph in an item', 'Second paragraph', 'Div in an item'],
  },
  {
    name: 'preformatted-code',
    html: '<pre><code>const total = items.reduce((sum, x) =&gt; sum + x, 0);\n'
      + 'if (total &lt; 10) return null;</code></pre>',
    text: 'const total = items.reduce((sum, x) => sum + x, 0);\nif (total < 10) return null;',
    expected: ['const total', 'return null'],
  },
  {
    name: 'entities-and-emoji',
    html: '<p>Ampersand &amp; angle &lt;brackets&gt;, non-breaking&nbsp;space, emoji 🎉,'
      + ' RTL עברית, and a soft­hyphen.</p>',
    text: 'Ampersand & angle <brackets>, non-breaking space, emoji 🎉,'
      + ' RTL עברית, and a soft­hyphen.',
    expected: ['Ampersand', 'brackets', '🎉'],
  },
  {
    name: 'own-editor-markup',
    html: '<p style="text-align: center"><span style="font-style: italic">Copied</span>'
      + ' from another <span style="font-weight: 700">slide</span></p>'
      + '<ul><li><span class="keep">Bulleted line</span></li></ul>',
    text: 'Copied from another slide\nBulleted line',
    expected: ['Copied from another slide', 'Bulleted line'],
  },
  {
    name: 'whitespace-only',
    html: '<p>   </p><p>&nbsp;</p>',
    text: '   \n \n',
    expected: [],
  },
];

export type PasteTarget =
  | 'placeholder'
  | 'caret-at-end'
  | 'inside-word'
  | 'over-selection'
  | 'inside-list-item'
  | 'inside-table-cell';

export const PASTE_TARGETS: PasteTarget[] = [
  'placeholder',
  'caret-at-end',
  'inside-word',
  'over-selection',
  'inside-list-item',
  'inside-table-cell',
];

/**
 * What an author does to pasted text once it has landed. Every case runs a
 * seeded sequence of these, and the invariants are checked after each one:
 * pasted markup that only looks fine until it is formatted is the whole point
 * of this suite.
 */
export type PasteOperation =
  | { kind: 'list'; style: 'Bulleted' | 'Numbered' | 'None' }
  | { kind: 'inline'; format: 'bold' | 'italic' | 'underline'; route: 'shortcut' | 'button' }
  | { kind: 'align'; alignment: 'left' | 'center' | 'right' | 'justify' }
  | { kind: 'type'; text: string }
  | { kind: 'delete'; characters: number }
  | { kind: 'delete-word' }
  | { kind: 'split'; text: string }
  | { kind: 'undo' };

export const PASTE_OPERATIONS: PasteOperation[] = [
  { kind: 'list', style: 'Bulleted' },
  { kind: 'list', style: 'Numbered' },
  { kind: 'list', style: 'None' },
  { kind: 'inline', format: 'bold', route: 'shortcut' },
  { kind: 'inline', format: 'bold', route: 'button' },
  { kind: 'inline', format: 'italic', route: 'shortcut' },
  { kind: 'inline', format: 'italic', route: 'button' },
  { kind: 'inline', format: 'underline', route: 'shortcut' },
  { kind: 'inline', format: 'underline', route: 'button' },
  { kind: 'align', alignment: 'left' },
  { kind: 'align', alignment: 'center' },
  { kind: 'align', alignment: 'right' },
  { kind: 'align', alignment: 'justify' },
  { kind: 'type', text: ' appended' },
  { kind: 'type', text: ' 42' },
  { kind: 'delete', characters: 3 },
  { kind: 'delete-word' },
  { kind: 'split', text: 'new line' },
  { kind: 'undo' },
];

export function describeOperation(operation: PasteOperation): string {
  switch (operation.kind) {
    case 'list': return `list \u2192 ${operation.style}`;
    case 'inline': return `${operation.format} by ${operation.route}`;
    case 'align': return `align ${operation.alignment}`;
    case 'type': return `type ${JSON.stringify(operation.text)}`;
    case 'delete': return `backspace \u00d7${operation.characters}`;
    case 'delete-word': return 'delete a selected word';
    case 'split': return `Enter then type ${JSON.stringify(operation.text)}`;
    case 'undo': return 'undo';
  }
}

/** The element markup each paste target starts from. */
export const TARGET_FIXTURES: Record<PasteTarget, { html: string; classes: string[] }> = {
  placeholder: { html: '<p>Text</p>', classes: ['role-body', 'placeholder'] },
  'caret-at-end': { html: '<p>Existing first line</p><p>Existing second line</p>', classes: ['role-body'] },
  'inside-word': { html: '<p>Interruption lands midword here</p>', classes: ['role-body'] },
  'over-selection': { html: '<p>Replace selected word entirely</p>', classes: ['role-body'] },
  'inside-list-item': {
    html: '<ul><li>First existing item</li><li>Second existing item</li></ul>',
    classes: ['role-body'],
  },
  'inside-table-cell': {
    html: '<table><tbody><tr><td>Alpha</td><td>Beta</td></tr>'
      + '<tr><td>Gamma</td><td>Delta</td></tr></tbody></table>',
    classes: ['role-body'],
  },
};

export interface PasteCase {
  payload: ClipboardPayload;
  target: PasteTarget;
  operations: PasteOperation[];
}

/** A small, reproducible pseudo-random source. */
function random(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * Case order: every payload against every target on demand, or a seeded spread
 * that still crosses every payload and every target by default. Each case
 * carries its own seeded sequence of edits to run on the pasted text.
 */
export function pasteCases(options: {
  exhaustive: boolean;
  sample: number;
  operationsPerCase: number;
  seed?: number;
}): PasteCase[] {
  const { exhaustive, sample, operationsPerCase, seed = 20260831 } = options;
  const next = random(seed);
  const sequence = () => Array.from(
    { length: operationsPerCase },
    () => PASTE_OPERATIONS[Math.floor(next() * PASTE_OPERATIONS.length)],
  );
  if (exhaustive) {
    return PASTE_CORPUS.flatMap((payload) => PASTE_TARGETS.map((target) => ({
      payload, target, operations: sequence(),
    })));
  }
  return Array.from({ length: sample }, (_, index) => ({
    payload: PASTE_CORPUS[index % PASTE_CORPUS.length],
    target: PASTE_TARGETS[index % PASTE_TARGETS.length],
    operations: sequence(),
  }));
}

/** Put both clipboard flavours on the real clipboard and press Cmd/Ctrl+V. */
export async function pasteFromClipboard(cdp: Cdp, payload: ClipboardPayload): Promise<void> {
  const written = await cdp.evaluate<string>(`(async () => {
    try {
      const items = { 'text/plain': new Blob([${JSON.stringify(payload.text)}], { type: 'text/plain' }) };
      ${payload.html === undefined ? '' : `items['text/html'] = new Blob([${JSON.stringify(payload.html)}], { type: 'text/html' });`}
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return 'ok';
    } catch (error) {
      return String(error);
    }
  })()`);
  if (written !== 'ok') throw new Error(`could not write the clipboard: ${written}`);
  await cdp.chord('v', 'KeyV', 86, PASTE_MOD, ['paste']);
}

/**
 * Structural and safety rules the box must satisfy after any paste or edit.
 * These are the shapes the renderer, the block model and the exporters assume;
 * markup that breaks them is what makes a pasted list impossible to convert,
 * or a paragraph impossible to align.
 */
export const MARKUP_INVARIANTS = `(root) => {
  const problems = [];
  const check = (selector, message) => {
    if (root.querySelector(selector)) problems.push(message);
  };
  check(':is(ul, ol) > :is(ul, ol)', 'a list is nested directly inside a list');
  check('p :is(ul, ol)', 'a list is inside a paragraph');
  check('p > p, p > div, li > li, p > table', 'a block is nested inside a block that cannot contain it');
  check('script, iframe, object, embed, style, link, meta, base, form, input', 'unsafe or document-level markup survived');
  check('font, marquee', 'legacy markup survived');
  for (const node of root.querySelectorAll('li')) {
    const parent = node.parentElement;
    if (!parent || !/^(UL|OL)$/.test(parent.tagName)) problems.push('a list item is outside a list');
  }
  for (const node of root.querySelectorAll('*')) {
    for (const attribute of node.attributes) {
      if (/^on/i.test(attribute.name)) problems.push('event handler attribute ' + attribute.name);
      if (/^\\s*javascript:/i.test(attribute.value)) problems.push('javascript: url survived');
    }
  }
  for (const child of root.children) {
    if (!/^(P|UL|OL|TABLE|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/.test(child.tagName)) {
      problems.push('top-level ' + child.tagName + ' is not a block the editor can format');
    }
  }
  return [...new Set(problems)];
}`;

export async function markupProblems(cdp: Cdp, selector: string): Promise<string[]> {
  return cdp.evaluate<string[]>(`(() => {
    const check = ${MARKUP_INVARIANTS};
    const root = document.querySelector(${JSON.stringify(selector)});
    return root ? check(root) : ['the text box is gone'];
  })()`);
}

/** The same rules applied to the markup the collaboration server persisted. */
export async function persistedMarkupProblems(cdp: Cdp, html: string): Promise<string[]> {
  return cdp.evaluate<string[]>(`(() => {
    const check = ${MARKUP_INVARIANTS};
    const template = document.createElement('template');
    template.innerHTML = ${JSON.stringify(html)};
    const root = document.createElement('div');
    root.append(...template.content.childNodes);
    return check(root);
  })()`);
}

/** Collapse a *text* value for comparison — never used on markup, because
 * pasted prose legitimately contains characters like `<brackets>`. */
export function normalizeText(value: string): string {
  return value
    .replaceAll('\u2060', '')
    .replaceAll('\u00a0', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip markup, then collapse. Only for HTML strings. */
export function visibleText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('⁠', '')
    .replaceAll(' ', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function contentText(cdp: Cdp, selector: string): Promise<string> {
  return normalizeText(await cdp.evaluate<string>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
  ));
}

export async function enterEditing(cdp: Cdp, selector: string): Promise<void> {
  await cdp.doubleClickText(selector, 'text box');
  await eventually(async () => cdp.evaluate<boolean>(
    `document.querySelector(${JSON.stringify(selector)})?.isContentEditable === true`,
  ), 'the text box did not enter editing');
}

export async function tagListField(cdp: Cdp): Promise<string> {
  const found = await cdp.evaluate<boolean>(`(() => {
    const field = [...document.querySelectorAll('${PASTE_PANEL} label.field')]
      .find((node) => node.querySelector('span')?.textContent === 'List');
    const select = field?.querySelector('select');
    if (!select) return false;
    select.id = 'paste-fuzz-list-field';
    return true;
  })()`);
  expect(found, 'the inspector List control is missing').toBe(true);
  return '#paste-fuzz-list-field';
}
