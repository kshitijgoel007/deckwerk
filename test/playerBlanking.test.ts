// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';

describe('player blanking', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
    if (!CSS.escape) CSS.escape = (value) => value;
  });

  it('blanks the entire rendered stage even when a child is explicitly visible', () => {
    const deck = emptyDeck('Blanking');
    deck.slides[0].elements.push({
      id: 'visible-text',
      type: 'text',
      x: 100,
      y: 100,
      w: 600,
      h: 100,
      rot: 0,
      z: 1,
      opacity: 1,
      class: ['role-title'],
      style: {},
      html: 'This must disappear',
      align: 'left',
      valign: 'top',
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });
    const stage = host.querySelector<HTMLElement>('.stage')!;
    const element = stage.querySelector<HTMLElement>('[data-element-id="visible-text"]')!;

    expect(element.style.visibility).toBe('visible');
    expect(player.toggleBlank()).toBe(true);
    expect(stage.style.opacity).toBe('0');

    expect(player.toggleBlank()).toBe(false);
    expect(stage.style.opacity).toBe('1');
  });
});
