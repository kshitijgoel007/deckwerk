import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type SlideElement } from '../src/shared/deck.js';
import {
  buildFromNode,
  elementFromNode,
  htmlSlideScope,
  slideFromMeasured,
  slideToHtml,
  slidesToHtml,
  type MeasuredNode,
} from '../src/shared/htmlSlides.js';

/**
 * The pure half of HTML authoring: browser-measured facts in, deck objects out.
 *
 * These tests are about *meaning* — that a measured `<img>` becomes an image
 * element with its crop, that a build attribute becomes a timeline entry. The
 * question of whether the browser measured the right thing is a different one,
 * answered by the round-trip test.
 */

function node(over: Partial<MeasuredNode> = {}): MeasuredNode {
  return {
    tag: 'p',
    elementId: null,
    classes: [],
    dataset: {},
    rect: { x: 100, y: 200, w: 800, h: 120 },
    rotation: 0,
    opacity: 1,
    style: {},
    html: 'Hello',
    attrs: {},
    ...over,
  };
}

describe('measured nodes become deck objects', () => {
  it('maps a text node, keeping its classes and authored inline style', () => {
    const element = elementFromNode(node({
      tag: 'h1',
      classes: ['role-title'],
      style: { color: '#ff3366', 'font-size': '80px' },
      attrs: { textAlign: 'center' },
      html: 'A title',
    }), 'title-1', 3);

    expect(element).toMatchObject({
      id: 'title-1', type: 'text', x: 100, y: 200, w: 800, h: 120, z: 3,
      class: ['role-title'], align: 'center', valign: 'top', html: 'A title',
    });
    expect(element?.style).toEqual({ color: '#ff3366', 'font-size': '80px' });
  });

  it('drops layout declarations that did their job during measurement', () => {
    // `display: flex` on an absolutely positioned box would re-flow the text
    // the geometry was measured against.
    const element = elementFromNode(node({
      style: { display: 'flex', margin: '20px', color: '#111111' },
    }), 'text-1', 1);
    expect(element?.style).toEqual({ color: '#111111' });
  });

  it('maps media with its crop, trim and fit', () => {
    const image = elementFromNode(node({
      tag: 'img',
      attrs: { src: 'assets/figure.png', alt: 'Figure', objectFit: 'cover' },
      dataset: { crop: '-100,-50,1920,1080' },
    }), 'figure', 2) as Extract<SlideElement, { type: 'image' }>;
    expect(image).toMatchObject({ type: 'image', src: 'assets/figure.png', alt: 'Figure', fit: 'cover' });
    expect(image.sourceBox).toEqual({ x: -100, y: -50, w: 1920, h: 1080 });

    const video = elementFromNode(node({
      tag: 'video',
      attrs: { src: 'assets/clip.mp4', loop: true, muted: true },
      dataset: { trim: '2,8' },
    }), 'clip', 2) as Extract<SlideElement, { type: 'video' }>;
    expect(video).toMatchObject({ type: 'video', start: 2, end: 8, loop: true });

    // An open-ended trim means "to the end of the file", not zero.
    const untrimmed = elementFromNode(node({
      tag: 'video', attrs: { src: 'a.mp4' }, dataset: { trim: '3,' },
    }), 'clip2', 2) as Extract<SlideElement, { type: 'video' }>;
    expect(untrimmed).toMatchObject({ start: 3, end: null });
  });

  it('previews and round-trips round media masks without requiring a border', () => {
    const deck = emptyDeck('Masks');
    deck.slides[0].elements = [{
      id: 'video', type: 'video', x: 10, y: 20, w: 500, h: 300, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, src: 'assets/demo.mp4', fit: 'cover',
      autoplay: true, loop: true, muted: true, controls: false, start: 0, end: null,
      poster: null, sourceBox: null, maskShape: 'circle', effects: [{ type: 'blur', radius: 8 }],
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-mask-shape="circle"');
    expect(html).toContain('border-radius:50%');
    expect(html).toContain('overflow:hidden');
    expect(html).toContain('filter:blur(8px)');

    const measured = elementFromNode(node({
      tag: 'video', dataset: { maskShape: 'circle' }, attrs: { src: 'assets/demo.mp4' },
    }), 'video', 1);
    expect(measured).toMatchObject({ type: 'video', maskShape: 'circle' });
  });

  it('round-trips Gaussian noise settings on text and video', () => {
    const encoded = encodeURIComponent(JSON.stringify([{
      type: 'gaussianNoise', amount: 0.45, frequencyCutoff: 0.2,
    }]));
    const text = elementFromNode(node({
      tag: 'p', dataset: { effects: encoded }, html: 'Noisy title',
    }), 'title', 1);
    expect(text).toMatchObject({
      type: 'text',
      effects: [{ type: 'gaussianNoise', amount: 0.45, frequencyCutoff: 0.2 }],
    });

    const video = elementFromNode(node({
      tag: 'video', dataset: { effects: encoded }, attrs: { src: 'assets/demo.mp4' },
    }), 'clip', 2);
    expect(video).toMatchObject({
      type: 'video',
      effects: [{ type: 'gaussianNoise', amount: 0.45, frequencyCutoff: 0.2 }],
    });

    const deck = emptyDeck('Noise');
    deck.slides[0].elements = [text!, video!];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html.match(/data-effects=/g)).toHaveLength(2);
    expect(html).toContain('gaussianNoise');
  });

  it('previews media borders as overlays and keeps their typed fields on round trip', () => {
    const deck = emptyDeck('Borders');
    deck.slides[0].elements = [{
      id: 'image', type: 'image', x: 10, y: 20, w: 500, h: 300, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, src: 'assets/demo.png', fit: 'cover', alt: '',
      sourceBox: null, borderColor: '#ff3366', borderWidth: 8, borderRadius: 14,
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-border-width="8"');
    expect(html).toContain('data-border-color="#ff3366"');
    expect(html).toContain('data-border-radius="14"');
    expect(html).toContain('outline:8px solid #ff3366');
    expect(html).toContain('outline-offset:-8px');
    expect(html).not.toContain('border:8px solid #ff3366');

    const measured = elementFromNode(node({
      tag: 'img',
      dataset: { borderWidth: '8', borderColor: '#ff3366', borderRadius: '14' },
      attrs: { src: 'assets/demo.png' },
      style: { 'border-radius': '14px', border: '8px solid #ff3366' },
    }), 'image', 1);
    expect(measured).toMatchObject({
      type: 'image', borderColor: '#ff3366', borderWidth: 8, borderRadius: 14,
      style: {},
    });
  });

  it('reconstructs shapes from their parameters rather than flattening them', () => {
    const shape = elementFromNode(node({
      tag: 'div',
      dataset: {
        element: 'shape', shape: 'arrow', stroke: '#111111', strokeWidth: '6',
        arrowEnd: 'true', control: '950,300',
      },
    }), 'arrow-1', 2) as Extract<SlideElement, { type: 'shape' }>;

    expect(shape).toMatchObject({
      type: 'shape', shape: 'arrow', stroke: '#111111', strokeWidth: 6,
      arrowEnd: true, arrowStart: false,
    });
    expect(shape.control).toEqual({ x: 950, y: 300 });
  });

  it('keeps an import gap conspicuous instead of quietly dropping it', () => {
    const gap = elementFromNode(node({
      tag: 'div',
      dataset: { element: 'unsupported', originalType: 'TSD.ChartArchive' },
      html: 'TSD.ChartArchive: a bar chart',
    }), 'gap-1', 1) as Extract<SlideElement, { type: 'unsupported' }>;

    expect(gap).toMatchObject({ type: 'unsupported', originalType: 'TSD.ChartArchive' });
    expect(gap.note).toBe('TSD.ChartArchive: a bar chart');
  });

  it('preserves markup it cannot reduce to a known object', () => {
    const svg = elementFromNode(node({
      tag: 'svg', verbatim: true, html: '<svg viewBox="0 0 10 10"><circle r="4"/></svg>',
    }), 'chart', 1);
    expect(svg).toMatchObject({ type: 'html' });
    expect((svg as Extract<SlideElement, { type: 'html' }>).html).toContain('<circle');
  });

  it('refuses a node with no area, which would be an invisible object', () => {
    expect(elementFromNode(node({ rect: { x: 0, y: 0, w: 0, h: 40 } }), 'empty', 1)).toBeNull();
  });

  it('turns build attributes into timeline entries', () => {
    expect(buildFromNode(node({ dataset: { build: 'click' } }), 'bullet', 0)).toMatchObject({
      trigger: { on: 'click', delay: 0 },
      action: { type: 'appear', target: 'bullet' },
    });
    expect(buildFromNode(node({ dataset: { build: 'afterPrev+500' } }), 'bullet', 1))
      .toMatchObject({ trigger: { on: 'afterPrev', delay: 500 } });
    expect(buildFromNode(node(), 'bullet', 0)).toBeNull();
  });

  it('mints ids only where the author has not kept one, and never collides', () => {
    const slide = slideFromMeasured({
      id: 'results',
      name: 'Results',
      notes: '',
      background: { color: '#ffffff', image: null },
      magicMoveFromPrevious: false,
      nodes: [
        node({ elementId: 'kept-id' }),
        node({ tag: 'h1' }),
        node({ tag: 'h1' }),
      ],
    }, { slideId: 'results', usedIds: new Set(['results-h1-2']) });

    const ids = slide.elements.map((element) => element.id);
    expect(ids[0]).toBe('kept-id');
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain('results-h1-2');
    // Paint order follows document order.
    expect(slide.elements.map((element) => element.z)).toEqual([1, 2, 3]);
  });
});

describe('deck objects become authored HTML', () => {
  it('records the ordered authoritative scope in the exported document', () => {
    const deck = emptyDeck('Scope');
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'résults / 2' });
    const html = slidesToHtml(deck.slides, deck.canvas);

    expect(htmlSlideScope(html)).toEqual(['slide-1', 'résults / 2']);
    expect(html.match(/slide-editor-scope:/g)).toHaveLength(1);
    expect(htmlSlideScope('<section class="slide"></section>')).toBeNull();
  });

  it('round-trips a shape through its data attributes', () => {
    const deck = emptyDeck('Shapes');
    deck.slides[0].elements = [{
      id: 'arrow', type: 'shape', x: 200, y: 300, w: 400, h: 120, rot: 15, z: 2,
      opacity: 1, class: [], style: {}, shape: 'arrow', fill: null, stroke: '#111111',
      strokeWidth: 6, radius: 0, path: null, pathSize: null, arrowStart: false,
      arrowEnd: true, control: { x: 400, y: 240 },
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });

    expect(html).toContain('data-element="shape"');
    expect(html).toContain('data-shape="arrow"');
    expect(html).toContain('data-control="400,240"');
    expect(html).toContain('data-arrow-end="true"');
    expect(html).not.toContain('data-arrow-start');
  });

  it('exports text with the attributes that have no CSS equivalent', () => {
    const deck = emptyDeck('Text');
    deck.slides[0].elements = [{
      id: 'quote', type: 'text', x: 10, y: 20, w: 300, h: 100, rot: 0, z: 1,
      opacity: 1, class: ['role-title'], style: {}, html: 'Hi', align: 'center',
      valign: 'middle', autoFit: true,
    }];
    deck.slides[0].timeline = [{
      id: 't1',
      trigger: { on: 'afterPrev', ref: null, delay: 250 },
      action: { type: 'appear', target: 'quote', value: null },
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });

    expect(html).toContain('data-valign="middle"');
    expect(html).toContain('data-autofit="true"');
    expect(html).toContain('data-build="afterPrev+250"');
    expect(html).toContain('text-align:center');
  });

  it('mirrors inheritable inline text styles onto the content node', () => {
    // A theme rule targeting `.text-content` directly would otherwise beat
    // the wrapper's inline style; the mirror keeps the element's colour
    // authoritative in the compiled document too.
    const deck = emptyDeck('Mirror');
    deck.slides[0].elements = [{
      id: 'title', type: 'text', x: 10, y: 20, w: 300, h: 100, rot: 0, z: 1,
      opacity: 1, class: ['role-title'],
      style: { color: '#ffffff', 'font-size': '112px' },
      html: 'Hi', align: 'left', valign: 'middle',
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });

    expect(html).toMatch(/class="text-content"[^>]*style="[^"]*color:#ffffff/);
    // font-size stays off the content node — auto-fit owns it there.
    expect(html).not.toMatch(/class="text-content"[^>]*style="[^"]*font-size/);
  });

  it('round-trips advanced inner text CSS independently of wrapper CSS', () => {
    const gradient = {
      'background-image': 'linear-gradient(90deg, #ff4fa3, #52d273)',
      'background-clip': 'text',
      '-webkit-text-fill-color': 'transparent',
    };
    const element = elementFromNode(node({
      dataset: { contentStyle: encodeURIComponent(JSON.stringify(gradient)) },
      html: 'Gradient title',
    }), 'gradient-title', 1);
    expect(element).toMatchObject({ type: 'text', contentStyle: gradient });

    const deck = emptyDeck('Gradient');
    deck.slides[0].elements = [element!];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-content-style=');
    expect(html).toMatch(/class="text-content"[^>]*background-image:linear-gradient/);
    expect(html).not.toMatch(/class="element element-text"[^>]*background-image:linear-gradient/);
  });

  it('round-trips paragraph spacing through the data attribute', () => {
    const deck = emptyDeck('Spacing');
    deck.slides[0].elements = [{
      id: 'list', type: 'text', x: 10, y: 20, w: 300, h: 100, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, html: '<ul><li>a</li><li>b</li></ul>',
      align: 'left', valign: 'top', paragraphSpacing: 24,
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-paragraph-spacing="24"');
    expect(html).toContain('--paragraph-spacing:24px');

    const parsed = elementFromNode(node({
      tag: 'ul',
      html: '<li>a</li><li>b</li>',
      dataset: { paragraphSpacing: '24' },
    }), 'list', 1);
    expect(parsed).toMatchObject({ type: 'text', paragraphSpacing: 24 });
  });

  it('carries the slide identity a bake-back needs to find its target', () => {
    const html = slideToHtml(emptyDeck('Deck').slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-slide-id="slide-1"');
    expect(html).toContain('data-canvas="1920x1080"');
  });
});
