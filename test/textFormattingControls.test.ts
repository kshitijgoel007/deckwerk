// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
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
  new EditorCanvas(canvasHost, store);
  new Inspector(inspectorHost, store);
  store.select(elements.map((element) => element.id));
  return { store, canvasHost, inspectorHost };
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

/** A checkbox is labelled by a trailing `<span>`, so match on the whole label. */
function checkbox(host: HTMLElement, label: string): HTMLInputElement {
  const match = [...host.querySelectorAll<HTMLElement>('.field-check')]
    .find((node) => node.textContent?.trim() === label);
  if (!match) throw new Error(`no inspector checkbox labelled "${label}"`);
  return match.querySelector('input')!;
}

const textOf = (store: EditorStore, id: string): Extract<SlideElement, { type: 'text' }> => {
  const element = store.slide!.elements.find((candidate) => candidate.id === id)!;
  if (element.type !== 'text') throw new Error(`${id} is not text`);
  return element;
};

const bodyOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-element-id="${id}"] .text-body`)!;

const nodeOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!;

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

  it('turns paragraphs into a bulleted list and back from the checkbox', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>First</p><p>Second</p>' }),
    ]);
    const listBox = () => checkbox(inspectorHost, 'Bulleted list');
    expect(listBox().checked).toBe(false);

    listBox().click();
    expect(textOf(store, 'text-1').html).toBe('<ul><li>First</li><li>Second</li></ul>');
    expect([...bodyOf(canvasHost, 'text-1').querySelectorAll('li')].map((li) => li.textContent))
      .toEqual(['First', 'Second']);
    expect(listBox().checked).toBe(true);

    listBox().click();
    expect(textOf(store, 'text-1').html).toBe('<p>First</p><p>Second</p>');
    expect(bodyOf(canvasHost, 'text-1').querySelectorAll('li')).toHaveLength(0);
    expect(listBox().checked).toBe(false);
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

  it('bullets a whole multi-selection from the shared typography checkbox', () => {
    const { store, canvasHost, inspectorHost } = setup([
      textElement('text-1', { html: '<p>Alpha</p><p>Beta</p>' }),
      textElement('text-2', { y: 400, html: 'Gamma' }),
    ]);

    checkbox(inspectorHost, 'Bulleted list').click();
    expect(textOf(store, 'text-1').html).toBe('<ul><li>Alpha</li><li>Beta</li></ul>');
    expect(textOf(store, 'text-2').html).toBe('<ul><li>Gamma</li></ul>');
    expect(bodyOf(canvasHost, 'text-2').querySelectorAll('li')).toHaveLength(1);

    checkbox(inspectorHost, 'Bulleted list').click();
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

  it('applies a weight to the selected run without leaving the editor', () => {
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

    const weights = [...inspectorHost.querySelectorAll<HTMLButtonElement>(
      '.text-selection-style .button-row button',
    )];
    expect(weights.map((button) => button.textContent))
      .toEqual(['100', '200', '300', '400', '500', '600', '700', '800', '900']);

    // Pointerdown must be prevented, or blur commits and destroys the Range
    // the weight is meant to apply to before the click ever lands.
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    weights[6].dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    weights[6].click();
    expect(applied).toEqual([700]);
  });

  it('hides the run controls when no text is being edited', () => {
    const { inspectorHost } = setup([textElement('text-1')]);
    expect(inspectorHost.querySelector('.text-selection-style')).toBeNull();
  });
});
