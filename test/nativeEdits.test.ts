import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { applyNativeEdits, nativeEditContract } from '../src/shared/nativeEdits.js';

function fixture(): Deck {
  return parseDeck({
    ...emptyDeck('Native edits'),
    themeStyle: {
      fonts: Object.fromEntries(['title', 'heading', 'body', 'caption', 'base'].map((role) => [role, {
        family: 'Helvetica', size: role === 'title' ? 72 : 36, weight: role === 'title' ? 700 : 400,
        lineHeight: 1.1, letterSpacing: '0em', color: '#fff',
      }])),
      palette: ['#111', '#fff'],
      colors: { background: '#111', text: '#fff', muted: '#aaa', accent: '#59f' },
    },
    slides: [{
      id: 's1', name: 'One', notes: 'Keep me', background: { color: null, image: null },
      comments: [{ id: 'c1', author: 'Human', text: 'Keep this too', ts: '2026-01-01', resolved: false }],
      elements: [
        { id: 'title', type: 'text', x: 100, y: 80, w: 800, h: 120, html: 'Title', class: ['role-title'], style: { color: '#eee', 'letter-spacing': '0.01em' } },
        { id: 'body', type: 'text', x: 100, y: 260, w: 800, h: 300, html: 'Untouched body', class: ['role-body'], style: { color: '#ddd' } },
        { id: 'image', type: 'image', x: 1000, y: 100, w: 500, h: 300, src: 'assets/image.png' },
        { id: 'video', type: 'video', x: 1000, y: 450, w: 500, h: 300, src: 'assets/video.mp4' },
        { id: 'shape', type: 'shape', shape: 'path', x: 100, y: 700, w: 300, h: 200, path: 'M0 0 L1 1', pathSize: { w: 1, h: 1 }, control: { x: 200, y: 750 } },
      ],
      timeline: [{ id: 'b1', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'appear', target: 'body', value: null } }],
    }],
  });
}

describe('native surgical edits', () => {
  it('publishes machine-readable property discovery for every element type and scope', () => {
    const contract = nativeEditContract() as any;
    expect(contract.element.common.map((row: any) => row.path)).toContain('style.<css-property>');
    for (const type of ['text', 'image', 'video', 'shape', 'html', 'unsupported']) {
      expect(contract.element.byType).toHaveProperty(type);
    }
    expect(contract.slide.map((row: any) => row.path)).toContain('timeline');
    expect(contract.slide.map((row: any) => row.path)).toContain('morphDuration');
    expect(contract.deck.map((row: any) => row.path)).toContain('themeStyle.fonts.<role>.<property>');
    expect(contract.deck.map((row: any) => row.path)).not.toContain('morphDuration');
  });

  it('patches broad UI properties in one lossless operation batch', () => {
    const before = fixture();
    const untouchedBody = structuredClone(before.slides[0].elements[1]);
    const result = applyNativeEdits(before, [
      {
        target: 'element', slideId: 's1', elementId: 'title', expectedType: 'text',
        set: {
          align: 'right', valign: 'middle', x: 140, w: 1640,
          'style.font-family': 'Inter', 'style.font-size': '64px', 'style.font-weight': '650',
          'contentStyle.background-image': 'linear-gradient(90deg, #ff4fa3, #52d273)',
          'contentStyle.background-clip': 'text',
          'contentStyle.-webkit-text-fill-color': 'transparent',
          autoFit: true, paragraphSpacing: 10,
        },
        unset: ['style.letter-spacing'],
      },
      {
        target: 'element', slideId: 's1', elementId: 'image', expectedType: 'image',
        set: { fit: 'cover', maskShape: 'circle', sourceBox: { x: -20, y: 0, w: 600, h: 360 }, borderWidth: 3, borderRadius: 18, effects: [{ type: 'grayscale', amount: 0.5 }] },
        unset: [],
      },
      {
        target: 'element', slideId: 's1', elementId: 'video', expectedType: 'video',
        set: { autoplay: false, loop: false, muted: true, controls: true, start: 1.25, end: 8.5, fit: 'contain' },
        unset: [],
      },
      {
        target: 'element', slideId: 's1', elementId: 'shape', expectedType: 'shape',
        set: { x: 150, y: 725, fill: '#2463eb', stroke: '#fff', strokeWidth: 4, arrowEnd: true },
        unset: [],
      },
      {
        target: 'slide', slideId: 's1',
        set: { name: 'Unified', 'background.color': '#101218', layout: 'standard', morphFromPrevious: true, morphDuration: 850, skipped: false },
        unset: [],
      },
      {
        target: 'deck',
        set: { title: 'Unified deck', morphEasing: 'ease-out', 'themeStyle.fonts.title.family': 'Inter' },
        unset: [],
      },
    ]);

    const slide = result.deck.slides[0];
    const title = slide.elements.find((element) => element.id === 'title')!;
    const image = slide.elements.find((element) => element.id === 'image')!;
    const video = slide.elements.find((element) => element.id === 'video')!;
    const shape = slide.elements.find((element) => element.id === 'shape')!;
    expect(title).toMatchObject({
      align: 'right', valign: 'middle', x: 140, w: 1640, autoFit: true, paragraphSpacing: 10,
      style: { 'font-family': 'Inter', 'font-size': '64px', 'font-weight': '650', color: '#eee' },
      contentStyle: {
        'background-image': 'linear-gradient(90deg, #ff4fa3, #52d273)',
        'background-clip': 'text',
        '-webkit-text-fill-color': 'transparent',
      },
    });
    expect((title as any).style).not.toHaveProperty('letter-spacing');
    expect(image).toMatchObject({ fit: 'cover', maskShape: 'circle', borderWidth: 3, borderRadius: 18 });
    expect(video).toMatchObject({ autoplay: false, loop: false, muted: true, controls: true, start: 1.25, end: 8.5 });
    expect(shape).toMatchObject({ x: 150, y: 725, fill: '#2463eb', stroke: '#fff', strokeWidth: 4, arrowEnd: true, control: { x: 250, y: 775 } });
    expect(slide.elements[1]).toEqual(untouchedBody);
    expect(slide.comments).toEqual(before.slides[0].comments);
    expect(slide.timeline).toEqual(before.slides[0].timeline);
    expect(slide).toMatchObject({ name: 'Unified', background: { color: '#101218', image: null }, layout: 'standard', morphFromPrevious: true, morphDuration: 850, skipped: false });
    expect(result.deck).toMatchObject({ title: 'Unified deck', morphEasing: 'ease-out' });
    expect(result.deck.themeStyle?.fonts.title.family).toBe('Inter');
    expect(result.operations.map((operation) => operation.op)).toEqual(expect.arrayContaining(['updateDeck', 'setSlideProperties', 'replaceElement']));
    expect(result.affectedElementIds).toEqual(['title', 'image', 'video', 'shape']);
  });

  it('rejects identity, importer metadata, wrong types, bad dimensions, and invalid font sizes', () => {
    const deck = fixture();
    const reject = (set: Record<string, unknown>, expectedType: any = 'text') => expect(() => applyNativeEdits(deck, [{
      target: 'element', slideId: 's1', elementId: 'title', expectedType, set, unset: [],
    }])).toThrow();
    reject({ id: 'different' });
    reject({ type: 'shape' });
    reject({ lineageId: 'rewritten' });
    reject({ style: { color: '#fff' } });
    reject({ w: 4 });
    reject({ 'style.font-size': '5px' });
    reject({ 'style.font-size': 'huge' });
    reject({ align: 'right' }, 'image');
    expect(() => applyNativeEdits(deck, [{
      target: 'element', slideId: 's1', elementId: 'image',
      set: { sourceBox: { x: 0, y: 0, w: 600, h: 360 }, 'sourceBox.x': 20 }, unset: [],
    }])).toThrow('overlap');
  });

  it('rejects deleting required values and no-op edits', () => {
    const deck = fixture();
    expect(() => applyNativeEdits(deck, [{ target: 'element', slideId: 's1', elementId: 'title', set: {}, unset: ['w'] }])).toThrow();
    expect(() => applyNativeEdits(deck, [{ target: 'element', slideId: 's1', elementId: 'title', set: { align: 'left' }, unset: [] }])).toThrow('do not change');
  });
});
