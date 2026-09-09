import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeckHistory } from '../src/main/deckHistoryStore.js';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck, type Slide, type TextEl } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  stopBrowser,
} from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * Opt-in production-Electron soak for the large-deck interaction regression.
 *
 * The original report came from the private 2608_IARPA deck: 217 slides, 19
 * text boxes on slide two, and 108 restorable deck snapshots. None of that
 * deck is checked in. This fixture preserves those scale axes with generated
 * prose and ordinary native text elements, then drives the shipped desktop UI
 * through CDP's real mouse input path.
 *
 * Coverage is deliberately stateful. It repeatedly selects every text box,
 * moves a different box next, crosses the 800 ms autosave and 1,200 ms history
 * debounce boundaries, and selects slides in sequential, reverse, strided and
 * deterministic-random orders. A renderer heartbeat catches long main-thread
 * stalls even when the final state eventually becomes correct.
 */
const RUN_EXHAUSTIVE = process.env.RUN_EXHAUSTIVE_TEXT_BOX_FUZZ === '1';
const TEST_TIMEOUT = 30 * 60_000;
const SLIDE_COUNT = 217;
const HISTORY_COUNT = 108;
const TEXT_BOX_COUNT = 19;
const RESPONSE_BUDGET_MS = 2_000;
const HEARTBEAT_BUDGET_MS = 1_500;
const GESTURE_TIMEOUT_MS = 8_000;
const SECOND_SLIDE_ID = 'scale-slide-2';
const textId = (index: number) => `scale-text-${index}`;

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
let responsivenessFailures: string[] = [];

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

// Page.captureScreenshot needs a compositor that produces frames for hidden
// windows; bare Xvfb has none and the call blocks forever (see the same gate
// in desktopCollaborationHandoff). The nightly workflow sets the env.
const noWindowManager = process.env.CI_NO_WINDOW_MANAGER === '1';

describe.skipIf(!RUN_EXHAUSTIVE || !electronBinary || noWindowManager)('exhaustive large-deck text-box interactions', () => {
  it('keeps selection, consecutive drags, history flushes, and rail navigation responsive', async () => {
    responsivenessFailures = [];
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-text-box-fuzz-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await createScaleFixture(deckDir);
    await materializeDesktopApp(appDir, 'deckwerk-text-box-interaction-fuzz');

    const app = await launchDesktopApp(appDir, [deckDir], { profileDir });
    appProcess = app.process;
    const debugPort = app.debugPort;
    const appLog = app.log;
    const target = await findTarget(
      debugPort,
      isEditorTarget,
      appLog,
      30_000,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`window.api.getDeck().then(
      (session) => session?.dir === ${JSON.stringify(deckDir)}
        && document.querySelectorAll('#rail .rail-item').length >= ${SLIDE_COUNT}
        && Boolean(document.querySelector('#canvas [data-element-id="opening-text"]'))
    )`), 'desktop editor did not finish loading the large fixture', Boolean, 60_000);
    await editor.call('Page.bringToFront');
    await editor.evaluate(`(() => {
      window.focus();
      const sample = { last: performance.now(), maxGap: 0, ticks: 0 };
      window.__textBoxFuzzHeartbeat = sample;
      setInterval(() => {
        const now = performance.now();
        sample.maxGap = Math.max(sample.maxGap, now - sample.last);
        sample.last = now;
        sample.ticks += 1;
      }, 16);
      return true;
    })()`);

    await measured(
      'select IARPA-shaped second slide',
      () => editor!.click('#rail .rail-item[data-index="1"]', 'second slide'),
    );
    await assertSlideActive(1);
    expect(await editor.evaluate<number>(
      `document.querySelectorAll('#canvas [data-element-id^="scale-text-"]').length`,
    )).toBe(TEXT_BOX_COUNT);
    await eventually(
      () => paintedVisibleRailIndices(),
      'visible slide thumbnails did not paint before interaction fuzzing',
      (indices) => indices.length >= 2,
      10_000,
    );

    // Every box is selected through hit-testing in three different orders.
    // The rail and canvas have both already rendered, so this isolates the
    // reported delayed selection feedback from initial deck loading.
    const selectionOrders = [
      [...Array(TEXT_BOX_COUNT).keys()],
      [...Array(TEXT_BOX_COUNT).keys()].reverse(),
      stridedOrder(TEXT_BOX_COUNT, 7),
    ];
    for (const [pass, order] of selectionOrders.entries()) {
      for (const index of order) {
        const selector = canvasText(index);
        await measured(`selection pass ${pass + 1}, text ${index}`, () =>
          editor!.click(selector, `text box ${index}`));
        await expectSelection(index, `selection pass ${pass + 1}`);
      }
    }

    // Exact reported regression first: move one text box, then immediately
    // select and move another. Multi-step pointer paths exercise every live
    // geometry update, rather than teleporting from pointerdown to pointerup.
    await measured('reported first drag', () =>
      dragBy(canvasText(0), 34, 18, 12, 'reported first drag'));
    await measured('reported second drag of another box', () =>
      dragBy(canvasText(1), -26, 31, 12, 'reported second drag'));
    await expectSelection(1, 'reported consecutive drag');

    // Deterministic fuzz alternates targets by construction. Delays straddle
    // both persistence timers so a gesture is sampled before, during and after
    // deck/history writes. The vectors cover every sign combination plus
    // horizontal and vertical movement.
    const random = mulberry32(0x1a2b3c4d);
    const vectors = [
      [32, 0], [-32, 0], [0, 28], [0, -28],
      [24, 19], [-24, 19], [24, -19], [-24, -19],
    ] as const;
    const debounceDelays = [0, 200, 760, 860, 1_160, 1_260, 1_500];
    let previous = 1;
    for (let step = 0; step < 96; step += 1) {
      let index = Math.floor(random() * TEXT_BOX_COUNT);
      if (index === previous) index = (index + 1) % TEXT_BOX_COUNT;
      previous = index;
      const vector = vectors[step % vectors.length];
      const bounded = await boundedDragVector(index, vector[0], vector[1]);
      await measured(`drag fuzz step ${step + 1}, text ${index}`, () =>
        dragBy(
          canvasText(index),
          bounded.dx,
          bounded.dy,
          9,
          `drag fuzz step ${step + 1}, text ${index}`,
        ));
      await expectSelection(index, `drag fuzz step ${step + 1}`);
      const pause = debounceDelays[step % debounceDelays.length];
      if (pause > 0) await wait(pause);
      await assertHeartbeat(`drag fuzz step ${step + 1}`);
    }

    // Slide switching uses only real rail pointer input. A prime stride visits
    // every slide exactly once; the other passes stress nearby and far-away
    // transitions as well as repeated thumbnail virtualization churn.
    const railOrders = [
      [...Array(SLIDE_COUNT).keys()],
      [...Array(SLIDE_COUNT).keys()].reverse(),
      stridedOrder(SLIDE_COUNT, 43),
      shuffledOrder(SLIDE_COUNT, 0x51de5eed),
    ];
    for (const [pass, order] of railOrders.entries()) {
      for (const index of order) {
        await measured(`rail pass ${pass + 1}, slide ${index + 1}`, () =>
          editor!.click(`#rail .rail-item[data-index="${index}"]`, `slide ${index + 1}`));
        await assertSlideActive(index);
        if (index % 17 === 0) await assertHeartbeat(`rail pass ${pass + 1}, slide ${index + 1}`);
      }
    }

    await assertHeartbeat('completed interaction fuzz');
    if (responsivenessFailures.length > 0) {
      // Put visual rail failures first so a later drag hang cannot bury the
      // screenshot regression beneath dozens of latency samples.
      const ordered = [
        ...responsivenessFailures.filter((failure) => failure.includes('rail thumbnail')),
        ...responsivenessFailures.filter((failure) => !failure.includes('rail thumbnail')),
      ];
      const shown = ordered.slice(0, 30).join('\n');
      const omitted = responsivenessFailures.length - Math.min(30, responsivenessFailures.length);
      throw new Error([
        `${responsivenessFailures.length} interaction responsiveness violation(s):`,
        shown,
        ...(omitted > 0 ? [`...and ${omitted} more`] : []),
      ].join('\n'));
    }
  }, TEST_TIMEOUT);
});

describe.skipIf(RUN_EXHAUSTIVE)('exhaustive large-deck text-box interactions (opt-in)', () => {
  it('runs only through npm run test:interactions:exhaustive', () => {
    expect(RUN_EXHAUSTIVE).toBe(false);
  });
});

async function createScaleFixture(deckDir: string): Promise<void> {
  const deck = emptyDeck('Generated large-deck interaction fuzz');
  deck.themePreset = 'basic';
  deck.slides = Array.from({ length: SLIDE_COUNT }, (_, index) => makeSlide(index));
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #f7f7f5; color: #111317; }',
    '.role-body { font: 400 26px/1.25 Arial, sans-serif; }',
    '.role-title { font: 700 54px/1.08 Arial, sans-serif; }',
    '',
  ].join('\n'), 'utf8');

  // V2 stores the first revision once and keeps later revisions as operations.
  // A long log therefore retains the original history-count scale without
  // multiplying this large deck across the persistence boundary.
  await saveDeckHistory(deckDir, {
    version: 2,
    base: deck,
    entries: Array.from({ length: HISTORY_COUNT }, (_, index) => ({
      label: `Generated edit ${index + 1}`,
      at: index + 1,
      slideIndex: index % SLIDE_COUNT,
      operations: [],
    })),
  });
}

function makeSlide(index: number): Slide {
  if (index === 0) {
    return {
      id: 'scale-slide-1',
      name: 'Opening slide',
      background: { color: '#f7f7f5', image: null },
      notes: '',
      elements: [makeText('opening-text', 100, 100, 900, 180, 'Opening slide')],
      timeline: [],
    };
  }
  const count = index === 1 ? TEXT_BOX_COUNT : 6;
  const elements = Array.from({ length: count }, (_, elementIndex) => {
    const column = elementIndex % 4;
    const row = Math.floor(elementIndex / 4);
    return makeText(
      index === 1 ? textId(elementIndex) : `slide-${index + 1}-text-${elementIndex}`,
      70 + column * 455,
      45 + row * 200,
      360,
      125,
      index === 1
        ? `Generated profile item ${elementIndex + 1}`
        : `Generated slide ${index + 1}, item ${elementIndex + 1}`,
    );
  });
  return {
    id: index === 1 ? SECOND_SLIDE_ID : `scale-slide-${index + 1}`,
    name: index === 1 ? 'Generated IARPA-scale text slide' : `Generated slide ${index + 1}`,
    background: { color: index % 9 === 0 ? '#ffffff' : '#f7f7f5', image: null },
    notes: `Synthetic scale fixture slide ${index + 1}`,
    elements,
    timeline: [],
  };
}

function makeText(id: string, x: number, y: number, w: number, h: number, text: string): TextEl {
  return {
    id,
    type: 'text',
    x,
    y,
    w,
    h,
    rot: 0,
    z: 1,
    opacity: 1,
    class: ['role-body', 'kn-text'],
    // Imported decks carry a wider inline style surface than hand-authored
    // fixtures. Keep representative inherited properties without copying any
    // private deck content.
    style: {
      color: '#111317',
      'font-family': 'Arial, sans-serif',
      'font-size': '26px',
      'font-weight': '400',
      'font-style': 'normal',
      'font-variant': 'normal',
      'letter-spacing': 'normal',
      'line-height': '32.5px',
      'text-transform': 'none',
      'text-decoration': 'none solid rgb(17, 19, 23)',
      'text-shadow': 'none',
      'white-space': 'normal',
      'word-break': 'normal',
      'overflow-wrap': 'normal',
      'writing-mode': 'horizontal-tb',
    },
    html: `<p>${text}</p><p>Deterministic regression content.</p>`,
    align: 'left',
    valign: 'top',
  };
}

function canvasText(index: number): string {
  return `#canvas [data-element-id="${textId(index)}"]`;
}

/**
 * Keep the randomized targets in separate layout slots.
 *
 * Pointer deltas are viewport pixels while authored positions are slide
 * pixels, so derive the live canvas scale before clamping. Without this, the
 * cumulative soak eventually places boxes on top of one another and a click
 * at the covered target's centre correctly selects the box painted above it.
 */
async function boundedDragVector(index: number, dx: number, dy: number): Promise<{
  dx: number;
  dy: number;
}> {
  const position = await editor!.evaluate<{
    left: number;
    top: number;
    scale: number;
  }>(`(() => {
    const node = document.querySelector(${JSON.stringify(canvasText(index))});
    const rect = node.getBoundingClientRect();
    const width = Number.parseFloat(node.style.width);
    return {
      left: Number.parseFloat(node.style.left),
      top: Number.parseFloat(node.style.top),
      scale: width > 0 ? rect.width / width : 1,
    };
  })()`);
  const origin = {
    left: 70 + (index % 4) * 455,
    top: 45 + Math.floor(index / 4) * 200,
  };
  const boundedAxis = (
    current: number,
    base: number,
    viewportDelta: number,
    radius: number,
  ) => {
    if (viewportDelta === 0) return 0;
    const canvasDelta = viewportDelta / position.scale;
    let target = Math.max(base - radius, Math.min(base + radius, current + canvasDelta));
    if (Math.abs(target - current) < 0.5) {
      target = Math.max(base - radius, Math.min(base + radius, current - canvasDelta));
    }
    return (target - current) * position.scale;
  };
  return {
    dx: boundedAxis(position.left, origin.left, dx, 30),
    dy: boundedAxis(position.top, origin.top, dy, 25),
  };
}

async function measured(label: string, action: () => Promise<unknown>): Promise<void> {
  const started = performance.now();
  try {
    await deadline(action(), GESTURE_TIMEOUT_MS, label);
  } catch (error) {
    const prior = responsivenessFailures.slice(-20).join('\n');
    throw new Error([
      error instanceof Error ? error.message : String(error),
      ...(prior ? ['Violations observed before the hang:', prior] : []),
    ].join('\n'));
  }
  const elapsed = performance.now() - started;
  if (elapsed >= RESPONSE_BUDGET_MS) {
    responsivenessFailures.push(
      `${label}: UI feedback took ${Math.round(elapsed)} ms (budget ${RESPONSE_BUDGET_MS} ms)`,
    );
  }
  await assertHeartbeat(label);
}

async function expectSelection(index: number, label: string): Promise<void> {
  const selected = await deadline(editor!.evaluate<{ boxes: number; left: string; top: string }>(`(() => {
    const node = document.querySelector(${JSON.stringify(canvasText(index))});
    const box = document.querySelector('#canvas .sel-box');
    return {
      boxes: document.querySelectorAll('#canvas .sel-box').length,
      left: box?.style.left ?? '',
      top: box?.style.top ?? '',
      nodeLeft: node?.style.left ?? '',
      nodeTop: node?.style.top ?? ''
    };
  })()`), GESTURE_TIMEOUT_MS, `${label} selection state`);
  const node = await editor!.evaluate<{ left: string; top: string }>(`(() => {
    const node = document.querySelector(${JSON.stringify(canvasText(index))});
    return { left: node?.style.left ?? '', top: node?.style.top ?? '' };
  })()`);
  if (selected.boxes !== 1) {
    responsivenessFailures.push(
      `${label}: expected one selection frame, observed ${selected.boxes}`,
    );
  }
  if (selected.left !== node.left || selected.top !== node.top) {
    responsivenessFailures.push(
      `${label}: selection frame stayed at ${selected.left},${selected.top}; `
      + `target text ${index} was at ${node.left},${node.top}`,
    );
  }
}

async function assertSlideActive(index: number): Promise<void> {
  await deadline(eventually(async () => editor!.evaluate<boolean>(`(() => {
    const row = document.querySelector('#rail .rail-item[data-index="${index}"]');
    return row?.classList.contains('active') === true
      && row.getAttribute('aria-selected') === 'true';
  })()`), `slide ${index + 1} did not become active`, Boolean, GESTURE_TIMEOUT_MS),
  GESTURE_TIMEOUT_MS, `slide ${index + 1} active state`);
}

async function assertHeartbeat(label: string): Promise<void> {
  // Fast clicks can finish before the first 16 ms sample, and a freshly
  // rendered large slide may delay that initial interval slightly. Poll until
  // one tick exists, resetting the sample only once it can be evaluated.
  const heartbeat = await deadline(eventually(
    () => editor!.evaluate<{ maxGap: number; ticks: number }>(`(() => {
      const sample = window.__textBoxFuzzHeartbeat;
      const value = { maxGap: sample.maxGap, ticks: sample.ticks };
      if (sample.ticks > 0) {
        sample.maxGap = 0;
        sample.ticks = 0;
        sample.last = performance.now();
      }
      return value;
    })()`),
    `${label} renderer heartbeat stopped`,
    (sample) => sample.ticks > 0,
    HEARTBEAT_BUDGET_MS,
  ), GESTURE_TIMEOUT_MS, `${label} heartbeat`);
  if (heartbeat.maxGap >= HEARTBEAT_BUDGET_MS) {
    responsivenessFailures.push(
      `${label}: renderer stalled for ${Math.round(heartbeat.maxGap)} ms `
      + `(budget ${HEARTBEAT_BUDGET_MS} ms)`,
    );
  }
}

async function dragBy(
  selector: string,
  dx: number,
  dy: number,
  steps: number,
  label: string,
): Promise<void> {
  const paintedBefore = await paintedVisibleRailIndices();
  if (paintedBefore.length === 0) {
    responsivenessFailures.push(`${label}: no visible rail thumbnail was painted before drag`);
  }
  // The active slide's thumbnail is expected to move with the canvas object.
  // A different visible thumbnail is immutable during this gesture; compare
  // its actual Chromium pixels so a still-present but visually blank DOM does
  // not evade the regression test. Full-page compositor screenshots are much
  // more expensive than the gesture itself, so sample them deterministically;
  // DOM-level blank checks still run at every pointer checkpoint below.
  const visualReferenceIndex = paintedBefore.find((index) => index !== 1);
  const visualReference = visualReferenceIndex === undefined || !sampleVisualDrag(label)
    ? null
    : await captureRailThumbnail(visualReferenceIndex);
  const point = await editor!.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { error: 'no element matches' };
    node.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { error: 'element has no size' };
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if ('error' in point) throw new Error(`cannot drag ${selector}: ${point.error}`);
  await editor!.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0,
  });
  await editor!.call('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y,
    button: 'left', buttons: 1, clickCount: 1,
  });
  for (let step = 1; step <= steps; step += 1) {
    await editor!.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x + dx * step / steps,
      y: point.y + dy * step / steps,
      button: 'left',
      buttons: 1,
    });
    if (step === 1 || step === Math.ceil(steps / 2) || step === steps) {
      await recordBlankRailThumbnails(`${label}, pointer move ${step}/${steps}`, paintedBefore);
    }
    if (step === Math.ceil(steps / 2) && visualReference) {
      const during = await captureRailThumbnail(visualReference.index);
      if (!during || during.png !== visualReference.png) {
        responsivenessFailures.push(
          `${label}, pointer move ${step}/${steps}: untouched visible rail thumbnail `
          + `${visualReference.index + 1} changed or rendered blank`,
        );
      }
    }
  }
  await recordBlankRailThumbnails(`${label}, before pointer-up`, paintedBefore);
  await editor!.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x + dx, y: point.y + dy,
    button: 'left', buttons: 0, clickCount: 1,
  });
}

function sampleVisualDrag(label: string): boolean {
  const fuzzStep = /drag fuzz step (\d+)/.exec(label)?.[1];
  return fuzzStep === undefined || Number(fuzzStep) % 12 === 0;
}

async function paintedVisibleRailIndices(): Promise<number[]> {
  return editor!.evaluate<number[]>(`(() => {
    const rail = document.getElementById('rail');
    if (!rail) return [];
    const viewport = rail.getBoundingClientRect();
    return [...rail.querySelectorAll('.rail-item[data-index]')]
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      })
      .filter((row) => {
        const inner = row.querySelector('.rail-thumb-inner');
        const slide = inner?.querySelector('.slide');
        return Boolean(slide && slide.textContent?.trim());
      })
      .map((row) => Number(row.dataset.index))
      .filter(Number.isInteger);
  })()`);
}

async function recordBlankRailThumbnails(label: string, expected: number[]): Promise<void> {
  const painted = new Set(await paintedVisibleRailIndices());
  const blank = expected.filter((index) => !painted.has(index));
  if (blank.length > 0) {
    responsivenessFailures.push(
      `${label}: ${blank.length}/${expected.length} previously painted visible rail thumbnail(s) `
      + `went blank (slides ${blank.map((index) => index + 1).join(', ')})`,
    );
  }
}

async function captureRailThumbnail(index: number): Promise<{ index: number; png: string } | null> {
  const clip = await editor!.evaluate<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(`(() => {
    const thumb = document.querySelector(
      '#rail .rail-item[data-index="${index}"] .rail-thumb'
    );
    if (!thumb) return null;
    const rect = thumb.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.min(innerWidth, rect.right) - Math.max(0, rect.left),
      height: Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)
    };
  })()`);
  if (!clip || clip.width <= 0 || clip.height <= 0) return null;
  const screenshot = await editor!.call('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { ...clip, scale: 1 },
  }) as { data?: string };
  return typeof screenshot.data === 'string' ? { index, png: screenshot.data } : null;
}

function stridedOrder(length: number, stride: number): number[] {
  const order: number[] = [];
  let value = 0;
  do {
    order.push(value);
    value = (value + stride) % length;
  } while (value !== 0);
  return order;
}

function shuffledOrder(length: number, seed: number): number[] {
  const order = [...Array(length).keys()];
  const random = mulberry32(seed);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function deadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
