// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentContextSchema,
  authoredScene,
  type AgentContextDraft,
  type AgentResponse,
  type ComputedSlideScene,
} from '../src/shared/agent.js';
import { type Deck, type Slide, type SlideElement, emptyDeck, parseDeck } from '../src/shared/deck.js';
import { AgentBridge, browserDeckRevision } from '../src/renderer/editor/agentBridge.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * What the agent sees. The contract is that the sidecar describes the editor's
 * *computed* view — where objects actually landed, what the text actually
 * became after auto-fit — rather than re-deriving it from the authored numbers,
 * because the gap between those two is exactly what an agent is asked to fix.
 */

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

/**
 * jsdom does no layout, so every box measures 0×0 and the authored-versus-
 * rendered distinction this module exists to expose would be untestable. Give
 * it just enough of one: boxes take the size the renderer wrote, text is one
 * line of half-em glyphs. Crude, but it is a real measurement loop, and what
 * is under test is that the bridge reports what it measured rather than
 * re-deriving it from the authored numbers.
 */
function styleLength(node: HTMLElement, property: 'width' | 'height'): number {
  // Only pixel values count. The renderer sizes inner wrappers with `100%`,
  // which resolves against the nearest ancestor that has a real size.
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const declared = current.style[property];
    if (declared.endsWith('px')) return Number.parseFloat(declared);
  }
  return 0;
}

/** Font size inherits, so the nearest ancestor that declares one wins. */
function fontSize(node: HTMLElement): number {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const declared = current.style.fontSize;
    if (declared.endsWith('px')) return Number.parseFloat(declared);
  }
  return 16;
}

Object.defineProperties(HTMLElement.prototype, {
  clientWidth: { configurable: true, get(this: HTMLElement) { return styleLength(this, 'width'); } },
  clientHeight: { configurable: true, get(this: HTMLElement) { return styleLength(this, 'height'); } },
  scrollWidth: {
    configurable: true,
    get(this: HTMLElement) {
      return 0.5 * fontSize(this) * (this.textContent ?? '').length;
    },
  },
  scrollHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return 1.2 * fontSize(this);
    },
  },
});
Element.prototype.getBoundingClientRect = function boundingRect(this: Element): DOMRect {
  const style = (this as HTMLElement).style;
  const px = (value: string) => Number.parseFloat(value) || 0;
  const x = px(style.left);
  const y = px(style.top);
  const w = px(style.width);
  const h = px(style.height);
  return {
    x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h,
    toJSON: () => ({}),
  } as DOMRect;
};

const text = (id: string, html: string, over: Partial<Extract<SlideElement, { type: 'text' }>> = {}) => ({
  id, type: 'text' as const, x: 100, y: 60, w: 600, h: 200, rot: 0, z: 1, opacity: 1,
  class: ['role-title'], style: {}, html, align: 'left' as const, valign: 'top' as const, ...over,
});

function makeSlide(id: string, elements: SlideElement[] = [], over: Partial<Slide> = {}): Slide {
  return {
    id, name: id, background: { color: null, image: null }, notes: '',
    elements, timeline: [], ...over,
  };
}

function deckOf(...slides: Slide[]): Deck {
  const deck = emptyDeck('Context');
  deck.slides = slides;
  return parseDeck(deck);
}

interface Harness {
  store: EditorStore;
  bridge: AgentBridge;
  published: AgentContextDraft[];
  responses: AgentResponse[];
  saves: number;
  latest: () => AgentContextDraft;
  scene: (slideId: string) => ComputedSlideScene;
}

function harness(deck: Deck): Harness {
  const store = new EditorStore(deck, '/decks/context');
  const published: AgentContextDraft[] = [];
  const responses: AgentResponse[] = [];
  const state = { saves: 0 };
  const bridge = new AgentBridge(store, {
    publish: async (context) => {
      published.push(context);
    },
    respond: (response) => responses.push(response),
    save: async () => {
      state.saves += 1;
    },
    resolveSrc: (src) => src,
  });
  const h: Harness = {
    store,
    bridge,
    published,
    responses,
    get saves() {
      return state.saves;
    },
    latest: () => published[published.length - 1],
    scene: (slideId) => {
      const scene = published[published.length - 1].scenes.find((s) => s.id === slideId);
      if (!scene) throw new Error(`No published scene for ${slideId}`);
      return scene;
    },
  } as Harness;
  return h;
}

describe('agent context publication', () => {
  beforeEach(() => document.body.replaceChildren());

  it('reuses the deck revision across selection-only context publications', async () => {
    const deck = deckOf(
      makeSlide('slide-1', [text('a', 'One')]),
      makeSlide('slide-2', [text('b', 'Two')]),
    );
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    const h = harness(deck);

    await h.bridge.flush();
    h.store.selectSlide(1);
    await h.bridge.flush();
    h.store.select(['b']);
    await h.bridge.flush();

    expect(digest).toHaveBeenCalledTimes(1);
    digest.mockRestore();
  });

  it('publishes the active slide, a rail range and the object selection', async () => {
    const deck = deckOf(
      makeSlide('slide-1', [text('a', 'One')]),
      makeSlide('slide-2', [text('b', 'Two')]),
      makeSlide('slide-3', [text('c', 'Three')]),
    );
    const h = harness(deck);

    h.store.selectSlide(1);
    await h.bridge.flush();
    expect(h.latest().activeSlideId).toBe('slide-2');
    expect(h.latest().selectedSlideIds).toEqual(['slide-2']);

    h.store.selectSlide(2, true);
    await h.bridge.flush();
    expect(h.latest().selectedSlideIds).toEqual(['slide-2', 'slide-3']);
    expect(h.latest().scenes.map((s) => s.id)).toEqual(['slide-2', 'slide-3']);
    expect(h.latest().scenes.map((s) => s.index)).toEqual([1, 2]);

    h.store.selectSlide(0);
    h.store.select(['a']);
    await h.bridge.flush();
    expect(h.latest().selectedElementIds).toEqual(['a']);
    expect(h.scene('slide-1').elements[0].selected).toBe(true);
    expect(h.scene('slide-1').active).toBe(true);
  });

  it('keeps ids stable across edits and reordering', async () => {
    const deck = deckOf(
      makeSlide('slide-1', [text('a', 'One')]),
      makeSlide('slide-2', [text('b', 'Two')]),
    );
    const h = harness(deck);
    h.store.selectSlide(1);
    h.store.select(['b']);
    await h.bridge.flush();
    const before = h.latest().deckRevision;

    h.store.updateSelected((element) => {
      element.x = 400;
    }, { label: 'Move object' });
    await h.bridge.flush();
    expect(h.latest().selectedElementIds).toEqual(['b']);
    expect(h.latest().activeSlideId).toBe('slide-2');
    expect(h.latest().deckRevision).not.toBe(before);

    // A rewrite that inserts a slide ahead of the cursor moves every index.
    // The user is still on slide-2, and the agent is still told so.
    const reordered = parseDeck(h.store.get().deck);
    reordered.slides.unshift(makeSlide('slide-0', [text('z', 'Zero')]));
    h.store.replaceExternal(reordered, '/decks/context');
    await h.bridge.flush();

    expect(h.latest().activeSlideId).toBe('slide-2');
    expect(h.latest().activeSlideIndex).toBe(2);
    expect(h.scene('slide-2').index).toBe(2);
    expect(h.scene('slide-2').elements.map((e) => e.id)).toEqual(['b']);
    expect([...h.store.get().selection]).toEqual(['b']);
  });

  it('reports computed geometry, typography, overflow and builds', async () => {
    const fitted = text('fitted', 'A very long title that will not fit', {
      autoFit: true,
      style: { 'font-size': '80px' },
      w: 200,
      h: 60,
    });
    const bullet = text('bullet', 'Second line', { id: 'bullet', y: 400 });
    const spilling = text('spilling', 'This line is authored too large for its box', {
      id: 'spilling', y: 700, w: 150, h: 60, style: { 'font-size': '80px' },
    });
    const deck = deckOf(makeSlide('slide-1', [fitted, bullet, spilling], {
      timeline: [{
        id: 'build-1',
        trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'bullet', value: null },
      }],
    }));
    const h = harness(deck);
    h.store.select(['bullet']);
    await h.bridge.flush();

    const scene = h.scene('slide-1');
    expect(scene.timeline).toHaveLength(1);
    expect((scene.timeline[0] as { action: { target: string } }).action.target).toBe('bullet');

    const title = scene.elements.find((e) => e.id === 'fitted')!;
    expect(title.authored).toMatchObject({ x: 100, y: 60, w: 200, h: 60, rot: 0, opacity: 1 });
    expect(title.rendered).toEqual({ x: 100, y: 60, w: 200, h: 60 });
    expect(title.text?.plain).toBe('A very long title that will not fit');
    expect(title.selected).toBe(false);
    expect(scene.elements.find((e) => e.id === 'bullet')!.selected).toBe(true);

    // Auto-fit shrank the title well below its authored 80px ceiling, and the
    // published value is the size it actually settled at.
    expect(title.text?.fittedFontSize).toBeLessThan(80);
    expect(title.text?.fittedFontSize).toBeGreaterThan(6);
    expect(title.text?.overflowX).toBe(false);
    expect(title.computedStyle['text-align']).toBe('left');

    // Without auto-fit, text that does not fit is reported as overflowing
    // rather than quietly clipped.
    const spilled = scene.elements.find((e) => e.id === 'spilling')!;
    expect(spilled.text?.fittedFontSize).toBeNull();
    expect(spilled.text?.overflowX).toBe(true);
  });

  it('describes media and shape geometry the way the inspector does', async () => {
    const video: SlideElement = {
      id: 'clip', type: 'video', x: 0, y: 0, w: 960, h: 540, rot: 0, z: 1, opacity: 0.5,
      class: [], style: {}, src: 'assets/testclip.mp4', fit: 'cover', autoplay: true,
      loop: true, muted: true, controls: false, start: 2, end: 8, poster: null,
      sourceBox: { x: -100, y: -50, w: 1920, h: 1080 },
      effects: [{ type: 'blur', radius: 4 }],
      borderColor: '#ff3366', borderWidth: 6, borderRadius: 12,
    };
    const arrow: SlideElement = {
      id: 'arrow', type: 'shape', x: 200, y: 700, w: 400, h: 120, rot: 15, z: 2, opacity: 1,
      class: [], style: {}, shape: 'arrow', fill: null, stroke: '#111111', strokeWidth: 4,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: true,
      control: { x: 400, y: 640 },
    };
    const paired = text('paired', 'Shared', { magicMoveId: 'mm-1', lineageId: 'origin-1' });
    const h = harness(deckOf(makeSlide('slide-1', [video, arrow, paired])));
    await h.bridge.flush();

    const scene = h.scene('slide-1');
    const media = scene.elements.find((e) => e.id === 'clip')!;
    expect(media.media).toMatchObject({
      src: 'assets/testclip.mp4', fit: 'cover', borderColor: '#ff3366',
      borderWidth: 6, borderRadius: 12, duration: 6,
    });
    expect(media.media?.sourceBox).toEqual({ x: -100, y: -50, w: 1920, h: 1080 });
    expect(media.media?.effects).toEqual([{ type: 'blur', radius: 4 }]);
    expect(media.authored.opacity).toBe(0.5);

    const shape = scene.elements.find((e) => e.id === 'arrow')!;
    expect(shape.shape).toMatchObject({ kind: 'arrow', arrowEnd: true, arrowStart: false, strokeWidth: 4 });
    expect(shape.shape?.control).toEqual({ x: 400, y: 640 });
    expect(shape.authored.rot).toBe(15);

    const magic = scene.elements.find((e) => e.id === 'paired')!;
    expect(magic.magicMoveId).toBe('mm-1');
    expect(magic.lineageId).toBe('origin-1');
  });

  it('produces a schema-valid context document', async () => {
    const h = harness(deckOf(makeSlide('slide-1', [text('a', 'One')])));
    await h.bridge.flush();
    const parsed = AgentContextSchema.safeParse({
      ...h.latest(),
      live: true,
      sessionId: 'session',
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      deckPath: '/decks/context',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('offline authored fallback', () => {
  it('describes a slide from deck.json alone when no editor is running', () => {
    const deck = deckOf(makeSlide('slide-1', [
      text('a', '<b>One</b> and two'),
      {
        id: 'figure', type: 'image', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 2, opacity: 1,
        class: [], style: {}, src: 'assets/swatch.png', fit: 'contain', alt: '', sourceBox: null,
      },
    ]));
    const scene = authoredScene(deck, deck.slides[0], 0, new Set(['slide-1']), new Set(['a']));

    expect(scene.selected).toBe(true);
    expect(scene.elements[0].selected).toBe(true);
    expect(scene.elements[0].text?.plain).toBe('One and two');
    // Authored inspection cannot measure, and says so rather than inventing.
    expect(scene.elements[0].rendered).toBeNull();
    expect(scene.elements[0].computedStyle).toEqual({});
    expect(scene.elements[1].media?.src).toBe('assets/swatch.png');
  });
});

describe('online transactions through the editor', () => {
  beforeEach(() => document.body.replaceChildren());

  it('applies as one named undo entry and preserves the selection', async () => {
    const deck = deckOf(
      makeSlide('slide-1', [text('a', 'One')]),
      makeSlide('slide-2', [text('b', 'Two')]),
    );
    const h = harness(deck);
    h.store.selectSlide(1);
    h.store.select(['b']);
    const revision = await browserDeckRevision(h.store.get().deck);
    const historyBefore = h.store.history().length;

    await h.bridge.handle({
      version: 1,
      id: 'req-1',
      kind: 'transaction',
      transaction: {
        version: 1,
        expectedRevision: revision,
        label: 'Insert a caption',
        operations: [{
          op: 'insertElements',
          slideId: 'slide-1',
          elements: [text('caption', 'Added by an agent', { id: 'caption' })],
        }],
      },
    });

    expect(h.responses[0]).toMatchObject({ status: 'applied' });
    expect(h.responses[0].revision).toBe(await browserDeckRevision(h.store.get().deck));
    expect(h.store.get().deck.slides[0].elements.map((e) => e.id)).toEqual(['a', 'caption']);
    expect(h.saves).toBe(1);

    // One entry, carrying the agent's own label.
    expect(h.store.history().length).toBe(historyBefore + 1);
    expect(h.store.history()[0].label).toBe('Insert a caption');

    // The user was working on slide 2 with an object selected; that is where
    // they still are.
    expect(h.store.get().slideIndex).toBe(1);
    expect([...h.store.get().selection]).toEqual(['b']);

    h.store.undo();
    expect(h.store.get().deck.slides[0].elements.map((e) => e.id)).toEqual(['a']);
    h.store.redo();
    expect(h.store.get().deck.slides[0].elements.map((e) => e.id)).toEqual(['a', 'caption']);
  });

  it('reports a conflict, with the current revision, when the user edited first', async () => {
    const h = harness(deckOf(makeSlide('slide-1', [text('a', 'One')])));
    const stale = await browserDeckRevision(h.store.get().deck);

    // A concurrent UI edit between the agent reading the context and sending.
    h.store.select(['a']);
    h.store.updateSelected((element) => {
      element.x = 900;
    }, { label: 'Move object' });

    await h.bridge.handle({
      version: 1,
      id: 'req-2',
      kind: 'transaction',
      transaction: {
        version: 1,
        expectedRevision: stale,
        label: 'Too late',
        operations: [{ op: 'updateDeck', title: 'Renamed' }],
      },
    });

    const response = h.responses[0];
    expect(response.status).toBe('conflict');
    expect(response.revision).toBe(await browserDeckRevision(h.store.get().deck));
    expect(h.store.get().deck.title).toBe('Context');
    expect(h.saves).toBe(0);
  });

  it('rejects an invalid transaction without touching the document', async () => {
    const h = harness(deckOf(makeSlide('slide-1', [text('a', 'One')])));
    const revision = await browserDeckRevision(h.store.get().deck);
    const before = JSON.stringify(h.store.get().deck);

    await h.bridge.handle({
      version: 1,
      id: 'req-3',
      kind: 'transaction',
      transaction: {
        version: 1,
        expectedRevision: revision,
        label: 'Broken',
        operations: [{ op: 'deleteElements', slideId: 'slide-1', elementIds: ['ghost'] }],
      },
    });

    expect(h.responses[0]).toMatchObject({ status: 'error' });
    expect(h.responses[0].message).toMatch(/Unknown element id/);
    expect(JSON.stringify(h.store.get().deck)).toBe(before);
    expect(h.saves).toBe(0);
  });

  it('answers a DOM request with inlined styles and marked selection', async () => {
    const h = harness(deckOf(makeSlide('slide-1', [text('a', 'One'), text('b', 'Two', { id: 'b', y: 400 })])));
    h.store.select(['b']);
    const revision = await browserDeckRevision(h.store.get().deck);

    await h.bridge.handle({ version: 1, id: 'req-4', kind: 'dom', expectedRevision: revision });

    expect(h.responses[0].status).toBe('ok');
    const payload = h.responses[0].payload as Array<{ slideId: string; html: string }>;
    expect(payload).toHaveLength(1);
    expect(payload[0].slideId).toBe('slide-1');
    expect(payload[0].html).toContain('data-element-id="b"');
    expect(payload[0].html).toContain('data-agent-selected="true"');
    expect(payload[0].html).toContain('style="');
  });
});
