// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { wireCanvasInspector } from '../src/renderer/editor/shellWiring.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { installCanvasDomShims } from './support/canvasHarness.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';

/**
 * Stateful font-size fuzzing over a box whose runs are sized both ways.
 *
 * Two properties are asserted after every single operation, because both were
 * broken in ways that only a real deck exposed:
 *
 *  - The size field reports the *selection*, not the box. Letting the box's
 *    authored ceiling win meant each step was computed from a number the
 *    selected characters never had, so the control walked 88 → 87 → 88 → 87
 *    and the run underneath oscillated instead of shrinking.
 *  - Characters outside the selection never change size. A run written with a
 *    proportional size — how the editor writes every superscript and subscript
 *    — is a ratio to its surroundings, not a measurement to be overwritten. A
 *    selection dragged across a word and the raised marker beside it used to
 *    flatten the marker to the word's size, which in an auto-fitting box was
 *    absorbed by shrinking every other line on the slide.
 *
 * jsdom does not resolve relative CSS lengths, so effective sizes are modelled
 * from the authored declarations here rather than read back through
 * `getComputedStyle`. Selections always start inside an absolutely sized run,
 * which is what the size field is able to report in this environment; the
 * mixed and all-proportional selections themselves are covered by name in
 * `test/textFormattingControls.test.ts`.
 */

const BOX_SIZE = 88;
/** Alternating absolute and proportional runs, so a selection of any width
 * spanning past its anchor is likely to cross the boundary between them. */
const RUNS: ReadonlyArray<readonly [string, string]> = [
  ['Alpha bravo ', 'font-size: 87px; font-weight: 700;'],
  ['charlie', 'font-size: 0.7em; vertical-align: super;'],
  [' delta echo ', 'font-size: 60px;'],
  ['foxtrot', 'font-size: 0.84em;'],
  [' golf hotel ', 'font-size: 42px;'],
  ['india', 'font-size: 0.5em;'],
  [' juliet', 'font-size: 30px;'],
];
const TEXT = RUNS.map(([text]) => text).join('');
const HTML = `<p style="margin:0;">${
  RUNS.map(([text, style]) => `<span style="${style}">${text}</span>`).join('')
}</p>`;

function setup(): {
  store: EditorStore;
  content: HTMLElement;
  inspectorHost: HTMLElement;
} {
  installCanvasDomShims();
  const deck = emptyDeck('Font size fuzz');
  deck.slides[0].elements = [{
    id: 'fuzz-text', type: 'text', x: 100, y: 100, w: 1200, h: 300,
    rot: 0, z: 1, opacity: 1, class: ['role-title'],
    style: { 'font-size': `${BOX_SIZE}px` }, autoFit: true,
    html: HTML, align: 'left', valign: 'middle',
  } as SlideElement];
  const canvasHost = document.createElement('div');
  const inspectorHost = document.createElement('aside');
  document.body.replaceChildren(canvasHost, inspectorHost);
  const store = new EditorStore(deck, '/tmp/font-size-fuzz');
  const canvas = new EditorCanvas(canvasHost, store);
  const inspector = new Inspector(inspectorHost, store);
  wireCanvasInspector(canvas, inspector);
  store.select(['fuzz-text']);
  canvas.beginTextEdit('fuzz-text');
  const content = canvasHost.querySelector<HTMLElement>(
    '[data-element-id="fuzz-text"] .text-content',
  )!;
  return { store, content, inspectorHost };
}

/**
 * The text node and offset a drag would land on. At a run boundary a browser
 * anchors the start in the run the author is dragging into and the end in the
 * run they are dragging out of, so the same convention is used here.
 */
function locate(
  root: HTMLElement, offset: number, edge: 'start' | 'end',
): { node: Text; offset: number } {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if ((current as Text).data) nodes.push(current as Text);
  }
  let remaining = offset;
  for (const [index, node] of nodes.entries()) {
    const last = index === nodes.length - 1;
    const stops = remaining < node.data.length
      || (remaining === node.data.length && (last || edge === 'end'));
    if (stops) return { node, offset: remaining };
    remaining -= node.data.length;
  }
  throw new Error(`text offset ${offset} is out of range`);
}

function selectOffsets(root: HTMLElement, start: number, end: number): void {
  const from = locate(root, start, 'start');
  const to = locate(root, end, 'end');
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

/** The size a run resolves to, and whether it got there proportionally. */
function resolvedSize(text: Text, root: HTMLElement): { px: number; proportional: boolean } {
  const declared: string[] = [];
  for (
    let node = text.parentElement;
    node && node !== root && root.contains(node);
    node = node.parentElement
  ) {
    if (node.style.fontSize) declared.push(node.style.fontSize);
  }
  let px = BOX_SIZE;
  let proportional = false;
  for (const value of declared.reverse()) {
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number)) throw new Error(`unmodelled font size "${value}"`);
    const unit = value.trim().replace(/^[\d.]+/, '');
    if (unit === 'px') {
      px = number;
      proportional = false;
    } else if (unit === 'em' || unit === '%') {
      px = (unit === '%' ? number / 100 : number) * px;
      proportional = true;
    } else throw new Error(`unmodelled font size "${value}"`);
  }
  return { px, proportional };
}

/** One entry per visible character, so a shifted boundary is obvious. */
function sizeMap(root: HTMLElement): Array<{ px: number; proportional: boolean }> {
  const result: Array<{ px: number; proportional: boolean }> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    const resolved = resolvedSize(text, root);
    for (let index = 0; index < text.data.length; index += 1) result.push(resolved);
  }
  return result;
}

const sizeField = (host: HTMLElement): HTMLElement =>
  [...host.querySelectorAll<HTMLElement>('.field')]
    .find((node) => node.querySelector('span')?.textContent === 'Font size')!;
const sizeInput = (host: HTMLElement): HTMLInputElement =>
  sizeField(host).querySelector<HTMLInputElement>('input')!;

/** Click a real stepper button, pointerdown included: it is the preventDefault
 * on that event that keeps the canvas selection alive across the click. */
function step(host: HTMLElement, direction: 'up' | 'down'): void {
  const button = sizeField(host).querySelector<HTMLButtonElement>(
    `.number-step-${direction}`,
  )!;
  expect(button.dispatchEvent(new PointerEvent(
    'pointerdown', { bubbles: true, cancelable: true },
  ))).toBe(false);
  button.click();
}

function typeSize(host: HTMLElement, value: number): void {
  const input = sizeInput(host);
  input.value = String(value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** What the canvas is allowed to store for a requested size. */
const normalize = (value: number): number =>
  Math.round(Math.max(6, Math.min(400, value)) * 10) / 10;

/** Offsets whose run is sized absolutely — the anchors the field can report. */
const ABSOLUTE_STARTS = (() => {
  const starts: number[] = [];
  let at = 0;
  for (const [text, style] of RUNS) {
    if (style.includes('px')) {
      for (let index = 0; index < text.length; index += 1) starts.push(at + index);
    }
    at += text.length;
  }
  return starts;
})();

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

describe('stateful font size fuzzing', () => {
  beforeEach(() => document.body.replaceChildren());

  it('walks a run down and back up one step at a time without reverting', () => {
    const { content, inspectorHost } = setup();
    selectOffsets(content, 0, 5);
    expect(sizeInput(inspectorHost).value).toBe('87');

    for (const expected of [86, 85, 84, 83]) {
      step(inspectorHost, 'down');
      expect(Number(sizeInput(inspectorHost).value)).toBe(expected);
      expect(sizeMap(content)[0].px).toBe(expected);
    }
    for (const expected of [84, 85, 86, 87]) {
      step(inspectorHost, 'up');
      expect(Number(sizeInput(inspectorHost).value)).toBe(expected);
      expect(sizeMap(content)[0].px).toBe(expected);
    }
  });

  // The fixed seeds are the regression corpus; FUZZ_SEED walks extras.
  for (const seed of [...new Set([1607, 5501, 13337, 24029, 31573, ...extraFuzzSeeds()])]) {
    it(`keeps every unselected character's size for seed ${seed}`, () => {
      const { content, inspectorHost } = setup();
      const random = mulberry32(seed);

      for (let stepIndex = 0; stepIndex < 60; stepIndex += 1) {
        const start = ABSOLUTE_STARTS[Math.floor(random() * ABSOLUTE_STARTS.length)];
        const end = Math.min(TEXT.length, start + 1 + Math.floor(random() * 18));
        selectOffsets(content, start, end);

        const before = sizeMap(content);
        const shown = Number(sizeInput(inspectorHost).value);
        const where = `seed ${seed}, step ${stepIndex + 1} (${start}-${end})`;
        // The field is the only input the stepper has: if it reports the box
        // instead of the selection, every assertion below is measured against
        // a size these characters never had.
        expect(shown, `${where}: field`).toBe(before[start].px);

        const roll = random();
        let requested: number;
        if (roll < 0.4) {
          requested = normalize(shown - 1);
          step(inspectorHost, 'down');
        } else if (roll < 0.8) {
          requested = normalize(shown + 1);
          step(inspectorHost, 'up');
        } else {
          requested = normalize(8 + Math.round(random() * 1120) / 10);
          typeSize(inspectorHost, requested);
        }

        expect(content.textContent, `${where}: visible text`).toBe(TEXT);
        expect(window.getSelection()!.toString(), `${where}: selection`)
          .toBe(TEXT.slice(start, end));

        const after = sizeMap(content);
        expect(after.length, `${where}: character count`).toBe(before.length);
        for (const [index, resolved] of after.entries()) {
          const inSelection = index >= start && index < end;
          const expected = inSelection && !before[index].proportional
            ? requested
            : before[index].px;
          expect(resolved.px, `${where}: size at character ${index}`)
            .toBeCloseTo(expected, 5);
          expect(resolved.proportional, `${where}: unit at character ${index}`)
            .toBe(before[index].proportional && !(inSelection && before.every(
              (entry, at) => !(at >= start && at < end) || entry.proportional,
            )));
        }
        // The applied size must be what the field now reads back, or the next
        // step is computed from a stale number and the control oscillates.
        expect(Number(sizeInput(inspectorHost).value), `${where}: field after`)
          .toBeCloseTo(requested, 5);
      }

      // Old runs are re-styled in place, not recursively rewrapped.
      expect(content.querySelectorAll('span').length).toBeLessThan(TEXT.length);
    });
  }
});
