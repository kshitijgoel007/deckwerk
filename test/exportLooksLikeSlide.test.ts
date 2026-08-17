import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deck } from '../src/shared/deck.js';
import { compareExportToPlayer, type ExportComparison } from '../src/cli/compareExport.js';
import { loadDeck } from '../src/main/deckStore.js';
import { writeHtmlScope } from '../src/main/htmlAuthoring.js';

/**
 * The exported file must *look* like the slide.
 *
 * Comparing deck JSON to deck JSON — which is what every other check here does
 * — cannot answer this. The exporter writes `left/top/width/height` and the
 * compiler reads the same numbers back, so a shape can export as an empty div,
 * a cropped photograph as a squashed one, and centred text as top-aligned, and
 * the round trip still reports "identical". Every one of those shipped.
 *
 * So this paints each slide twice: once with the Player from an exported
 * bundle — the definition of correct, being what the projector runs — and once
 * by opening the authoring file the way a browser does. Then it counts the
 * pixels that disagree.
 *
 * Needs the importer venv, the .key, Electron, and a built player bundle
 * (`npm run build:export`); skips politely without them.
 */

const PYTHON = join(process.cwd(), '.venv-import/bin/python');
const KEY = join(process.cwd(), 'example_presentations', '2606_bitter_lesson.key');
const PLAYER_BUNDLE = join(process.cwd(), 'out', 'export', 'player.js');

const electronPresent = (): boolean => {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown as string;
    return typeof path === 'string' && existsSync(path);
  } catch {
    return false;
  }
};

const runnable = existsSync(PYTHON) && existsSync(KEY)
  && existsSync(PLAYER_BUNDLE) && electronPresent();

/**
 * A slide is "the same" below this share of differing pixels. It is not zero
 * because nothing forces two paints of the same text to land on identical
 * subpixels — but it is small enough that a missing box (16%), a squashed
 * photograph (20%) or an unfitted title (5%) cannot hide under it.
 */
const TOLERANCE = 0.002;

describe.skipIf(!runnable)('every exported slide, against the projector', () => {
  let dir: string;
  let deck: Deck;
  let results: ExportComparison[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'looks-like-'));
    execFileSync(PYTHON, ['-c', [
      'import sys',
      'sys.path.insert(0, ".")',
      'from pathlib import Path',
      'from importers.keynote.import_keynote import import_key',
      `import_key(Path(${JSON.stringify(KEY)}), Path(${JSON.stringify(dir)}), True)`,
    ].join('\n')], { cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 });
    deck = await loadDeck(dir);

    const pages = [];
    for (const [index, slide] of deck.slides.entries()) {
      pages.push({
        id: slide.id,
        number: index + 1,
        page: (await writeHtmlScope(dir, deck, [slide.id])).path,
        // Paint order, so both renderings pin the same video to the same frame.
        videoStarts: [...slide.elements].sort((a, b) => a.z - b.z)
          .filter((element) => element.type === 'video')
          .map((element) => (element as Extract<typeof element, { type: 'video' }>).start),
      });
    }

    results = await compareExportToPlayer({
      deckDir: dir,
      deck,
      pages,
      // Kept for eyes, not for the assertion: a percentage never explains
      // *what* moved, and the three images do it in a second.
      outDir: join(dir, 'diff'),
      reportAbove: TOLERANCE,
    });
  }, 1_800_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('compared the whole talk, not a handful of easy slides', () => {
    expect(results.length).toBe(deck.slides.length);
    expect(results.length).toBeGreaterThan(50);
    // Guards the guard: two blank pages would agree perfectly.
    expect(deck.slides.flatMap((slide) => slide.elements).length).toBeGreaterThan(800);
    expect(results.every((result) => result.total > 1_000_000)).toBe(true);
  });

  it('looks like the slide, on every slide', () => {
    const wrong = results
      .filter((result) => result.fraction > TOLERANCE)
      .map((result) => `${result.id}: ${(result.fraction * 100).toFixed(2)}% of pixels differ`);
    expect(wrong).toEqual([]);
  });
});

describe.skipIf(runnable)('every exported slide, against the projector (skipped)', () => {
  it('needs the importer venv, the .key, Electron and a built player', () => {
    expect(runnable).toBe(false);
  });
});
