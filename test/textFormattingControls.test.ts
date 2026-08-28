// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { wireCanvasInspector } from '../src/renderer/editor/shellWiring.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { closePopover } from '../src/renderer/editor/ui.js';

/**
 * Text formatting driven the way an author drives it: every assertion below
 * follows a real click (or a real `change` on a control the author typed into)
 * on the shipping inspector, mounted next to the shipping canvas. Nothing here
 * calls `store.updateSelected` directly, so a control that stops being wired —
 * or a typed property the in-place restyle pass forgets to repaint — fails the
 * test even though the underlying data model still works.
 *
 * The browser collaboration edition mounts this same `Inspector` next to the
 * same `EditorCanvas`; `test/collabBrowserSmoke.test.ts` drives these controls
 * with real OS-level mouse clicks in a production browser build.
 */

/** jsdom lacks the observers, pointer events, and asset bridge the canvas uses. */
function installDomShims(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!('PointerEvent' in globalThis)) {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
  }
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value: () => {} });
    }
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
    pathForFile: () => '',
    importAssets: async () => [],
  } as never;
}

function textElement(id: string, overrides: Partial<SlideElement> = {}): SlideElement {
  return {
    id,
    type: 'text',
    x: 100,
    y: 100,
    w: 600,
    h: 200,
    rot: 0,
    z: 1,
    opacity: 1,
    class: [],
    style: {},
    html: 'First line',
    align: 'left',
    valign: 'middle',
    ...overrides,
  } as SlideElement;
}

/**
 * The real theme palette host: `createThemePanel` publishes the theme's colours
 * into this datalist, and the colour picker reads its swatches from there.
 */
function installThemePalette(colors: string[]): void {
  const list = document.createElement('datalist');
  list.id = 'theme-swatches';
  for (const color of colors) {
    const option = document.createElement('option');
    option.value = color;
    list.appendChild(option);
  }
  document.body.appendChild(list);
}

interface Harness {
  store: EditorStore;
  canvas: EditorCanvas;
  inspector: Inspector;
  canvasHost: HTMLElement;
  inspectorHost: HTMLElement;
}

function setup(elements: SlideElement[], deckPatch: (deck: Deck) => void = () => {}): Harness {
  installDomShims();
  const deck = emptyDeck('Text formatting');
  deck.slides[0].elements = elements;
  deckPatch(deck);

  const canvasHost = document.createElement('div');
  const inspectorHost = document.createElement('aside');
  document.body.replaceChildren(canvasHost, inspectorHost);
  installThemePalette(['#112233', '#ff8800']);

  const store = new EditorStore(deck, '/tmp/deck');
  const canvas = new EditorCanvas(canvasHost, store);
  const inspector = new Inspector(inspectorHost, store);
  wireCanvasInspector(canvas, inspector);
  store.select(elements.map((element) => element.id));
  return { store, canvas, inspector, canvasHost, inspectorHost };
}

/* --- click helpers: query fresh, because the inspector rebuilds on commit --- */

const alignButtons = (host: HTMLElement): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>('.align-button')];

/** The inspector labels fields with a leading `<span>`; find one by its text. */
function field(host: HTMLElement, label: string): HTMLElement {
  const match = [...host.querySelectorAll<HTMLElement>('.field')]
    .find((node) => node.querySelector('span')?.textContent === label);
  if (!match) {
    const available = [...host.querySelectorAll<HTMLElement>('.field span')]
      .map((node) => node.textContent).join(', ');
    throw new Error(`no inspector field labelled "${label}" (have: ${available})`);
  }
  return match;
}

const listSelect = (host: HTMLElement): HTMLSelectElement =>
  field(host, 'List').querySelector<HTMLSelectElement>('select')!;

const textOf = (store: EditorStore, id: string): Extract<SlideElement, { type: 'text' }> => {
  const element = store.slide!.elements.find((candidate) => candidate.id === id)!;
  if (element.type !== 'text') throw new Error(`${id} is not text`);
  return element;
};

const bodyOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-element-id="${id}"] .text-body`)!;

const contentOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-element-id="${id}"] .text-content`)!;

const nodeOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!;

const TABLE_WORD_HTML =
  '<table><tbody><tr><td>alpha beta</td><td>gamma</td></tr></tbody></table>';

function selectTableWord(canvas: EditorCanvas, canvasHost: HTMLElement): {
  content: HTMLElement;
  cell: HTMLTableCellElement;
} {
  canvas.beginTextEdit('text-1');
  const content = contentOf(canvasHost, 'text-1');
  const cell = content.querySelector<HTMLTableCellElement>('td')!;
  cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  const text = cell.firstChild!;
  const range = document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 10);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return { content, cell };
}

function savedTable(store: EditorStore): HTMLElement {
  const saved = document.createElement('div');
  saved.innerHTML = textOf(store, 'text-1').html;
  return saved;
}

/** Type a value into a control and fire the `change` the browser would fire. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function pick(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('text formatting from the inspector controls', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  it('keeps the exhaustive formatting matrix synchronized with the shipped text and table controls', () => {
    const normal = setup([textElement('text-1', { html: '<p>First</p><p>Second</p>' })]);
    normal.canvas.beginTextEdit('text-1');
    const labels = (selector: string) => [...normal.inspectorHost.querySelectorAll<HTMLElement>(selector)]
      .map((node) => node.textContent?.trim());

    expect(labels('.text-typography-options .field > span')).toEqual([
      'Font family', 'Font size', 'Font weight', 'Role', 'Colour',
    ]);
    expect(labels('.text-layout-options .field > span')).toEqual([
      'Auto-fit text to box', 'Disable automatic line breaks', 'List',
      'Align', 'Vertical', 'Paragraph spacing',
    ]);
    expect(labels('.text-format-buttons button')).toEqual(['B', 'I', 'U']);
    expect(labels('.number-step-buttons button')).toEqual(['▲', '▼', '▲', '▼', '▲', '▼']);

    const table = setup([textElement('table-1', {
      html: '<table><tbody><tr><td>A</td><td>B</td></tr>'
        + '<tr><td>C</td><td>D</td></tr></tbody></table>',
    })]);
    table.canvas.beginTextEdit('table-1');
    contentOf(table.canvasHost, 'table-1').querySelector('td')!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    const tableLabels = (selector: string) => [...table.inspectorHost.querySelectorAll<HTMLElement>(selector)]
      .map((node) => node.textContent?.trim());
    expect(table.inspectorHost.querySelector('.table-scope-buttons')).toBeNull();
    expect(tableLabels('.text-table-options .field > span')).toEqual([
      'Cell fill', 'Cell text', 'Border color', 'Border width',
    ]);
    expect(tableLabels('.table-border-buttons button')).toEqual([
      'No borders', 'Vertical borders', 'Horizontal borders', 'Draw borders',
    ]);
    expect(tableLabels('.table-column-buttons button')).toEqual([
      'Insert before', 'Insert after', 'Delete column',
    ]);
  });

  it('sets every horizontal alignment, repaints the canvas, and shows the pressed state', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);

    expect(alignButtons(inspectorHost).map((button) => button.title))
      .toEqual(['Align left', 'Align centre', 'Align right', 'Justify']);

    const expected = [
      ['left', ['true', 'false', 'false', 'false']],
      ['center', ['false', 'true', 'false', 'false']],
      ['right', ['false', 'false', 'true', 'false']],
      ['justify', ['false', 'false', 'false', 'true']],
    ] as const;
    for (const [index, [align, pressed]] of expected.entries()) {
      alignButtons(inspectorHost)[index].click();
      expect(textOf(store, 'text-1').align).toBe(align);
      expect(bodyOf(canvasHost, 'text-1').style.textAlign).toBe(align);
      expect(alignButtons(inspectorHost).map((button) => button.getAttribute('aria-pressed')))
        .toEqual(pressed);
    }
  });

  it('sets vertical alignment and repaints the canvas flex placement', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);
    const vertical = () => field(inspectorHost, 'Vertical').querySelector('select')!;
    expect(vertical().value).toBe('middle');
    expect([...vertical().options].map((option) => option.value))
      .toEqual(['top', 'middle', 'bottom']);

    for (const [valign, justify] of [
      ['top', 'flex-start'], ['bottom', 'flex-end'], ['middle', 'center'],
    ] as const) {
      pick(vertical(), valign);
      expect(textOf(store, 'text-1').valign).toBe(valign);
      expect(bodyOf(canvasHost, 'text-1').style.justifyContent).toBe(justify);
    }
  });

  it('picks a theme colour swatch, then clears back to the theme default', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);
    const trigger = () => field(inspectorHost, 'Colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!;

    trigger().click();
    const swatches = [...document.querySelectorAll<HTMLButtonElement>('.color-picker-palette-button')];
    expect(swatches.map((swatch) => swatch.title)).toEqual(['#112233', '#ff8800']);
    swatches[0].click();

    expect(textOf(store, 'text-1').style.color).toBe('#112233');
    expect(bodyOf(canvasHost, 'text-1').closest<HTMLElement>('[data-element-id]')!.style.color)
      .toBe('rgb(17, 34, 51)');

    closePopover();
    trigger().click();
    const clear = document.querySelector<HTMLButtonElement>('.color-picker-clear')!;
    expect(clear.textContent).toBe('Use inherited text color');
    clear.click();
    expect(textOf(store, 'text-1').style.color).toBeUndefined();
  });

  it('sets an arbitrary colour from the hex box and keeps opacity as authored', () => {
    const { store, inspectorHost } = setup([textElement('text-1')]);
    field(inspectorHost, 'Colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();

    const picker = document.querySelector<HTMLElement>('.color-picker-popover')!;
    type(picker.querySelector<HTMLInputElement>('input[aria-label="Hex color"]')!, '#3366cc');
    expect(textOf(store, 'text-1').style.color).toBe('#3366cc');

    // Dragging the opacity slider previews live and commits when released.
    const opacity = picker.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!;
    opacity.value = '50';
    opacity.dispatchEvent(new Event('input', { bubbles: true }));
    expect(textOf(store, 'text-1').style.color).toBe('#3366cc');
    opacity.dispatchEvent(new Event('change', { bubbles: true }));
    expect(textOf(store, 'text-1').style.color).toBe('rgba(51, 102, 204, 0.5)');
  });

  it('turns paragraphs into a bulleted list and back from the list dropdown', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First</p><p>Second</p>' }),
    ]);
    expect(listSelect(inspectorHost).value).toBe('None');

    pick(listSelect(inspectorHost), 'Bulleted');
    expect(textOf(store, 'text-1').html).toBe('<ul><li>First</li><li>Second</li></ul>');
    expect([...bodyOf(canvasHost, 'text-1').querySelectorAll('li')].map((li) => li.textContent))
      .toEqual(['First', 'Second']);
    expect(listSelect(inspectorHost).value).toBe('Bulleted');

    pick(listSelect(inspectorHost), 'None');
    expect(textOf(store, 'text-1').html).toBe('<p>First</p><p>Second</p>');
    expect(bodyOf(canvasHost, 'text-1').querySelectorAll('li')).toHaveLength(0);
    expect(listSelect(inspectorHost).value).toBe('None');
  });

  it('turns paragraphs into a numbered list and keeps it distinct from bullets', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First</p><p>Second</p>' }),
    ]);
    expect(listSelect(inspectorHost).value).toBe('None');

    pick(listSelect(inspectorHost), 'Numbered');
    expect(textOf(store, 'text-1').html).toBe('<ol><li>First</li><li>Second</li></ol>');
    expect(bodyOf(canvasHost, 'text-1').querySelectorAll('ol > li')).toHaveLength(2);
    expect(listSelect(inspectorHost).value).toBe('Numbered');

    pick(listSelect(inspectorHost), 'Bulleted');
    expect(textOf(store, 'text-1').html).toBe('<ul><li>First</li><li>Second</li></ul>');
    expect(listSelect(inspectorHost).value).toBe('Bulleted');
  });

  it.each([
    ['Bulleted', 'ul'],
    ['Numbered', 'ol'],
  ] as const)('keeps a multi-paragraph text selection alive while choosing %s', (style, tag) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First</p><p>Second</p><p>Third</p>' }),
    ]);
    canvas.beginTextEdit('text-1');
    const body = bodyOf(canvasHost, 'text-1');
    const paragraphs = body.querySelectorAll('p');
    const range = document.createRange();
    range.setStartBefore(paragraphs[0]);
    range.setEndAfter(paragraphs[2]);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    pick(listSelect(inspectorHost), style);

    expect(textOf(store, 'text-1').html).toBe(
      `<${tag}><li>First</li><li>Second</li><li>Third</li></${tag}>`,
    );
    expect(body.querySelectorAll(`${tag} > li`)).toHaveLength(3);
    expect(listSelect(inspectorHost).value).toBe(style);
    expect(canvas.isEditing()).toBe(true);
    expect(inspectorHost.querySelector('.text-selection-style')).not.toBeNull();
  });

  it.each([
    ['Bulleted', 'ul'],
    ['None', null],
  ] as const)('changes a whole numbered list to %s when only one word is selected', (style, tag) => {
    const original = '<p>Heading</p><ol start="3" class="steps">'
      + '<li><strong>First</strong> item</li><li><em>Second</em> item</li></ol><p>Footer</p>';
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const word = style === 'Bulleted'
      ? content.querySelector('strong')!.firstChild!
      : content.querySelector('em')!.firstChild!;
    const range = document.createRange();
    range.setStart(word, 0);
    range.setEnd(word, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    expect(listSelect(inspectorHost).value).toBe('Numbered');
    pick(listSelect(inspectorHost), style);

    const saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    expect(saved.children[0].outerHTML).toBe('<p>Heading</p>');
    expect(saved.children[saved.children.length - 1].outerHTML).toBe('<p>Footer</p>');
    expect(saved.textContent).toBe('HeadingFirst itemSecond itemFooter');
    expect(saved.querySelectorAll('strong, em')).toHaveLength(2);
    if (tag) {
      expect(saved.querySelectorAll(`${tag}.steps > li`)).toHaveLength(2);
      expect(saved.querySelector(tag)?.hasAttribute('start')).toBe(false);
    } else {
      expect(saved.querySelectorAll('ol, ul')).toHaveLength(0);
      expect(saved.querySelectorAll(':scope > p')).toHaveLength(4);
    }

    contentOf(canvasHost, 'text-1').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it.each([
    ['Bold (Cmd/Ctrl+B)', 'fontWeight', '700'],
    ['Italic (Cmd/Ctrl+I)', 'fontStyle', 'italic'],
    ['Underline (Cmd/Ctrl+U)', 'textDecorationLine', 'underline'],
  ] as const)('formats one selected word with the %s button and undoes it', (
    label, property, expected,
  ) => {
    const original = '<ol><li>First item</li><li>Second item</li></ol>';
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const text = content.querySelector('li')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const choice = inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    const pointerDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    expect(choice.dispatchEvent(pointerDown)).toBe(false);
    choice.click();

    const span = content.querySelector<HTMLSpanElement>('li span')!;
    expect(span.textContent).toBe('First');
    expect(span.style[property]).toBe(expected);
    expect(content.querySelectorAll('ol')).toHaveLength(1);
    expect(content.querySelectorAll('li')).toHaveLength(2);
    expect(inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .getAttribute('aria-pressed')).toBe('true');

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
    expect(canvas.isEditing()).toBe(true);
    expect(window.getSelection()!.toString()).toBe('First');
    expect(window.getSelection()!.isCollapsed).toBe(false);
    expect(inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .getAttribute('aria-pressed')).toBe('false');
  });

  it('shows computed theme font size and weight until an override is authored', () => {
    const style = document.createElement('style');
    style.textContent = '.role-body .text-content { font-size: 42px; font-weight: 500; }';
    document.head.appendChild(style);
    const { inspectorHost } = setup([
      textElement('text-1', { class: ['role-body'], style: {} }),
    ]);
    const size = field(inspectorHost, 'Font size');
    const weight = field(inspectorHost, 'Font weight');
    expect(size.querySelector<HTMLInputElement>('input')!.value).toBe('42');
    expect(weight.querySelector<HTMLInputElement>('input')!.value).toBe('500');
    expect(size.querySelector('.theme-value-indicator')?.textContent).toBe('(Theme)');
    expect(weight.querySelector('.theme-value-indicator')?.textContent).toBe('(Theme)');
    style.remove();
  });

  it('names the resolved theme font in the family selector', () => {
    const style = document.createElement('style');
    style.textContent = '.role-body .text-content { font-family: Avenir, sans-serif; }';
    document.head.appendChild(style);
    const { inspectorHost } = setup([
      textElement('text-1', { class: ['role-body'], style: {} }),
    ]);
    const select = field(inspectorHost, 'Font family').querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent).toBe('Avenir (Theme)');
    style.remove();
  });

  it('shows font sizes with at most one decimal and normalizes edited sizes', () => {
    const { store, inspectorHost } = setup([
      textElement('text-1', { style: { 'font-size': '42.267px' } }),
    ]);
    const input = field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('42.3');

    type(input, '38.76');
    expect(textOf(store, 'text-1').style['font-size']).toBe('38.8px');
    expect(field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!.value)
      .toBe('38.8');
  });

  it('keeps the authored font-size ceiling in the field and identifies a reduced AutoFit size', () => {
    const { inspector, canvasHost, inspectorHost } = setup([
      textElement('text-1', { autoFit: true, style: { 'font-size': '44px' } }),
    ]);
    const content = contentOf(canvasHost, 'text-1');
    content.style.fontSize = '19.94px';
    content.dataset.fittedFontSize = '19.94';
    inspector.render();

    expect(field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!.value).toBe('44');
    const status = field(inspectorHost, 'Font size').querySelector<HTMLElement>('.auto-fit-value')!;
    expect(status.textContent).toBe('Fitted to 19.9 px');
    expect(status.title).toBe(
      'Auto-fit reduced the displayed text from 44 px to 19.9 px to fit this box.',
    );
  });

  it.each([
    ['Font size', '44', 'fontSize', '44px'],
    ['Font weight', '650', 'fontWeight', '650'],
  ] as const)('keeps a selected word while changing %s through its number input', (
    label, value, property, expected,
  ) => {
    const original = '<p>First paragraph</p><p>Second paragraph</p>';
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const text = content.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const input = field(inspectorHost, label).querySelector<HTMLInputElement>('input')!;
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: input }));
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const span = content.querySelector<HTMLSpanElement>('span')!;
    expect(span.textContent).toBe('First');
    expect(span.style[property]).toBe(expected);
    expect(canvas.isEditing()).toBe(true);
    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it('keeps the selected paragraph while changing paragraph spacing through its number input', () => {
    const original = '<p>First paragraph</p><p>Second paragraph</p>';
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const text = content.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const input = field(inspectorHost, 'Paragraph spacing').querySelector<HTMLInputElement>('input')!;
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: input }));
    input.value = '32';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const paragraphs = content.querySelectorAll<HTMLParagraphElement>('p');
    expect(paragraphs[0].style.marginBottom).toBe('32px');
    expect(paragraphs[1].style.marginBottom).toBe('');
    expect(field(inspectorHost, 'Paragraph spacing').querySelector<HTMLInputElement>('input')!.value)
      .toBe('32');
    expect(textOf(store, 'text-1').paragraphSpacing).toBeUndefined();
    expect(canvas.isEditing()).toBe(true);
    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it('changes every cell font size when the whole table object is selected and undoes exactly', () => {
    const original = '<table><tbody><tr><td style="font-size: 18px">A</td><td>B</td></tr>'
      + '<tr><td>C</td><td style="font-size: 20px">D</td></tr></tbody></table>';
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: original }),
    ]);

    type(field(inspectorHost, 'Font size').querySelector<HTMLInputElement>('input')!, '48');
    const element = textOf(store, 'text-1');
    expect(element.style['font-size']).toBe('48px');
    const saved = document.createElement('div');
    saved.innerHTML = element.html;
    expect([...saved.querySelectorAll<HTMLElement>('td')].map((cell) => cell.style.fontSize))
      .toEqual(['48px', '48px', '48px', '48px']);
    expect([...contentOf(canvasHost, 'text-1').querySelectorAll<HTMLElement>('td')]
      .map((cell) => getComputedStyle(cell).fontSize)).toEqual(['48px', '48px', '48px', '48px']);

    store.undo();
    expect(textOf(store, 'text-1').html).toBe(original);
    expect(textOf(store, 'text-1').style['font-size']).toBeUndefined();
  });

  it.each([
    ['b', 'font-weight: 700'],
    ['i', 'font-style: italic'],
    ['u', 'text-decoration-line: underline'],
  ] as const)('applies Cmd/Ctrl+%s to a selected word and undoes it once', (key, marker) => {
    const original = '<p>First paragraph</p><p>Second paragraph</p>';
    const { store, canvas, canvasHost } = setup([textElement('text-1', { html: original })]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const text = content.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const shortcut = new KeyboardEvent('keydown', {
      key, metaKey: true, bubbles: true, cancelable: true,
    });
    content.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(textOf(store, 'text-1').html).toContain(marker);
    expect(content.querySelectorAll('p')).toHaveLength(2);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', metaKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(original);
  });

  it.each([
    {
      name: 'one word', html: '<p>First paragraph</p>',
      select: (content: HTMLElement, range: Range) => {
        const text = content.querySelector('p')!.firstChild!;
        range.setStart(text, 0);
        range.setEnd(text, 5);
      },
    },
    {
      name: 'one paragraph', html: '<p>First paragraph</p><p>Second paragraph</p>',
      select: (content: HTMLElement, range: Range) =>
        range.selectNodeContents(content.querySelector('p')!),
    },
    {
      name: 'multiple paragraphs', html: '<p>First paragraph</p><p>Second paragraph</p>',
      select: (content: HTMLElement, range: Range) => {
        const paragraphs = content.querySelectorAll('p');
        range.setStartBefore(paragraphs[0]);
        range.setEndAfter(paragraphs[1]);
      },
    },
    {
      name: 'one numbered-list item', html: '<ol><li>First item</li><li>Second item</li></ol>',
      select: (content: HTMLElement, range: Range) =>
        range.selectNodeContents(content.querySelectorAll('li')[1]),
    },
    {
      name: 'a whole numbered list', html: '<ol><li>First item</li><li>Second item</li></ol>',
      select: (content: HTMLElement, range: Range) => range.selectNodeContents(content),
    },
    {
      name: 'a whole bulleted list', html: '<ul><li>First item</li><li>Second item</li></ul>',
      select: (content: HTMLElement, range: Range) => range.selectNodeContents(content),
    },
    {
      name: 'a heading and numbered list',
      html: '<p>Results</p><ol><li>First item</li><li>Second item</li></ol>',
      select: (content: HTMLElement, range: Range) => range.selectNodeContents(content),
    },
  ])('keeps $name structurally unchanged while choosing a font family', ({ html, select: selectRange }) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const range = document.createRange();
    selectRange(content, range);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const selectedText = window.getSelection()!.toString();
    const structure = [...content.querySelectorAll('p,ol,ul,li,br')]
      .map((node) => node.tagName);
    document.dispatchEvent(new Event('selectionchange'));

    const select = field(inspectorHost, 'Font family').querySelector<HTMLSelectElement>('select')!;
    // A native select must take focus to open. The canvas keeps a cloned Range
    // across that blur and restores it after the family has been chosen.
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: select }));
    window.getSelection()!.removeAllRanges();
    const avenir = document.createElement('option');
    avenir.value = 'Avenir';
    avenir.textContent = 'Avenir';
    select.appendChild(avenir);
    pick(select, 'Avenir');

    const styled = [...content.querySelectorAll<HTMLSpanElement>('span')]
      .filter((span) => span.style.fontFamily.includes('Avenir'));
    expect(styled.length).toBeGreaterThan(0);
    expect([...content.querySelectorAll('p,ol,ul,li,br')].map((node) => node.tagName))
      .toEqual(structure);
    expect(content.querySelectorAll('li:empty, p:empty, br')).toHaveLength(0);
    expect(window.getSelection()!.toString()).toBe(selectedText);
    expect(canvas.isEditing()).toBe(true);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    const saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    expect([...saved.querySelectorAll('p,ol,ul,li,br')].map((node) => node.tagName))
      .toEqual(structure);
    expect(saved.querySelectorAll('li:empty, p:empty, br')).toHaveLength(0);
    expect(saved.innerHTML).toContain('font-family: Avenir');
  });

  it.each([
    ['Cell', 1, 1, [1]],
    ['Row', 0, 1, [0, 1]],
    ['Column', 1, 3, [1, 3]],
    ['Range', 0, 3, [0, 1, 2, 3]],
  ] as const)('formats only the dragged table %s through the inspector', (scope, start, end, expected) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', {
        html: '<table><tbody><tr><td>A</td><td>B</td></tr>'
          + '<tr><td>C</td><td>D</td></tr></tbody></table>',
      }),
    ]);
    canvas.beginTextEdit('text-1');
    const content = contentOf(canvasHost, 'text-1');
    const cells = content.querySelectorAll('td');
    cells[start].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 }));
    if (end !== start) {
      const move = new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, pointerId: 9,
      });
      expect(cells[end].dispatchEvent(move)).toBe(false);
      expect(move.defaultPrevented).toBe(true);
    }
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));

    field(inspectorHost, 'Cell fill')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelector<HTMLButtonElement>('.color-picker-palette-button')!.click();

    const saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    const coloured = [...saved.querySelectorAll<HTMLTableCellElement>('td')]
      .flatMap((cell, index) => cell.style.backgroundColor ? [index] : []);
    expect(coloured).toEqual([...expected]);
    expect(canvas.isEditing()).toBe(true);
    expect(canvas.tableSelectionInfo()?.mode.toLowerCase()).toBe(scope.toLowerCase());

    field(inspectorHost, 'Cell fill')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelector<HTMLButtonElement>('.color-picker-clear')!.click();
    const cleared = document.createElement('div');
    cleared.innerHTML = textOf(store, 'text-1').html;
    expect([...cleared.querySelectorAll('td')].every((cell) => !cell.hasAttribute('style'))).toBe(true);
  });

  it('inserts and deletes the selected table column through the inspector', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', {
        html: '<table><tbody><tr><td>A</td><td>B</td></tr>'
          + '<tr><td>C</td><td>D</td></tr></tbody></table>',
      }),
    ]);
    canvas.beginTextEdit('text-1');
    const cells = contentOf(canvasHost, 'text-1').querySelectorAll('td');
    cells[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11 }));
    cells[3].dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerId: 11,
    }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11 }));

    const columnButton = (label: string) => [...inspectorHost.querySelectorAll<HTMLButtonElement>(
      '.table-column-buttons button',
    )].find((button) => button.textContent === label)!;
    columnButton('Insert before').click();
    let saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    expect([...saved.querySelectorAll('tr')].map((row) => row.cells.length)).toEqual([3, 3]);
    expect(canvas.tableSelectionInfo()).toMatchObject({ mode: 'cell', columns: 3 });

    columnButton('Delete column').click();
    saved = document.createElement('div');
    saved.innerHTML = textOf(store, 'text-1').html;
    expect([...saved.querySelectorAll('tr')].map((row) => row.cells.length)).toEqual([2, 2]);
    expect(canvas.tableSelectionInfo()).toMatchObject({ mode: 'cell', columns: 2 });
    expect(canvas.isEditing()).toBe(true);
  });

  it.each([
    ['Bold (Cmd/Ctrl+B)', 'fontWeight', '700'],
    ['Italic (Cmd/Ctrl+I)', 'fontStyle', 'italic'],
    ['Underline (Cmd/Ctrl+U)', 'textDecorationLine', 'underline'],
  ] as const)('formats only a highlighted table word with the %s button and undoes it', (
    label, property, expected,
  ) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const choice = inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(choice.dispatchEvent(new PointerEvent(
      'pointerdown', { bubbles: true, cancelable: true },
    ))).toBe(false);
    choice.click();

    const saved = savedTable(store);
    const styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style[property] === expected)!;
    expect(styled.textContent).toBe('beta');
    expect([...saved.querySelectorAll<HTMLElement>('td')]
      .every((tableCell) => !tableCell.style[property])).toBe(true);
    expect(saved.querySelectorAll('td')[1].hasAttribute('style')).toBe(false);
    expect(canvas.tableSelectionInfo()).toMatchObject({ mode: 'cell', row: 0, column: 0 });
    expect(inspectorHost.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .getAttribute('aria-pressed')).toBe('true');

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
    expect(window.getSelection()!.toString()).toBe('beta');
    expect(canvas.isEditing()).toBe(true);
  });

  it.each([
    ['b', 'fontWeight', '700'],
    ['i', 'fontStyle', 'italic'],
    ['u', 'textDecorationLine', 'underline'],
  ] as const)('applies Cmd/Ctrl+%s only to a highlighted table word and undoes it', (
    key, property, expected,
  ) => {
    const { store, canvas, canvasHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const shortcut = new KeyboardEvent('keydown', {
      key, metaKey: true, bubbles: true, cancelable: true,
    });
    content.dispatchEvent(shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    const saved = savedTable(store);
    const styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style[property] === expected)!;
    expect(styled.textContent).toBe('beta');
    expect([...saved.querySelectorAll<HTMLElement>('td')]
      .every((tableCell) => !tableCell.style[property])).toBe(true);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', metaKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
    expect(window.getSelection()!.toString()).toBe('beta');
  });

  it.each([
    ['Font size', '44', 'fontSize', '44px'],
    ['Font weight', '650', 'fontWeight', '650'],
  ] as const)('formats only a highlighted table word through the %s input', (
    label, value, property, expected,
  ) => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const input = field(inspectorHost, label).querySelector<HTMLInputElement>('input')!;
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: input }));
    type(input, value);

    const saved = savedTable(store);
    const styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style[property] === expected)!;
    expect(styled.textContent).toBe('beta');
    expect([...saved.querySelectorAll<HTMLElement>('td')]
      .every((tableCell) => !tableCell.style[property])).toBe(true);
    expect(canvas.isEditing()).toBe(true);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
    expect(window.getSelection()!.toString()).toBe('beta');
  });

  it('changes only a highlighted table word font family and keeps its selection', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const select = field(inspectorHost, 'Font family').querySelector<HTMLSelectElement>('select')!;
    content.dispatchEvent(new FocusEvent('blur', { relatedTarget: select }));
    window.getSelection()!.removeAllRanges();
    const avenir = document.createElement('option');
    avenir.value = 'Avenir';
    avenir.textContent = 'Avenir';
    select.appendChild(avenir);
    pick(select, 'Avenir');

    const saved = savedTable(store);
    const styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style.fontFamily.includes('Avenir'))!;
    expect(styled.textContent).toBe('beta');
    expect(saved.querySelectorAll('td[style*="font-family"]')).toHaveLength(0);
    expect(window.getSelection()!.toString()).toBe('beta');
    expect(canvas.isEditing()).toBe(true);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
  });

  it('applies theme and arbitrary colours only to a highlighted table word', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: TABLE_WORD_HTML }),
    ]);
    const { content } = selectTableWord(canvas, canvasHost);
    const trigger = () => field(inspectorHost, 'Colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!;

    trigger().click();
    document.querySelector<HTMLButtonElement>(
      '.color-picker-palette-button[title="#112233"]',
    )!.click();
    let saved = savedTable(store);
    let styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style.color === 'rgb(17, 34, 51)')!;
    expect(styled.textContent).toBe('beta');
    expect(saved.querySelectorAll('td[style*="color"]')).toHaveLength(0);

    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(textOf(store, 'text-1').html).toBe(TABLE_WORD_HTML);
    expect(window.getSelection()!.toString()).toBe('beta');

    trigger().click();
    const picker = document.querySelector<HTMLElement>('.color-picker-popover')!;
    type(picker.querySelector<HTMLInputElement>('input[aria-label="Hex color"]')!, '#3366cc');
    const opacity = picker.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!;
    opacity.value = '50';
    opacity.dispatchEvent(new Event('input', { bubbles: true }));
    opacity.dispatchEvent(new Event('change', { bubbles: true }));

    saved = savedTable(store);
    styled = [...saved.querySelectorAll<HTMLElement>('td span')]
      .find((span) => span.style.color === 'rgba(51, 102, 204, 0.5)')!;
    expect(styled.textContent).toBe('beta');
    expect(saved.querySelectorAll('td[style*="color"]')).toHaveLength(0);
    expect(canvas.isEditing()).toBe(true);
  });

  it('interactively applies every table border preset and paints one edge', () => {
    const { store, canvas, canvasHost, inspectorHost } = setup([
      textElement('text-1', {
        html: '<table><tbody><tr><td>A</td><td>B</td></tr>'
          + '<tr><td>C</td><td>D</td></tr></tbody></table>',
      }),
    ]);
    canvas.beginTextEdit('text-1');
    contentOf(canvasHost, 'text-1').querySelector('td')!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    expect(canvas.tableSelectionInfo(), 'selection before immediate preset').toMatchObject({
      elementId: 'text-1', row: 0, column: 0,
    });
    const borderButton = (label: string) => [...inspectorHost.querySelectorAll<HTMLButtonElement>(
      '.table-border-buttons button',
    )].find((button) => button.textContent === label)!;
    const width = field(inspectorHost, 'Border width').querySelector<HTMLInputElement>('input')!;
    width.value = '3';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    field(inspectorHost, 'Border color')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelector<HTMLButtonElement>('.color-picker-palette-button')!.click();
    const paint = canvas.tableBorderSettings();
    expect(paint.width).toBe(3);
    expect(canvas.isEditing()).toBe(true);
    expect(canvas.tableSelectionInfo()).toMatchObject({ elementId: 'text-1' });
    expect(contentOf(canvasHost, 'text-1').querySelector('table')).not.toBeNull();

    const savedCells = () => {
      const saved = document.createElement('div');
      saved.innerHTML = textOf(store, 'text-1').html;
      return [...saved.querySelectorAll<HTMLTableCellElement>('td')];
    };
    borderButton('No borders').click();
    const noBorderCells = savedCells();
    expect(noBorderCells.every((cell) =>
      ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
        .every((property) => cell.style[property as keyof CSSStyleDeclaration] === '0px')),
    noBorderCells.map((cell) => cell.getAttribute('style')).join(' | ')).toBe(true);

    borderButton('Vertical borders').click();
    expect(savedCells().every((cell) =>
      cell.style.borderLeftWidth === '3px'
      && cell.style.borderRightWidth === '3px'
      && cell.style.borderTopWidth === '0px'
      && cell.style.borderBottomWidth === '0px')).toBe(true);

    borderButton('Horizontal borders').click();
    expect(savedCells().every((cell) =>
      cell.style.borderTopWidth === '3px'
      && cell.style.borderBottomWidth === '3px'
      && cell.style.borderLeftWidth === '0px'
      && cell.style.borderRightWidth === '0px')).toBe(true);

    borderButton('No borders').click();
    borderButton('Draw borders').click();
    expect(canvas.tableBorderSettings().drawing).toBe(true);
    const liveCells = contentOf(canvasHost, 'text-1').querySelectorAll<HTMLTableCellElement>('td');
    liveCells[0].getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50,
      width: 100, height: 50, toJSON: () => ({}),
    }) as DOMRect;
    liveCells[0].dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: 99, clientY: 25, pointerId: 21,
    }));
    expect(liveCells[0].classList.contains('editor-table-border-preview-right')).toBe(true);
    liveCells[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 99, clientY: 25, pointerId: 21,
    }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 21 }));
    const drawn = savedCells();
    expect(drawn[0].style.borderRightWidth).toBe('3px');
    expect(drawn[1].style.borderLeftWidth).toBe('3px');
  });

  it('keeps a heading outside a typed numbered list and removes typed markers', () => {
    const { store, inspectorHost } = setup([
      textElement('text-1', {
        html: '<p><code>Results and analysis:</code></p>'
          + '<p><code><span>1. </span>ego</code></p>'
          + '<p>2. Second result</p>'
          + '<p>3) <strong>Third result</strong></p>',
      }),
    ]);

    pick(listSelect(inspectorHost), 'Numbered');
    expect(textOf(store, 'text-1').html).toBe(
      '<p><code>Results and analysis:</code></p>'
      + '<ol><li><code>ego</code></li><li>Second result</li>'
      + '<li><strong>Third result</strong></li></ol>',
    );
    expect(listSelect(inspectorHost).value).toBe('Numbered');

    pick(listSelect(inspectorHost), 'None');
    expect(textOf(store, 'text-1').html).toBe(
      '<p><code>Results and analysis:</code></p>'
      + '<p><code>ego</code></p><p>Second result</p>'
      + '<p><strong>Third result</strong></p>',
    );
  });

  it('infers a selected first item when the remaining paragraphs begin at 2', () => {
    const { store, inspectorHost } = setup([
      textElement('text-1', {
        html: '<p>First item with its marker already removed</p>'
          + '<p>2. Second item</p><p>3. Third item</p>',
      }),
    ]);
    pick(listSelect(inspectorHost), 'Numbered');
    expect(textOf(store, 'text-1').html).toBe(
      '<ol><li>First item with its marker already removed</li>'
      + '<li>Second item</li><li>Third item</li></ol>',
    );
  });

  it('sets and clears paragraph spacing, driving the canvas custom property', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First</p><p>Second</p>' }),
    ]);
    const spacing = () => field(inspectorHost, 'Paragraph spacing');
    const input = () => spacing().querySelector<HTMLInputElement>('input')!;
    expect(input().value).toBe('');
    expect(input().placeholder).toBe('theme');

    type(input(), '28');
    expect(textOf(store, 'text-1').paragraphSpacing).toBe(28);
    expect(nodeOf(canvasHost, 'text-1').dataset.paragraphSpacing).toBe('28');
    expect(nodeOf(canvasHost, 'text-1').style.getPropertyValue('--paragraph-spacing'))
      .toBe('28px');

    // Negative spacing is not a thing; the control clamps rather than storing it.
    type(input(), '-10');
    expect(textOf(store, 'text-1').paragraphSpacing).toBe(0);

    spacing().querySelector<HTMLButtonElement>('.icon-button')!.click();
    expect(textOf(store, 'text-1').paragraphSpacing).toBeUndefined();
    expect(nodeOf(canvasHost, 'text-1').dataset.paragraphSpacing).toBeUndefined();
  });

  it('assigns the semantic type role that theme.css and Cast fonts target', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);
    const role = () => field(inspectorHost, 'Role').querySelector('select')!;
    expect([...role().options].map((option) => option.textContent))
      .toEqual(['Title', 'Body', 'Caption', 'None']);
    expect(role().value).toBe('');

    pick(role(), 'role-title');
    expect(textOf(store, 'text-1').class).toEqual(['role-title']);
    expect(nodeOf(canvasHost, 'text-1').className).toContain('role-title');

    pick(role(), 'role-caption');
    expect(textOf(store, 'text-1').class).toEqual(['role-caption']);

    pick(role(), '');
    expect(textOf(store, 'text-1').class).toEqual([]);
  });

  it('records one undoable step per formatting click', () => {
    const { store, canvasHost, inspectorHost } = setup([textElement('text-1')]);
    alignButtons(inspectorHost)[2].click();
    type(field(inspectorHost, 'Paragraph spacing').querySelector<HTMLInputElement>('input')!, '18');
    expect(store.history().map((entry) => entry.label))
      .toEqual(expect.arrayContaining(['Change text alignment', 'Change paragraph spacing']));

    store.undo();
    expect(textOf(store, 'text-1').paragraphSpacing).toBeUndefined();
    store.undo();
    expect(textOf(store, 'text-1').align).toBe('left');
    expect(bodyOf(canvasHost, 'text-1').style.textAlign).toBe('left');
  });
});

describe('text formatting across a multi-selection', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  it('reports mixed values, then applies one click to every selected text box', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { align: 'left', paragraphSpacing: 10, style: { color: '#112233' } }),
      textElement('text-2', { y: 400, align: 'right', paragraphSpacing: 30, style: { color: '#ff8800' } }),
    ]);
    expect(store.selectedElements()).toHaveLength(2);

    // Nothing is pressed while the selection disagrees, and the spacing box
    // says so rather than silently showing one box's number as the truth.
    expect(alignButtons(inspectorHost).map((button) => button.getAttribute('aria-pressed')))
      .toEqual(['false', 'false', 'false', 'false']);
    const spacing = () => field(inspectorHost, 'Paragraph spacing')
      .querySelector<HTMLInputElement>('input')!;
    expect(spacing().placeholder).toBe('Mixed');
    expect(field(inspectorHost, 'Colour (mixed)')).toBeTruthy();

    alignButtons(inspectorHost)[1].click();
    for (const id of ['text-1', 'text-2']) {
      expect(textOf(store, id).align).toBe('center');
      expect(bodyOf(canvasHost, id).style.textAlign).toBe('center');
    }
    expect(alignButtons(inspectorHost).map((button) => button.getAttribute('aria-pressed')))
      .toEqual(['false', 'true', 'false', 'false']);

    type(spacing(), '24');
    expect(['text-1', 'text-2'].map((id) => textOf(store, id).paragraphSpacing))
      .toEqual([24, 24]);
  });

  it('bullets a whole multi-selection from the shared list dropdown', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>Alpha</p><p>Beta</p>' }),
      textElement('text-2', { y: 400, html: 'Gamma' }),
    ]);

    pick(listSelect(inspectorHost), 'Bulleted');
    expect(textOf(store, 'text-1').html).toBe('<ul><li>Alpha</li><li>Beta</li></ul>');
    expect(textOf(store, 'text-2').html).toBe('<ul><li>Gamma</li></ul>');
    expect(bodyOf(canvasHost, 'text-2').querySelectorAll('li')).toHaveLength(1);

    pick(listSelect(inspectorHost), 'None');
    expect(textOf(store, 'text-1').html).toBe('<p>Alpha</p><p>Beta</p>');
    // A single line comes back as one paragraph rather than the bare markup it
    // started as; both render identically, so the round trip is lossless.
    expect(textOf(store, 'text-2').html).toBe('<p>Gamma</p>');
  });

  it('recolours every selected text box from one swatch click', () => {
    const { store, inspectorHost } = setup([
      textElement('text-1'),
      textElement('text-2', { y: 400 }),
    ]);
    field(inspectorHost, 'Colour')
      .querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    document.querySelectorAll<HTMLButtonElement>('.color-picker-palette-button')[1].click();

    expect(['text-1', 'text-2'].map((id) => textOf(store, id).style.color))
      .toEqual(['#ff8800', '#ff8800']);
  });
});

describe('inline run formatting while editing text', () => {
  beforeEach(() => {
    closePopover();
    document.body.replaceChildren();
  });

  it('uses the font weight field for the selected run without a duplicate weight picker', () => {
    installDomShims();
    const deck = emptyDeck('Runs');
    deck.slides[0].elements = [textElement('text-1', { html: 'Weighted run' })];
    const inspectorHost = document.createElement('aside');
    document.body.replaceChildren(inspectorHost);
    const store = new EditorStore(deck, '/tmp/deck');
    const inspector = new Inspector(inspectorHost, store);
    const applied: number[] = [];
    inspector.editingText = () => true;
    inspector.onApplyTextSelectionWeight = (weight) => {
      applied.push(weight);
      return true; // the shell reports whether a run was actually restyled
    };
    store.select(['text-1']);

    expect(inspectorHost.querySelector('.text-weight-buttons')).toBeNull();
    const input = field(inspectorHost, 'Font weight').querySelector<HTMLInputElement>('input')!;
    type(input, '700');
    expect(applied).toEqual([700]);
  });

  it('hides the run controls when no text is being edited', () => {
    const { inspectorHost } = setup([textElement('text-1')]);
    expect(inspectorHost.querySelector('.text-selection-style')).toBeNull();
  });
});
