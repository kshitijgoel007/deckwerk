// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { classifyMedia } from '../src/main/deckStore.js';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { objectPositionOffset, paintedMediaBox, setCircularMask } from '../src/shared/mediaMask.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { applyElementBoxStyles, renderElement, syncMediaFrame } from '../src/renderer/player/render.js';

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

  /**
   * Element wrappers are absolutely positioned with no z-index, so the slide
   * paints them in document order. That makes any z-index *inside* a wrapper
   * resolve against the slide unless the wrapper is a stacking context -- so
   * the border overlay's `z-index:1` floated above every element rendered
   * after it, and moving a front video over a bordered one drew the bordered
   * one's frame across it.
   */
  it('keeps a media border from painting over the elements in front of it', () => {
    const node = renderElement({
      ...base, id: 'image', type: 'image', src: 'assets/image.png', fit: 'cover',
      alt: '', sourceBox: null, borderColor: '#ff3366', borderWidth: 8,
    }, { resolveSrc: (src) => src });
    const border = node.querySelector<HTMLElement>(':scope > .media-border-overlay')!;
    // The overlay still sits above its own media...
    expect(border.style.zIndex).toBe('1');
    // ...but that stacking is scoped to this element, not to the slide.
    expect(node.style.isolation).toBe('isolate');
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

  it('lets an explicit zero radius suppress stale CSS-authored rounded corners', () => {
    const element = {
      ...base, id: 'video', type: 'video' as const, src: 'assets/video.mp4', fit: 'cover' as const,
      autoplay: false, loop: false, muted: true, controls: false, start: 0, end: null,
      poster: null, sourceBox: null, style: { 'border-radius': '24px' },
    };
    const node = renderElement(element, { resolveSrc: (src) => src });
    expect(node.style.borderRadius).toBe('24px');

    syncMediaFrame(node, { ...element, borderRadius: 0 });
    expect(node.style.borderRadius).toBe('');
    expect(node.querySelector<HTMLVideoElement>('video')!.style.borderRadius).toBe('');
  });

  it('lets an explicit rectangular mask suppress a stale CSS circle', () => {
    const element = {
      ...base, id: 'image', type: 'image' as const, src: 'assets/image.png', fit: 'cover' as const,
      alt: '', sourceBox: null, style: { 'border-radius': '50%' },
    };
    const node = renderElement(element, { resolveSrc: (src) => src });
    expect(node.style.borderRadius).toBe('50%');

    syncMediaFrame(node, { ...element, maskShape: 'rect' });
    expect(node.style.borderRadius).toBe('');
    expect(node.querySelector<HTMLImageElement>('img')!.style.borderRadius).toBe('');
  });

  it('lets an explicit empty effect list suppress a stale CSS filter', () => {
    const node = renderElement({
      ...base, id: 'image', type: 'image', src: 'assets/image.png', fit: 'cover',
      alt: '', sourceBox: null, style: { filter: 'blur(18px)' }, effects: [],
    }, { resolveSrc: (src) => src });

    expect(node.style.filter).toBe('');
    expect(node.querySelector<HTMLImageElement>('img')!.style.filter).toBe('');
  });

  it('shows legacy CSS borders and circles in the inspector and can clear them', () => {
    const deck = emptyDeck('Legacy decoration');
    deck.slides[0].elements.push({
      ...base, id: 'image', type: 'image', src: 'assets/image.png', fit: 'cover',
      alt: '', sourceBox: null,
      style: { border: '7px solid #ff3366', 'border-radius': '50%' },
    });
    const store = new EditorStore(deck, '/tmp/legacy-decoration');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);
    store.select(['image']);

    const sections = [...host.querySelectorAll<HTMLElement>('.insp-option-section')];
    const masking = sections.find((section) => section.querySelector('h4')?.textContent === 'Mask')!;
    const border = sections.find((section) => section.querySelector('h4')?.textContent === 'Border')!;
    const circle = masking.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const width = border.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(circle.checked).toBe(true);
    expect(width.value).toBe('7');

    circle.checked = false;
    circle.dispatchEvent(new Event('change', { bubbles: true }));
    host.querySelector<HTMLElement>('.media-border-options')!
      .querySelector<HTMLInputElement>('input[type="number"]')!.value = '0';
    host.querySelector<HTMLElement>('.media-border-options')!
      .querySelector<HTMLInputElement>('input[type="number"]')!
      .dispatchEvent(new Event('change', { bubbles: true }));

    const image = store.selectedElements()[0];
    if (image.type !== 'image') throw new Error('expected image');
    expect(image.maskShape).toBe('rect');
    expect(image.borderWidth).toBe(0);
    expect(image.style).toEqual({});
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

describe('shape effect contours', () => {
  const shape = {
    ...base,
    id: 'shape',
    type: 'shape' as const,
    fill: '#ffffff',
    stroke: '#663399',
    strokeWidth: 4,
    arrowStart: false,
    arrowEnd: false,
    path: null,
    pathSize: null,
    control: null,
    style: { 'box-shadow': '0 20px 40px #0006' },
  };

  it('makes imported ellipse and rounded-rectangle shadows follow their SVG contour', () => {
    const ellipse = renderElement({ ...shape, shape: 'ellipse', radius: 0 }, { resolveSrc: (src) => src });
    const card = renderElement({ ...shape, shape: 'rect', radius: 31 }, { resolveSrc: (src) => src });

    expect(ellipse.style.borderRadius).toBe('50%');
    expect(card.style.borderRadius).toBe('31px');
  });

  it('clears the contour when a rounded shape becomes square', () => {
    const rounded = { ...shape, shape: 'rect' as const, radius: 31 };
    const square = { ...rounded, radius: 0 };
    const node = renderElement(rounded, { resolveSrc: (src) => src });

    applyElementBoxStyles(node, square, rounded);

    expect(node.style.borderRadius).toBe('');
  });
});

/**
 * `border-radius: 50%` only draws a circle on a square box, so a circular mask
 * on a 16:9 photo used to come out as an ellipse -- and the fix must not be to
 * squash the picture into a square. The window is squared instead, and the
 * picture moves into `sourceBox` keeping its own aspect ratio.
 */
describe('circular media masks', () => {
  type ImageElement = Extract<SlideElement, { type: 'image' }>;
  const photo: ImageElement = {
    ...base,
    id: 'photo',
    type: 'image',
    x: 100,
    y: 200,
    w: 800,
    h: 400,
    src: 'assets/photo.jpg',
    fit: 'cover',
    alt: '',
    sourceBox: null,
  };

  it('crops a wide photo to a true circle without reshaping it', () => {
    const el: ImageElement = { ...photo };
    setCircularMask(el, true, { w: 4000, h: 2000 });

    // A square window, centred on where the picture already was.
    expect(el.w).toBe(400);
    expect(el.h).toBe(400);
    expect(el.x).toBe(300);
    expect(el.y).toBe(200);
    // The picture keeps its 2:1 shape and its scale: `cover` had already sized
    // it to the box height, which is exactly the circle's diameter.
    expect(el.sourceBox!.w / el.sourceBox!.h).toBeCloseTo(2, 5);
    expect(el.sourceBox!.h).toBe(400);
    // Centred in the window, so the same part of the photo stays visible.
    expect(el.sourceBox!.x + el.sourceBox!.w / 2).toBe(200);
    expect(el.sourceBox!.y + el.sourceBox!.h / 2).toBe(200);
  });

  it('grows a contained picture just enough to fill the circle', () => {
    // Contained, a tall picture in a wide box paints far narrower than the
    // circle: left alone the mask would show slide through its sides.
    const el: ImageElement = { ...photo, fit: 'contain' };
    setCircularMask(el, true, { w: 1000, h: 2000 });

    expect(el.sourceBox!.w).toBe(400);
    expect(el.sourceBox!.h).toBe(800);
    expect(el.sourceBox!.w / el.sourceBox!.h).toBeCloseTo(0.5, 5);
  });

  it('undistorts a stretched picture rather than carrying the stretch into the crop', () => {
    const el: ImageElement = { ...photo, fit: 'fill' };
    setCircularMask(el, true, { w: 1000, h: 1000 });

    expect(el.sourceBox!.w).toBe(el.sourceBox!.h);
    expect(el.sourceBox!.w).toBe(800);
  });

  it('reads an imported picture where object-position actually framed it', () => {
    // An agent-authored page frames a portrait with `object-fit: cover` plus
    // `object-position`, which the deck renders faithfully but does not store
    // as a crop. Every mask and crop gesture starts from where the picture is
    // painted, so a placement rule that always centred meant the first nudge
    // of an imported portrait jumped it back to the middle of the photograph.
    const el: ImageElement = { ...photo, style: { 'object-position': '20% 30%' } };
    // 4000x2000 covering an 800x400 box needs no slack in either axis.
    expect(paintedMediaBox(el, { w: 4000, h: 2000 }))
      .toMatchObject({ w: 800, h: 400 });

    // A 4:3 picture in the same box overflows vertically by 200px, and 30%
    // of that overflow sits above the window.
    const tall = paintedMediaBox(el, { w: 400, h: 300 });
    expect(tall.w).toBeCloseTo(800, 6);
    expect(tall.h).toBeCloseTo(600, 6);
    expect(tall.x).toBeCloseTo(0, 6);
    expect(tall.y).toBeCloseTo(-60, 6);

    // Contained, the slack is positive: the picture sits inside the window.
    const contained = paintedMediaBox({ ...el, fit: 'contain' }, { w: 400, h: 300 });
    expect(contained.w).toBeCloseTo(533.333, 3);
    expect(contained.h).toBeCloseTo(400, 6);
    expect(contained.x).toBeCloseTo(53.333, 3);
    expect(contained.y).toBeCloseTo(0, 6);
  });

  it('reads keyword, length and single-value object-position the way CSS does', () => {
    const box = { w: 200, h: 100 };
    const drawn = { w: 400, h: 300 };
    const offset = (value: string | undefined) => {
      const { x, y } = objectPositionOffset(value, box, drawn);
      // Normalised, because a percentage of zero slack is `-0`.
      return { x: x + 0, y: y + 0 };
    };
    expect(offset('left top')).toEqual({ x: 0, y: 0 });
    // Keywords may be written in either order; a computed value never is.
    expect(offset('top left')).toEqual({ x: 0, y: 0 });
    expect(offset('right bottom')).toEqual({ x: -200, y: -200 });
    expect(offset('10px 20px')).toEqual({ x: 10, y: 20 });
    // One value sets the horizontal and centres the vertical.
    expect(offset('0%')).toEqual({ x: 0, y: -100 });
    // Absent or unparseable is the CSS initial value, which is centred.
    expect(offset(undefined)).toEqual({ x: -100, y: -100 });
    expect(offset('nonsense')).toEqual({ x: -100, y: -100 });
  });

  it('keeps the framing when a circular mask is put on an imported portrait', () => {
    // The window squares and the picture keeps the part that was visible --
    // the point being that "visible" means where object-position put it.
    // A 4:3 picture covering this 2:1 box overflows vertically, so `0%` keeps
    // the top of the photograph -- the head, in the case this comes from.
    const framed: ImageElement = { ...photo, style: { 'object-position': '50% 0%' } };
    setCircularMask(framed, true, { w: 400, h: 300 });
    const centred: ImageElement = { ...photo };
    setCircularMask(centred, true, { w: 400, h: 300 });

    expect(framed.sourceBox!.h).toBe(centred.sourceBox!.h);
    // Framed on the picture's top edge, so the crop sits lower than the
    // centred one rather than landing in the same place.
    expect(framed.sourceBox!.y).toBeGreaterThan(centred.sourceBox!.y);
  });

  it('leaves the crop alone when the mask is turned back off', () => {
    const el: ImageElement = { ...photo, style: { 'border-radius': '50%' } };
    setCircularMask(el, true, { w: 4000, h: 2000 });
    const circular = { ...el, sourceBox: { ...el.sourceBox! } };
    setCircularMask(el, false, { w: 4000, h: 2000 });

    expect(el.maskShape).toBe('rect');
    // The picture was never altered, so there is nothing to restore -- and the
    // stale CSS radius must not survive to redraw the circle.
    expect(el.sourceBox).toEqual(circular.sourceBox);
    expect(el.w).toBe(circular.w);
    expect(el.style).toEqual({});
  });

  it('falls back to the painted box when the intrinsic size is not known yet', () => {
    // Nothing is known about the picture, so the safe assumption is that what
    // filled the box is what the author sees: crop the centred circle out of
    // it at that scale rather than guessing an aspect ratio.
    const el: ImageElement = { ...photo };
    setCircularMask(el, true, null);

    expect(el.w).toBe(400);
    expect(el.sourceBox).toEqual({ x: -200, y: 0, w: 800, h: 400 });
  });
});
