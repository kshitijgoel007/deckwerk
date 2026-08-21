// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { renderElement } from '../src/renderer/player/render.js';

describe('stackable media effects', () => {
  beforeEach(() => document.body.replaceChildren());

  it('renders blur, posterize, and greyscale in the authored order', () => {
    const node = renderElement({
      id: 'photo', type: 'image', src: 'photo.png', fit: 'contain', alt: '',
      x: 0, y: 0, w: 640, h: 480, rot: 0, z: 1, opacity: 1, class: [], style: {},
      sourceBox: null,
      effects: [
        { type: 'blur', radius: 12 },
        { type: 'posterize', levels: 4 },
        { type: 'grayscale', amount: 0.75 },
      ],
    }, { resolveSrc: (src) => src });
    const image = node.querySelector<HTMLImageElement>('img')!;

    expect(image.style.filter).toBe('blur(12px) url("#posterize-photo-1") grayscale(0.75)');
    const filter = node.querySelector('filter#posterize-photo-1')!;
    expect(filter.querySelectorAll('feFuncR, feFuncG, feFuncB')).toHaveLength(3);
    expect(filter.querySelector('feFuncR')?.getAttribute('tableValues')).toBe(
      '0 0.3333333333333333 0.6666666666666666 1',
    );

    const videoNode = renderElement({
      id: 'clip', type: 'video', src: 'clip.mp4', fit: 'contain', autoplay: true,
      loop: true, muted: true, controls: false, start: 0, end: null, poster: null,
      x: 0, y: 0, w: 640, h: 360, rot: 0, z: 1, opacity: 1, class: [], style: {},
      sourceBox: null,
      effects: [{ type: 'grayscale', amount: 1 }, { type: 'blur', radius: 3 }],
    }, { resolveSrc: (src) => src });
    expect(videoNode.querySelector<HTMLVideoElement>('video')!.style.filter)
      .toBe('grayscale(1) blur(3px)');
  });

  it('linearly mixes band-limited noise into video and text paint', () => {
    const effect = {
      type: 'gaussianNoise' as const,
      amount: 0.6,
      frequencyCutoff: 0.18,
    };
    const videoNode = renderElement({
      id: 'noisy-clip', type: 'video', src: 'clip.mp4', fit: 'contain', autoplay: true,
      loop: true, muted: true, controls: false, start: 0, end: null, poster: null,
      x: 0, y: 0, w: 640, h: 360, rot: 0, z: 1, opacity: 1, class: [], style: {},
      sourceBox: null, effects: [effect],
    }, { resolveSrc: (src) => src });
    expect(videoNode.querySelector<HTMLVideoElement>('video')!.style.filter)
      .toBe('url("#gaussian-noise-noisy-clip-0")');

    const filter = videoNode.querySelector('filter#gaussian-noise-noisy-clip-0')!;
    expect(filter.querySelector('feTurbulence')?.getAttribute('baseFrequency')).toBe('0.18');
    expect(filter.querySelector('feTurbulence')?.getAttribute('numOctaves')).toBe('4');
    const blend = filter.querySelector('feComposite[operator="arithmetic"]')!;
    expect(blend.getAttribute('k2')).toBe('0.6');
    expect(blend.getAttribute('k3')).toBe('0.4');

    const textNode = renderElement({
      id: 'noisy-title', type: 'text', html: 'Signal', align: 'left', valign: 'top',
      x: 0, y: 0, w: 640, h: 120, rot: 0, z: 1, opacity: 1, class: [], style: {},
      effects: [{ ...effect, amount: 1 }],
    }, { resolveSrc: (src) => src });
    expect(textNode.querySelector<HTMLElement>('.text-body')!.style.filter)
      .toBe('url("#gaussian-noise-noisy-title-0")');
    const textBlend = textNode.querySelector('feComposite[operator="arithmetic"]')!;
    expect(textBlend.getAttribute('k2')).toBe('1');
    expect(textBlend.getAttribute('k3')).toBe('0');
    expect(textNode.querySelector('feComposite[operator="in"]')?.getAttribute('in2'))
      .toBe('SourceAlpha');
  });

  it('exposes amount and frequency cutoff controls for text', () => {
    const deck = emptyDeck('Text effects');
    deck.slides[0].elements.push({
      id: 'title', type: 'text', html: 'Signal', align: 'left', valign: 'top',
      x: 0, y: 0, w: 640, h: 120, rot: 0, z: 1, opacity: 1, class: [], style: {},
    });
    const store = new EditorStore(deck, '/tmp/text-effects');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);
    store.select(['title']);

    const picker = host.querySelector<HTMLSelectElement>('.effect-add')!;
    expect([...picker.options].map((option) => option.textContent))
      .toContain('Gaussian Noise');
    picker.value = 'gaussianNoise';
    picker.dispatchEvent(new Event('change', { bubbles: true }));

    const row = host.querySelector<HTMLElement>('.media-effect-row-noise')!;
    const inputs = row.querySelectorAll<HTMLInputElement>('input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].getAttribute('aria-label')).toBe('Amount from 0 to 1');
    expect(inputs[1].getAttribute('aria-label')).toBe('Frequency cutoff');
    inputs[0].value = '0.7';
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    host.querySelector<HTMLInputElement>('[aria-label="Frequency cutoff"]')!.value = '0.3';
    host.querySelector<HTMLInputElement>('[aria-label="Frequency cutoff"]')!
      .dispatchEvent(new Event('change', { bubbles: true }));

    const text = store.selectedElements()[0];
    if (text.type !== 'text') throw new Error('expected text');
    expect(text.effects).toEqual([{
      type: 'gaussianNoise', amount: 0.7, frequencyCutoff: 0.3,
    }]);
  });

  it('adds, configures, reorders, and removes effects from the inspector', () => {
    const deck = emptyDeck('Effects');
    deck.slides[0].elements.push({
      id: 'photo', type: 'image', src: 'photo.png', fit: 'contain', alt: '',
      x: 0, y: 0, w: 640, h: 480, rot: 0, z: 1, opacity: 1, class: [], style: {},
      sourceBox: null,
    });
    const store = new EditorStore(deck, '/tmp/effects');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);
    store.select(['photo']);

    expect(host.querySelector('.insp-title')?.textContent).toBe('image');
    expect([...host.querySelectorAll<HTMLElement>('.insp-group')]
      .some((section) => section.querySelector('h3')?.textContent === 'Image')).toBe(false);
    const sections = [...host.querySelectorAll<HTMLElement>('.insp-type-sections .insp-option-section')];
    expect(sections.map((section) => section.querySelector('h4')?.textContent))
      .toEqual(['Sizing', 'Masking - non-destructive & revertible', 'Border', 'Effects']);
    expect(sections[0].textContent).toContain('Keep aspect ratio');
    expect(sections[1].textContent).toContain('Corner radius');
    expect(sections[1].textContent).toContain('Circular mask');
    expect(sections[1].textContent).toContain('Edit mask');
    expect(sections[2].textContent).toContain('Color');
    expect(sections[2].textContent).toContain('Width');
    expect(sections[2].textContent).not.toContain('Corner radius');

    const add = (kind: string) => {
      const picker = host.querySelector<HTMLSelectElement>('.effect-add')!;
      picker.value = kind;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    };
    add('blur');
    add('grayscale');
    add('posterize');
    let image = store.selectedElements()[0];
    expect(image.type).toBe('image');
    if (image.type !== 'image') throw new Error('expected image');
    expect(image.effects?.map((effect) => effect.type)).toEqual(['blur', 'grayscale', 'posterize']);

    host.querySelectorAll<HTMLElement>('.media-effect-row')[2]
      .querySelector<HTMLButtonElement>('button[title="Move effect earlier"]')!.click();
    image = store.selectedElements()[0];
    if (image.type !== 'image') throw new Error('expected image');
    expect(image.effects?.map((effect) => effect.type)).toEqual(['blur', 'posterize', 'grayscale']);

    const blurInput = host.querySelector<HTMLInputElement>('.media-effect-row input')!;
    blurInput.value = '24';
    blurInput.dispatchEvent(new Event('change', { bubbles: true }));
    image = store.selectedElements()[0];
    if (image.type !== 'image') throw new Error('expected image');
    expect(image.effects?.[0]).toEqual({ type: 'blur', radius: 24 });

    host.querySelector<HTMLButtonElement>('.media-effect-row button[title="Remove effect"]')!.click();
    image = store.selectedElements()[0];
    if (image.type !== 'image') throw new Error('expected image');
    expect(image.effects?.map((effect) => effect.type)).toEqual(['posterize', 'grayscale']);
  });

  it('shows and takes ownership of representable legacy CSS effects', () => {
    const deck = emptyDeck('Legacy effects');
    deck.slides[0].elements.push({
      id: 'photo', type: 'image', src: 'photo.png', fit: 'contain', alt: '',
      x: 0, y: 0, w: 640, h: 480, rot: 0, z: 1, opacity: 1, class: [],
      style: { filter: 'blur(9px) grayscale(0.25)' }, sourceBox: null,
    });
    const store = new EditorStore(deck, '/tmp/legacy-effects');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);
    store.select(['photo']);

    const rows = host.querySelectorAll<HTMLElement>('.media-effect-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Blur');
    expect(rows[1].textContent).toContain('Greyscale');

    const blur = rows[0].querySelector<HTMLInputElement>('input')!;
    blur.value = '4';
    blur.dispatchEvent(new Event('change', { bubbles: true }));

    const image = store.selectedElements()[0];
    if (image.type !== 'image') throw new Error('expected image');
    expect(image.style.filter).toBeUndefined();
    expect(image.effects).toEqual([
      { type: 'blur', radius: 4 },
      { type: 'grayscale', amount: 0.25 },
    ]);
  });

  it('offers raster paint for decoded images but not PDF embeds', () => {
    const deck = emptyDeck('Raster paint');
    deck.slides[0].elements.push({
      id: 'photo', type: 'image', src: 'assets/photo.png', fit: 'contain', alt: '',
      x: 0, y: 0, w: 640, h: 480, rot: 0, z: 1, opacity: 1, class: [], style: {},
      sourceBox: null,
    });
    const store = new EditorStore(deck, '/tmp/raster-paint');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const inspector = new Inspector(host, store);
    inspector.onRasterRequest = vi.fn();
    store.select(['photo']);

    const action = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Rasterize & paint…')!;
    expect(action).toBeDefined();
    action.click();
    expect(inspector.onRasterRequest).toHaveBeenCalledWith(store.selectedElements()[0]);

    store.updateSelected((element) => {
      if (element.type === 'image') element.src = 'assets/paper.pdf';
    });
    expect(host.textContent).not.toContain('Rasterize & paint…');
  });
});
