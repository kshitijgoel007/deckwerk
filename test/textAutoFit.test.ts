// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { fitAutoTextElement, renderElement } from '../src/renderer/player/render.js';

describe('text auto-fit', () => {
  beforeEach(() => document.body.replaceChildren());

  it('shrinks overflowing text and grows it back to its authored ceiling', () => {
    const node = renderElement({
      id: 'fit', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
      opacity: 1, class: [], style: { 'font-size': '40px' },
      html: 'Long text', autoFit: true, align: 'left', valign: 'top',
    }, { resolveSrc: (src) => src });
    document.body.appendChild(node);
    const body = node.querySelector<HTMLElement>('.text-body')!;
    const content = node.querySelector<HTMLElement>('.text-content')!;
    Object.defineProperties(body, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 50 },
    });
    let widthFactor = 5;
    let heightFactor = 2;
    Object.defineProperties(content, {
      scrollWidth: {
        configurable: true,
        get: () => Number.parseFloat(content.style.fontSize) * widthFactor,
      },
      scrollHeight: {
        configurable: true,
        get: () => Number.parseFloat(content.style.fontSize) * heightFactor,
      },
    });

    // The fitter measures against a content box narrowed by 1% so the settled
    // size clears every wrap boundary with slack: 99px / widthFactor 5 → 19.9.
    expect(fitAutoTextElement(node)).toBeCloseTo(19.9, 1);
    expect(content.style.fontSize).toBe('19.9px');

    widthFactor = 1;
    heightFactor = 1;
    expect(fitAutoTextElement(node)).toBe(40);
    expect(content.style.fontSize).toBe('40px');
  });

  it('exposes auto-fit as an undoable text-box checkbox', () => {
    const deck = emptyDeck('Auto-fit');
    deck.slides[0].elements.push({
      id: 'text', type: 'text', x: 0, y: 0, w: 400, h: 100, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, html: 'Text', align: 'left', valign: 'top',
    });
    const store = new EditorStore(deck, '/tmp/autofit');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);
    store.select(['text']);
    const label = [...host.querySelectorAll('label')].find((candidate) =>
      candidate.textContent?.includes('Auto-fit text to box'))!;
    const checkbox = label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    expect(checkbox.checked).toBe(false);
    checkbox.click();
    expect(store.selectedElements()[0]).toMatchObject({ autoFit: true });
    expect(store.history()[0].label).toBe('Enable text auto-fit');

    store.undo();
    const restored = store.selectedElements()[0];
    expect(restored.type).toBe('text');
    if (restored.type === 'text') expect(restored.autoFit).toBeUndefined();
  });
});
