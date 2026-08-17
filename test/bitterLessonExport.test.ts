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
 * Every slide of a real talk, exported one at a time, and demanded back intact.
 *
 * The reference deck in `htmlRoundTrip` is a tidy 22 slides. This is 58 slides
 * of a talk that was actually given: title slide with a full-bleed photographic
 * background, cropped video, rotated rules, curved connectors, KaTeX, build
 * steps, and whatever the Keynote importer could not place. It is the deck the
 * bugs turn up in.
 *
 * Exported *per slide*, because that is what a person does — select a slide,
 * press the button — and because a bug that only shows up on slide 1 of 58 is
 * invisible in a whole-deck export where slide 1 is 2% of the page. The first
 * thing this found was exactly that: the title slide's background image was
 * dropped, since the exporter only ever wrote `background.color`.
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

describe.skipIf(!runnable)('every Bitter Lesson slide, exported on its own', () => {
  let dir: string;
  let deck: Deck;
  let rebuilt: Slide[];

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

    // One file per slide, through the same call the toolbar button makes.
    const pages: string[] = [];
    for (const slide of deck.slides) {
      pages.push((await writeHtmlScope(dir, deck, [slide.id])).path);
    }

    const measured = await measureSavedPages(pages, deck.canvas) as MeasuredSlide[][];
    // Each file holds one slide, and each is compiled against the deck it came
    // from, exactly as saving that one file would.
    rebuilt = measured.map((page) => slidesFromMeasured(deck, page)[0]);
  }, 900_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('is the real talk, not a fixture that happens to be easy', () => {
    // Guards the guard: an empty or truncated import would make everything
    // below vacuously true.
    expect(deck.slides.length).toBeGreaterThan(50);
    expect(rebuilt.length).toBe(deck.slides.length);
    expect(deck.slides.filter((slide) => slide.background.image).length).toBeGreaterThan(0);
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

  it('resolves the title slide\'s background picture to a file that is there', async () => {
    // The deck value round-tripping is not the same as the browser finding the
    // picture: a CSS `url()` is resolved against the page's base, which is one
    // folder up from `edit/`, and getting that wrong shows up as a slide with
    // no background rather than as an error.
    const index = deck.slides.findIndex((slide) => slide.background.image);
    const page = join(dir, 'edit', `${deck.slides[index].id}.html`);
    const [resolved] = await measureSavedPages([page], deck.canvas, `(() => {
      const slide = document.querySelector('section.slide');
      const url = getComputedStyle(slide).backgroundImage.match(/url\\(["']?([^"')]+)["']?\\)/);
      return url ? url[1] : null;
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
