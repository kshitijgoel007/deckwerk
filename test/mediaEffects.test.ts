// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
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
});
