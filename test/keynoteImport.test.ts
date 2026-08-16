import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDeck } from '../src/shared/deck.js';

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
