import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDeck } from '../src/shared/deck.js';
import { importKeynote } from '../src/main/keynoteImport.js';
import { loadDeck, loadTheme } from '../src/main/deckStore.js';
import { writeHtmlScope } from '../src/main/htmlAuthoring.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { suggestMagicMovePairs, unchangedMagicMovePairs } from '../src/shared/magicMove.js';

/**
 * Import regression tests.
 *
 * These run against real presentations rather than synthetic fixtures, because
 * the failure mode that matters is "a deck someone actually wrote does not come
 * across", and only real decks exercise the archive types that appear in the
 * wild. Point KEYNOTE_FIXTURES at a folder of .key files to run them.
 *
 * The suite skips itself when the importer venv or the fixture folder is
 * absent, so a fresh checkout still passes.
 */

const PYTHON = join(process.cwd(), '.venv-import/bin/python');
const SCRIPT = join(process.cwd(), 'importers/keynote/import_keynote.py');
const FIXTURES = process.env.KEYNOTE_FIXTURES;
const LOCAL_FIXTURES = join(process.cwd(), 'example_presentations');
const BUNDLED_IMPORTER = join(process.cwd(), 'build', 'importers',
  process.platform === 'win32' ? 'keynote-import.exe' : 'keynote-import');

const ready = existsSync(PYTHON) && existsSync(SCRIPT);

function report(keyPath: string): {
  slides: number;
  elements: number;
  unsupported: Record<string, number>;
  warnings: string[];
} {
  const stdout = execFileSync(PYTHON, [SCRIPT, keyPath, '--report'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout).report;
}

describe.skipIf(!ready)('keynote importer', () => {
  const fixtures = FIXTURES && existsSync(FIXTURES)
    ? FIXTURES
    : existsSync(LOCAL_FIXTURES) ? LOCAL_FIXTURES : null;

  it.skipIf(!fixtures)('imports every fixture deck without failing', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const decks = readdirSync(fixtures!)
      .filter((f) => f.endsWith('.key'))
      .map((f) => join(fixtures!, f));
    expect(decks.length).toBeGreaterThan(0);

    for (const deck of decks) {
      const r = report(deck);
      expect(r.slides, `${deck} produced no slides`).toBeGreaterThan(0);
      // The guarantee is not "everything converts" but "nothing explodes":
      // unknown objects are allowed, they just have to become placeholders.
      const skipped = Object.values(r.unsupported).reduce((a, b) => a + b, 0);
      expect(skipped / Math.max(1, r.elements)).toBeLessThan(0.25);
    }
  }, 600_000);

  it.skipIf(!existsSync(join(LOCAL_FIXTURES, 'team_slide.key')))(
    'imports a real deck through the app wrapper, reopens it, and prepares its first slide',
    async () => {
      const out = await mkdtemp(join(tmpdir(), 'kn-open-smoke-'));
      try {
        const imported = await importKeynote(join(LOCAL_FIXTURES, 'team_slide.key'), out);
        expect(imported.dir).toBe(out);
        expect(imported.deck.slides.length).toBeGreaterThan(0);

        // Reopen from disk instead of trusting the in-memory importer result.
        // This is the same boundary used by Open and by a fresh app launch.
        const opened = await loadDeck(out);
        expect(opened).toEqual(imported.deck);
        expect((await loadTheme(out, opened.theme)).length).toBeGreaterThan(0);

        const store = new EditorStore(opened, out);
        expect(store.slide?.id).toBe(opened.slides[0].id);
        const authored = await writeHtmlScope(out, opened, [opened.slides[0].id]);
        expect(existsSync(authored.path)).toBe(true);
        expect(authored.contents).toContain('section class="slide"');
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!existsSync(BUNDLED_IMPORTER) || !existsSync(join(LOCAL_FIXTURES, 'team_slide.key')))(
    'imports and reopens a real deck with the packaged sidecar',
    async () => {
      const out = await mkdtemp(join(tmpdir(), 'kn-packaged-open-'));
      try {
        const stdout = execFileSync(
          BUNDLED_IMPORTER,
          [join(LOCAL_FIXTURES, 'team_slide.key'), '--out', out],
          { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
        );
        const payload = JSON.parse(stdout) as { dir: string; deck: unknown };
        expect(payload.dir).toBe(out);
        expect(parseDeck(payload.deck).slides.length).toBeGreaterThan(0);
        const opened = await loadDeck(out);
        expect(opened.slides.length).toBeGreaterThan(0);
        expect((await loadTheme(out, opened.theme)).length).toBeGreaterThan(0);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // Full written imports copy and transcode gigabytes of assets. Keep this
  // opt-in for CI or focused local runs; report mode above still parses every
  // object in every local corpus deck.
  it.skipIf(!FIXTURES || !existsSync(FIXTURES))('produces schema-valid decks with sane geometry', async () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const first = readdirSync(fixtures!).find((f) => f.endsWith('.key'));
    if (!first) return;

    const out = await mkdtemp(join(tmpdir(), 'kn-import-'));
    try {
      const stdout = execFileSync(
        PYTHON,
        [SCRIPT, join(fixtures!, first), '--out', out],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      );
      const deck = parseDeck(JSON.parse(stdout).deck);

      expect(deck.slides.length).toBeGreaterThan(0);
      expect(deck.canvas.w).toBeGreaterThan(0);

      for (const slide of deck.slides) {
        for (const el of slide.elements) {
          expect(Number.isFinite(el.x)).toBe(true);
          expect(Number.isFinite(el.y)).toBe(true);
          expect(el.w).toBeGreaterThan(0);
          expect(el.h).toBeGreaterThan(0);
          // Every referenced asset must exist, or the slide renders a broken box.
          if (el.type === 'image' || el.type === 'video') {
            expect(existsSync(join(out, el.src)), `missing ${el.src}`).toBe(true);
          }
        }
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 600_000);

  it.skipIf(!fixtures)('preserves curved Keynote connectors as editable curves', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const candidates = readdirSync(fixtures!).filter((name) => name.endsWith('.key'));
    let curves = 0;
    for (const name of candidates.slice(0, 8)) {
      const stdout = execFileSync(PYTHON, ['-c', [
        'from pathlib import Path',
        'from importers.keynote.import_keynote import import_key',
        `d,_=import_key(Path(${JSON.stringify(join(fixtures!, name))}),Path('/dev/null'),False)`,
        "print(sum(1 for s in d['slides'] for e in s['elements'] if e.get('control')))",
      ].join(';')], { encoding: 'utf8', cwd: process.cwd() });
      curves += Number(stdout.trim()) || 0;
    }
    expect(curves).toBeGreaterThan(0);
  }, 600_000);

  const allHandsDeck = join(LOCAL_FIXTURES, '2608_all_HANDS.key');

  it.skipIf(!existsSync(allHandsDeck))(
    'imports the red outline on All Hands slide 5 as a native rectangle',
    () => {
      const stdout = execFileSync(PYTHON, ['-c', [
        'import json',
        'from pathlib import Path',
        'from importers.keynote.import_keynote import import_key',
        `d,_=import_key(Path(${JSON.stringify(allHandsDeck)}),Path('/dev/null'),False)`,
        'print(json.dumps(d))',
      ].join(';')], { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
      const deck = parseDeck(JSON.parse(stdout));
      const redOutline = deck.slides[4].elements.find((element) =>
        element.type === 'shape' && element.stroke === '#ee220c');

      expect(redOutline).toBeDefined();
      if (redOutline?.type !== 'shape') throw new Error('expected a shape');
      expect(redOutline.shape).toBe('rect');
      expect(redOutline.path).toBeNull();
      expect(redOutline.fill).toBeNull();
      expect(redOutline.strokeWidth).toBe(7);
    },
    60_000,
  );

  const bitterLessonDeck = join(LOCAL_FIXTURES, '2606_bitter_lesson.key');
  const icmlWorkshopDeck = join(LOCAL_FIXTURES, '2607_ICML_workshop.key');

  it.skipIf(!existsSync(icmlWorkshopDeck))(
    'falls back to embedded thumbnails when linked Keynote images are absent',
    () => {
      const imported = report(icmlWorkshopDeck);

      expect(imported.unsupported['ImageArchive (no data)']).toBeUndefined();
      expect(imported.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('Screenshot 2026-06-18 at 3.27.15'),
        expect.stringContaining('Screenshot 2026-06-25 at 12.12.40'),
        expect.stringContaining('Screenshot 2026-06-18 at 4.37.04'),
      ]));
    },
    60_000,
  );

  function importBitterLesson() {
    const stdout = execFileSync(PYTHON, ['-c', [
      'import json',
      'from pathlib import Path',
      'from importers.keynote.import_keynote import import_key',
      `d,_=import_key(Path(${JSON.stringify(bitterLessonDeck)}),Path('/dev/null'),False)`,
      'print(json.dumps(d))',
    ].join(';')], { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    return parseDeck(JSON.parse(stdout));
  }

  it.skipIf(!existsSync(bitterLessonDeck))(
    'recognizes the unchanged image across Bitter Lesson slides 18 and 19',
    () => {
      const deck = importBitterLesson();
      const previous = deck.slides[17].elements;
      const next = deck.slides[18].elements;
      const unchangedImages = unchangedMagicMovePairs(previous, next)
        .filter(([source, target]) => source.type === 'image' && target.type === 'image');
      expect(unchangedImages.map(([source, target]) => [
        source.type === 'image' ? source.src : '',
        target.type === 'image' ? target.src : '',
      ])).toContainEqual(['assets/method-12913.png', 'assets/method-12913.png']);
      // Auto-pair skips it: identical objects stay visible without a pair.
      expect(suggestMagicMovePairs(previous, next).some(([source, target]) =>
        source.type === 'image' && target.type === 'image' &&
        source.src === 'assets/method-12913.png' && target.src === source.src)).toBe(false);
    },
    60_000,
  );

  it.skipIf(!existsSync(bitterLessonDeck))(
    'can insert and lay out a new slide after the real Bitter Lesson slide',
    () => {
      const deck = importBitterLesson();
      const bitterIndex = deck.slides.findIndex((slide) =>
        slide.elements.some((element) =>
          element.type === 'text' &&
          element.html.toLowerCase().includes('the flavor of the bitter lesson')));
      expect(bitterIndex).toBeGreaterThanOrEqual(0);
      const originalBitterSlide = deck.slides[bitterIndex];
      const store = new EditorStore(deck, '/tmp/bitter-lesson');
      store.selectSlide(bitterIndex);
      store.commit((next) => next.slides.splice(bitterIndex + 1, 0, {
        id: 'new-after-bitter', name: '', background: { color: null, image: null },
        notes: '', elements: [], timeline: [],
      }));
      store.selectSlide(bitterIndex + 1);
      store.commit((next) => applySlideLayout(next.slides[bitterIndex + 1], 'standard'));

      expect(store.get().deck.slides[bitterIndex]).toBe(originalBitterSlide);
      expect(store.slide?.elements.map((element) => element.class[0])).toEqual([
        'role-title', 'role-body',
      ]);
      expect(() => parseDeck(store.get().deck)).not.toThrow();
    },
    60_000,
  );

  it.skipIf(!existsSync(bitterLessonDeck))(
    'keeps Bitter Lesson text boxes editable within the slide bounds',
    () => {
      const deck = importBitterLesson();
      for (const slide of deck.slides) {
        for (const element of slide.elements) {
          if (element.type !== 'text') continue;
          expect(element.autoFit, element.html).toBe(true);
          expect(element.x, element.html).toBeGreaterThanOrEqual(0);
          expect(element.y, element.html).toBeGreaterThanOrEqual(0);
          expect(element.x + element.w, element.html).toBeLessThanOrEqual(deck.canvas.w);
          expect(element.y + element.h, element.html).toBeLessThanOrEqual(deck.canvas.h);
        }
      }

      const training = deck.slides.flatMap((slide) => slide.elements).find((element) =>
        element.type === 'text' && element.html === 'Diffusion Forcing - Training');
      expect(training).toMatchObject({ x: 0, w: 1920 });
    },
    60_000,
  );

  it.skipIf(!existsSync(bitterLessonDeck))(
    'uses Keynote heading sizes with a browser-resolvable Times fallback',
    () => {
      const deck = importBitterLesson();
      const headings = deck.slides.flatMap((slide) => slide.elements).filter((element) =>
        element.type === 'text' &&
        (element.html.includes('LLM-style') || element.html.includes('Video-gen style')));

      expect(headings).toHaveLength(2);
      for (const heading of headings) {
        expect(heading.style['font-size']).toBe('70px');
        expect(heading.style['font-family']).toContain('"Times New Roman"');
        expect(heading.style['font-family']).toMatch(/serif$/);
      }
    },
    60_000,
  );

  it('reports a clear error for a file that is not a Keynote deck', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-bad-'));
    try {
      const bogus = join(dir, 'not-a-deck.key');
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync(bogus, 'this is not a zip');
      expect(() => report(bogus)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
