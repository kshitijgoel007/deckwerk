import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deck, Slide } from '../src/shared/deck.js';
import { slidesFromMeasured, type MeasuredSlide } from '../src/shared/htmlSlides.js';
import { measureSavedPages } from '../src/cli/compileHtml.js';
import { loadDeck } from '../src/main/deckStore.js';
import { writeHtmlScope } from '../src/main/htmlAuthoring.js';

/**
 * Every slide of a real talk, exported together and demanded back intact. The
 * first slide and the full-bleed-background sentinel are also exported alone
 * so single-slide authoring retains explicit boundary coverage.
 *
 * The reference deck in `htmlRoundTrip` is a tidy 22 slides. This is 58 slides
 * of a talk that was actually given: title slide with a full-bleed photographic
 * background, cropped video, rotated rules, curved connectors, KaTeX, build
 * steps, and whatever the Keynote importer could not place. It is the deck the
 * bugs turn up in.
 *
 * Measuring the common whole-deck page once avoids 58 browser navigations.
 * The sentinel scopes preserve the regression that first found the title
 * slide's dropped background image.
 *
 * Needs the importer venv, the .key, and Electron; skips politely without them.
 */

const PYTHON = join(process.cwd(), '.venv-import/bin/python');
const KEY = join(process.cwd(), 'example_presentations', '2606_bitter_lesson.key');

const electronPresent = (): boolean => {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown as string;
    return typeof path === 'string' && existsSync(path);
  } catch {
    return false;
  }
};

const runnable = existsSync(PYTHON) && existsSync(KEY) && electronPresent();

function fullBleedBackground(slide: Slide, deck: Deck) {
  return slide.elements.find((element) => element.type === 'image'
    && element.x === 0
    && element.y === 0
    && element.w === deck.canvas.w
    && element.h === deck.canvas.h
    && element.z === 0);
}

describe.skipIf(!runnable)('every Bitter Lesson slide, exported and rebuilt', () => {
  let dir: string;
  let deck: Deck;
  let rebuilt: Slide[];
  let singleRebuilt: Map<string, Slide>;
  let singlePages: Map<string, string>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bitter-lesson-'));
    // A written import, not the in-memory one the importer tests use: the
    // assets have to be on disk or the browser cannot load them, and whether
    // the browser can load them is half of what is under test.
    execFileSync(PYTHON, ['-c', [
      'import sys',
      'sys.path.insert(0, ".")',
      'from pathlib import Path',
      'from importers.keynote.import_keynote import import_key',
      `import_key(Path(${JSON.stringify(KEY)}), Path(${JSON.stringify(dir)}), True)`,
    ].join('\n')], { cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 });
    deck = await loadDeck(dir);

    // The browser can measure all sections from one page in one navigation.
    // Keep single-slide scopes for the two boundary cases that originally
    // motivated this regression: slide one and a full-bleed background.
    const whole = await writeHtmlScope(dir, deck, deck.slides.map((slide) => slide.id));
    const fullBleed = deck.slides.find((slide) => fullBleedBackground(slide, deck));
    const sentinelIds = [...new Set([
      deck.slides[0]?.id,
      fullBleed?.id,
    ].filter((id): id is string => Boolean(id)))];
    singlePages = new Map();
    for (const id of sentinelIds) {
      singlePages.set(id, (await writeHtmlScope(dir, deck, [id])).path);
    }

    const measured = await measureSavedPages(
      [whole.path, ...singlePages.values()],
      deck.canvas,
    ) as MeasuredSlide[][];
    rebuilt = slidesFromMeasured(deck, measured[0]);
    singleRebuilt = new Map(sentinelIds.map((id, index) => [
      id,
      slidesFromMeasured(deck, measured[index + 1])[0],
    ]));
  }, 900_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('is the real talk, not a fixture that happens to be easy', () => {
    // Guards the guard: an empty or truncated import would make everything
    // below vacuously true.
    expect(deck.slides.length).toBeGreaterThan(50);
    expect(rebuilt.length).toBe(deck.slides.length);
    expect(deck.slides.filter((slide) => fullBleedBackground(slide, deck)).length).toBeGreaterThan(0);
    expect(deck.slides.flatMap((slide) => slide.elements).length).toBeGreaterThan(150);
  });

  it('keeps every slide background, colour and picture alike', () => {
    const problems = deck.slides.flatMap((slide, index) =>
      JSON.stringify(slide.background) === JSON.stringify(rebuilt[index].background)
        ? []
        : [`${slide.id}: ${JSON.stringify(slide.background)}`
          + ` -> ${JSON.stringify(rebuilt[index].background)}`]);
    expect(problems).toEqual([]);
  });

  it('returns every slide exactly as it went out', () => {
    expect(differences(deck, rebuilt)).toEqual([]);
  });

  it('returns boundary slides exactly from a one-slide authoring scope', () => {
    const problems = [...singleRebuilt].flatMap(([id, slide]) => {
      const original = deck.slides.find((candidate) => candidate.id === id)!;
      return differences({ ...deck, slides: [original] }, [slide]);
    });
    expect(problems).toEqual([]);
  });

  it('resolves the title slide\'s full-bleed background picture to a file that is there', async () => {
    // Imported background pictures are ordinary full-bleed image elements so
    // they remain selectable and animatable. Round-tripping the deck value is
    // not enough: the browser must also resolve the image relative to edit/.
    const index = deck.slides.findIndex((slide) => fullBleedBackground(slide, deck));
    const background = fullBleedBackground(deck.slides[index], deck)!;
    const page = singlePages.get(deck.slides[index].id)!;
    const [resolved] = await measureSavedPages([page], deck.canvas, `(() => {
      return document.querySelector('[data-element-id="${background.id}"]').currentSrc;
    })()`) as (string | null)[];

    expect(resolved).toMatch(/^file:\/\//);
    expect(existsSync(fileURLToPath(resolved!)), `${resolved} is not on disk`).toBe(true);
  }, 120_000);

  it('preserves paint order even though z is renumbered', () => {
    deck.slides.forEach((original, index) => {
      const order = (slide: Slide) => [...slide.elements]
        .sort((a, b) => a.z - b.z)
        .map((element) => element.id);
      expect(order(rebuilt[index]), `slide ${original.id}`).toEqual(order(original));
    });
  });
});

/** Text as HTML means it: runs of whitespace are one space, edges are nothing. */
function collapse(html: string): string {
  return html.replace(/\s+/g, ' ').trim();
}

/** Everything about a slide, not just its geometry. Paint order is checked separately. */
function differences(before: Deck, after: Slide[]): string[] {
  const problems: string[] = [];
  before.slides.forEach((original, index) => {
    const rebuilt = after[index];
    if (!rebuilt) {
      problems.push(`${original.id}: did not come back`);
      return;
    }
    if (original.id !== rebuilt.id) problems.push(`slide ${index}: id ${original.id} -> ${rebuilt.id}`);
    for (const key of ['name', 'notes'] as const) {
      if (original[key] !== rebuilt[key]) {
        problems.push(`${original.id}.${key}: ${JSON.stringify(original[key])} -> ${JSON.stringify(rebuilt[key])}`);
      }
    }
    if (JSON.stringify(original.timeline) !== JSON.stringify(rebuilt.timeline)) {
      problems.push(`${original.id}: timeline changed`);
    }

    const originals = new Map(original.elements.map((element) => [element.id, element]));
    const rebuilts = new Map(rebuilt.elements.map((element) => [element.id, element]));
    for (const id of originals.keys()) {
      if (!rebuilts.has(id)) problems.push(`${original.id}: lost element ${id}`);
    }
    for (const id of rebuilts.keys()) {
      if (!originals.has(id)) problems.push(`${original.id}: invented element ${id}`);
    }

    for (const [id, element] of originals) {
      const other = rebuilts.get(id);
      if (!other) continue;
      for (const [key, value] of Object.entries(element)) {
        // Paint order is renumbered densely; that it is *preserved* is asserted
        // separately, and that is the property that matters.
        if (key === 'z') continue;
        const rebuiltValue = (other as Record<string, unknown>)[key];
        if (key === 'html') {
          // HTML collapses runs of whitespace and ignores them at the edges of
          // a block, so `"Diffusion "` and `"Diffusion"` are the same text —
          // there is no markup that could tell them apart, and the compiler
          // reads back what the browser rendered. Compare what a reader sees.
          if (collapse(String(value)) !== collapse(String(rebuiltValue))) {
            problems.push(`${id}.html: ${JSON.stringify(value)} -> ${JSON.stringify(rebuiltValue)}`);
          }
          continue;
        }
        if (typeof value === 'number' && typeof rebuiltValue === 'number') {
          if (Math.abs(value - rebuiltValue) > 1) {
            problems.push(`${id}.${key}: ${value} -> ${rebuiltValue}`);
          }
        } else if (JSON.stringify(value) !== JSON.stringify(rebuiltValue)) {
          problems.push(`${id}.${key}: ${JSON.stringify(value)} -> ${JSON.stringify(rebuiltValue)}`);
        }
      }
    }
  });
  return problems;
}

describe.skipIf(runnable)('every Bitter Lesson slide (skipped)', () => {
  it('needs the importer venv, the .key and Electron', () => {
    expect(runnable).toBe(false);
  });
});
