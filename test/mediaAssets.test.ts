// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { classifyMedia } from '../src/main/deckStore.js';
import { renderElement } from '../src/renderer/player/render.js';

const base = {
  x: 10, y: 20, w: 800, h: 500, rot: 0, z: 1, opacity: 1, class: [], style: {},
};

describe('media assets and borders', () => {
  it.each(['figure.png', 'photo.jpg', 'drawing.svg', 'paper.pdf'])(
    'accepts %s as a dropped visual asset',
    (name) => expect(classifyMedia(name)).toBe('image'),
  );

  it('keeps a PDF as a vector-backed embedded document', () => {
    const node = renderElement({
      ...base, id: 'pdf', type: 'image', src: 'assets/paper.pdf', fit: 'contain',
      alt: '', sourceBox: null,
    }, { resolveSrc: (src) => `deck://${src}` });
    const pdf = node.querySelector('embed')!;
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.src).toContain('paper.pdf#page=1');
  });

  it('renders editable coloured borders on media', () => {
    const node = renderElement({
      ...base, id: 'image', type: 'image', src: 'assets/image.png', fit: 'contain',
      alt: '', sourceBox: null, borderColor: '#ff3366', borderWidth: 8,
      borderRadius: 14,
    }, { resolveSrc: (src) => src });
    expect(node.style.border).toContain('8px solid');
    expect(node.style.border).toContain('rgb(255, 51, 102)');
    expect(node.style.borderRadius).toBe('14px');
  });

  it('resolves media and CSS assets inside a sandboxed HTML fallback', () => {
    const node = renderElement({
      ...base,
      id: 'portrait-fallback',
      type: 'html',
      html: '<figure data-slide-editor-fallback-root><img src="assets/portrait.jpg"></figure>',
      sandboxed: true,
      css: '.portrait { background-image:url("assets/texture.png") }',
      fallbackReason: 'Clipped media frame with a CSS pseudo-element overlay',
    }, { resolveSrc: (src) => `/decks/test/${src}` });

    const shadow = node.querySelector('div')!.shadowRoot!;
    expect(shadow.querySelector('img')!.getAttribute('src'))
      .toBe('/decks/test/assets/portrait.jpg');
    expect(shadow.querySelector('style')!.textContent)
      .toContain('url("/decks/test/assets/texture.png")');
  });
});
