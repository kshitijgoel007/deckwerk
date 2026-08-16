// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { TimelinePanel } from '../src/renderer/editor/timelinePanel.js';

describe('Build panel interactions', () => {
  beforeEach(() => document.body.replaceChildren());

  it('adds selected reveals and reorders them through the visible drag grip', () => {
    const deck = emptyDeck('Build');
    deck.slides[0].elements.push(
      { id: 'a', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: 'A', align: 'left', valign: 'top' },
      { id: 'b', type: 'text', x: 0, y: 60, w: 100, h: 50, rot: 0, z: 2,
        opacity: 1, class: [], style: {}, html: 'B', align: 'left', valign: 'top' },
    );
    const store = new EditorStore(deck, '/tmp/build');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);

    const revealSelected = () => [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Reveal selected on click')!.click();
    store.select(['a']);
    revealSelected();
    store.select(['b']);
    revealSelected();
    expect(store.slide?.timeline.map((entry) => entry.action.target)).toEqual(['a', 'b']);

    const rows = host.querySelectorAll<HTMLElement>('.timeline-row');
    const first = rows[0];
    const secondGrip = rows[1].querySelector<HTMLElement>('.build-drag-handle')!;
    first.getBoundingClientRect = () => ({ top: 0, height: 90 } as DOMRect);
    const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    const start = new Event('dragstart', { bubbles: true });
    Object.defineProperty(start, 'dataTransfer', { value: transfer });
    secondGrip.dispatchEvent(start);
    const over = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 5 });
    Object.defineProperty(over, 'dataTransfer', { value: transfer });
    first.dispatchEvent(over);
    expect(first.dataset.dropMode).toBe('before');
    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 5 });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    first.dispatchEvent(drop);

    expect(store.slide?.timeline.map((entry) => entry.action.target)).toEqual(['b', 'a']);
    expect(store.history()[0].label).toBe('Reorder build animations');
  });
});
