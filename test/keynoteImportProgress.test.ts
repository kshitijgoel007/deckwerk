import { describe, expect, it } from 'vitest';
import { createStderrReader } from '../src/main/keynoteImport.js';

/**
 * The importer's phase channel.
 *
 * Progress shares stderr with the sidecar's diagnostics because stdout is the
 * machine-readable JSON channel. That sharing is the whole risk: a phase must
 * never be shown as diagnostic output, and — more importantly — a traceback
 * must never be lost because it arrived next to one.
 */

function read(): {
  push(chunk: string): void;
  finish(): string;
  phases: { message: string; ratio: number | null }[];
} {
  const phases: { message: string; ratio: number | null }[] = [];
  const reader = createStderrReader((message, ratio) => phases.push({ message, ratio }));
  return { push: reader.push, finish: reader.finish, phases };
}

describe('the Keynote importer progress channel', () => {
  it('reports a phase with its completion and keeps it out of the diagnostics', () => {
    const r = read();
    r.push('@progress 0.3287 Transcoding crimson_desert.mov from hevc to H.264\n');
    expect(r.phases).toEqual([
      { message: 'Transcoding crimson_desert.mov from hevc to H.264', ratio: 0.3287 },
    ]);
    expect(r.finish()).toBe('');
  });

  it('treats a "-" completion as indeterminate rather than as zero', () => {
    const r = read();
    r.push('@progress - Decoding 2609_phd_welcome.key\n');
    expect(r.phases).toEqual([{ message: 'Decoding 2609_phd_welcome.key', ratio: null }]);
  });

  it('reassembles a phase split across stream chunks', () => {
    const r = read();
    r.push('@progress 0.50 Converting sli');
    expect(r.phases).toEqual([]);
    r.push('de 67 of 134\n@progress 0.94 Classifying text roles\n');
    expect(r.phases.map((p) => p.message)).toEqual([
      'Converting slide 67 of 134',
      'Classifying text roles',
    ]);
  });

  it('keeps a library\'s partial line when a phase lands on the end of it', () => {
    const r = read();
    // PyMuPDF prints without a trailing newline, so its text and the next
    // phase arrive as one line. Losing the warning would hide a real problem.
    r.push('warning: the `fitz` API is deprecated@progress 0.10 Decoding Document.iwa\n');
    expect(r.phases).toEqual([{ message: 'Decoding Document.iwa', ratio: 0.1 }]);
    expect(r.finish()).toBe('warning: the `fitz` API is deprecated');
  });

  it('preserves ordinary diagnostics, including a final unterminated line', () => {
    const r = read();
    r.push('Traceback (most recent call last):\n  File "import_keynote.py"');
    expect(r.phases).toEqual([]);
    expect(r.finish()).toBe('Traceback (most recent call last):\n  File "import_keynote.py"');
  });

  it('keeps a malformed phase line as diagnostics instead of reporting it', () => {
    const r = read();
    r.push('@progress\n@progress 0.5\n@progress notanumber Doing something\n');
    expect(r.phases).toEqual([]);
    expect(r.finish()).toContain('notanumber Doing something');
  });

  it('clamps a completion the sidecar reports outside 0..1', () => {
    const r = read();
    r.push('@progress 1.4 Writing deck.json\n@progress -0.2 Opening deck.key\n');
    expect(r.phases.map((p) => p.ratio)).toEqual([1, 0]);
  });

  it('bounds the retained diagnostics so a long run cannot grow unboundedly', () => {
    const r = read();
    for (let i = 0; i < 500; i += 1) r.push(`warning ${i}: ${'x'.repeat(100)}\n`);
    const kept = r.finish();
    expect(kept.length).toBeLessThanOrEqual(4000);
    // The tail is what a failure message needs: the most recent output.
    expect(kept).toContain('warning 499');
  });
});
