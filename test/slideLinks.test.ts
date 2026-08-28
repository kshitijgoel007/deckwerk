// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { renderSlide } from '../src/renderer/player/render.js';
import {
  openSlideLinkInNewTab,
  slideLinkFromEvent,
} from '../src/renderer/player/links.js';

describe('slide links', () => {
  it('opens text links in a new tab without an opener', () => {
    const deck = emptyDeck('Links');
    deck.slides[0].elements.push({
      id: 'link', type: 'text', x: 0, y: 0, w: 500, h: 100,
      rot: 0, z: 1, opacity: 1, class: [], style: {},
      html: '<a href="https://example.com" target="_self" rel="author">Example</a>',
      align: 'left', valign: 'top',
    });

    const slide = renderSlide(deck.slides[0], { resolveSrc: (src) => src });
    const anchor = slide.querySelector<HTMLAnchorElement>('a')!;
    expect(anchor.target).toBe('_blank');
    expect(new Set(anchor.rel.split(/\s+/))).toEqual(new Set(['author', 'noopener']));
  });

  it('prepares and recognizes links inside sandboxed HTML shadow roots', () => {
    const deck = emptyDeck('Shadow links');
    deck.slides[0].elements.push({
      id: 'html-link', type: 'html', x: 0, y: 0, w: 500, h: 100,
      rot: 0, z: 1, opacity: 1, class: [], style: {},
      html: '<a href="https://example.com"><span>Example</span></a>', sandboxed: true,
    });

    const slide = renderSlide(deck.slides[0], { resolveSrc: (src) => src });
    const anchor = slide.querySelector<HTMLElement>('[data-element-id="html-link"]')!
      .querySelector<HTMLElement>('div')!.shadowRoot!
      .querySelector<HTMLAnchorElement>('a')!;
    expect(anchor.target).toBe('_blank');

    let found: HTMLAnchorElement | null = null;
    slide.addEventListener('mousedown', (event) => { found = slideLinkFromEvent(event); });
    anchor.querySelector('span')!.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      composed: true,
    }));
    expect(found).toBe(anchor);
  });

  it('explicitly opens raw editor links in a new tab', () => {
    document.body.innerHTML = '<a href="https://example.com/path"><span>Example</span></a>';
    const target = document.querySelector('span')!;
    const opened: string[][] = [];
    target.addEventListener('click', (event) => {
      expect(openSlideLinkInNewTab(event, (...args) => opened.push(args))).toBe(true);
    });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual([['https://example.com/path', '_blank', 'noopener']]);
  });
});
