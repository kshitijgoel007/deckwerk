// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { measureTextOverflows } from '../src/shared/htmlMeasure.js';
import { fitAutoTextElement } from '../src/shared/autoFit.js';
import { authoredScene } from '../src/shared/agent.js';
import { emptyDeck } from '../src/shared/deck.js';

/**
 * The overflow report `apply --html` returns: text whose content spills past
 * its box in the *built* page, measured after auto-fit has settled.
 */
describe('built-page text overflow', () => {
  beforeEach(() => document.body.replaceChildren());

  /** The player's own text markup, with layout metrics jsdom cannot compute. */
  function textElement(options: {
    slideId: string;
    elementId: string;
    box: { w: number; h: number };
    content: { w: number; h: number };
    autofit?: boolean;
    fontSize?: number;
  }): HTMLElement {
    const slide = document.createElement('section');
    slide.className = 'slide';
    slide.dataset.slideId = options.slideId;
    const node = document.createElement('div');
    node.className = 'element element-text';
    node.dataset.elementId = options.elementId;
    if (options.autofit) node.dataset.autofit = 'true';
    node.style.fontSize = `${options.fontSize ?? 20}px`;
    const body = document.createElement('div');
    body.className = 'text-body';
    const content = document.createElement('div');
    content.className = 'text-content';
    content.textContent = 'Words';
    body.appendChild(content);
    node.appendChild(body);
    slide.appendChild(node);
    document.body.appendChild(slide);
    Object.defineProperties(body, {
      clientWidth: { configurable: true, value: options.box.w },
      clientHeight: { configurable: true, value: options.box.h },
    });
    Object.defineProperties(content, {
      scrollWidth: { configurable: true, value: options.content.w },
      scrollHeight: { configurable: true, value: options.content.h },
    });
    return node;
  }

  it('reports only the elements whose content exceeds their box', () => {
    textElement({
      slideId: 's1', elementId: 'fits',
      box: { w: 200, h: 100 }, content: { w: 200, h: 100 },
    });
    textElement({
      slideId: 's1', elementId: 'spills',
      box: { w: 200, h: 100 }, content: { w: 200, h: 130 },
    });

    expect(measureTextOverflows(document)).toEqual([{
      slideId: 's1',
      elementId: 'spills',
      overflowX: false,
      overflowY: true,
      beyond: { x: 0, y: 30 },
      fittedFontSize: null,
    }]);
  });

  it('re-runs auto-fit before judging an opted-in element', () => {
    const node = textElement({
      slideId: 's1', elementId: 'auto',
      box: { w: 200, h: 100 }, content: { w: 0, h: 0 }, autofit: true, fontSize: 40,
    });
    const content = node.querySelector<HTMLElement>('.text-content')!;
    // Content that shrinks with its font, exactly what auto-fit relies on.
    Object.defineProperties(content, {
      scrollWidth: {
        configurable: true,
        get: () => Number.parseFloat(content.style.fontSize || '40') * 10,
      },
      scrollHeight: {
        configurable: true,
        get: () => Number.parseFloat(content.style.fontSize || '40') * 2,
      },
    });
    (window as unknown as { fitAutoTextElement: typeof fitAutoTextElement })
      .fitAutoTextElement = fitAutoTextElement;

    // 40px would spill (400x80 in a 200x100 box); the fit settles near 20px
    // and the element drops out of the report.
    expect(measureTextOverflows(document)).toEqual([]);
    expect(content.dataset.fittedFontSize).toBeDefined();
  });

  it('never claims an unmeasured scene fits: offline overflow is null', () => {
    const deck = emptyDeck('Offline');
    deck.slides[0].elements.push({
      id: 'text', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, html: 'Text', align: 'left', valign: 'top',
    });
    const scene = authoredScene(deck, deck.slides[0], 0);
    expect(scene.elements[0].text).toMatchObject({ overflowX: null, overflowY: null });
  });
});
