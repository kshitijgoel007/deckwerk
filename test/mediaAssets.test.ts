// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { classifyMedia } from '../src/main/deckStore.js';
import { renderElement, syncMediaFrame } from '../src/renderer/player/render.js';

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

  it('overlays editable coloured borders without putting them in the media box model', () => {
    const node = renderElement({
      ...base, id: 'image', type: 'image', src: 'assets/image.png', fit: 'contain',
      alt: '', sourceBox: null, borderColor: '#ff3366', borderWidth: 8,
      borderRadius: 14,
    }, { resolveSrc: (src) => src });
    const image = node.querySelector<HTMLImageElement>('img')!;
    const border = node.querySelector<HTMLElement>(':scope > .media-border-overlay')!;

    expect(node.style.border).toBe('');
    expect(image.style.width).toBe('100%');
    expect(image.style.height).toBe('100%');
    expect(border.style.position).toBe('absolute');
    expect(border.style.inset).toBe('0');
    expect(border.style.border).toContain('8px solid');
    expect(border.style.border).toContain('rgb(255, 51, 102)');
    expect(border.style.borderRadius).toBe('14px');
    expect(node.style.borderRadius).toBe('14px');
  });

  it('overlays a CSS-authored media border too', () => {
    const node = renderElement({
      ...base, id: 'video', type: 'video', src: 'assets/video.mp4', fit: 'cover',
      autoplay: false, loop: false, muted: true, controls: false, start: 0, end: null,
      poster: null, sourceBox: null, style: { border: '5px solid #ffffff' },
    }, { resolveSrc: (src) => src });
    const border = node.querySelector<HTMLElement>(':scope > .media-border-overlay')!;

    expect(node.style.border).toBe('');
    expect(node.querySelector<HTMLVideoElement>('video')!.style.width).toBe('100%');
    expect(border.style.border).toContain('5px solid');
  });

  it('lets an explicit inspector width suppress a stale CSS-authored border', () => {
    const element = {
      ...base, id: 'image', type: 'image' as const, src: 'assets/image.png', fit: 'cover' as const,
      alt: '', sourceBox: null, style: { border: '7px solid #f3b61f' },
      borderColor: '#f3b61f', borderWidth: 7,
    };
    const node = renderElement(element, { resolveSrc: (src) => src });
    const border = node.querySelector<HTMLElement>(':scope > .media-border-overlay')!;
    expect(border.style.border).toContain('7px solid');

    syncMediaFrame(node, { ...element, borderWidth: 0 });
    expect(border.style.border).toBe('');
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
