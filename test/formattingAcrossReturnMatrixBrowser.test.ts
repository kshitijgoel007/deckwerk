import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import {
  MOD,
  startListEditingSession,
  type ListEditingSession,
  type TextRun,
} from './support/listEditingSession.js';

/**
 * Every run format, in every kind of line, across both kinds of break.
 *
 * Reported: in a bullet, pick a font size, type — the text is that size —
 * Return, and the new bullet is back at the original size. Return rebuilt the
 * new line with only bold/italic/underline/super/subscript, dropping size,
 * font and colour. The rule this checks, for each format × line × break:
 *
 *  - a format still on at the break is on for what is typed on the new line;
 *  - a format switched off before the break stays off there;
 *  - the text before the break keeps exactly what it was typed with;
 *  - nothing else changes on either line.
 */
const SHIFT = 8;

interface FormatCase {
  name: string;
  /** Turn the format on at a collapsed caret. */
  on: () => Promise<void>;
  /** Turn it off again, or null where "off" is not one gesture (a size, a colour). */
  off: (() => Promise<void>) | null;
  /** Whether the run shows the format, compared with the fixture's plain run. */
  shows: (run: TextRun, plain: TextRun) => boolean;
}

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession('formatting-return-matrix', 'Return Matrix');
  session = started.session;
  close = started.close;
}, 120_000);

afterAll(async () => {
  await close?.();
  close = null;
});

const chord = (key: string, code: string, keyCode: number, modifiers = MOD) => async () => {
  await session.cdp.chord(key, code, keyCode, modifiers);
  await wait(40);
};

/** Type a value into a Props number field and commit it with Enter (no Tab: focus goes back to the box). */
async function setField(label: string, value: string): Promise<void> {
  const id = `matrix-${label.replace(/\s+/g, '-').toLowerCase()}`;
  const found = await session.cdp.evaluate<boolean>(`(() => {
    const field = [...document.querySelectorAll('#inspector .field-number')]
      .find((node) => node.querySelector('span')?.textContent === ${JSON.stringify(label)});
    const input = field?.querySelector('input');
    if (!input) return false;
    input.id = ${JSON.stringify(id)};
    return true;
  })()`);
  expect(found, `no "${label}" field in Props`).toBe(true);
  await session.cdp.click(`#${id}`, label);
  await session.cdp.evaluate(`document.querySelector('#${id}').select()`);
  await session.cdp.typeKeys(value);
  await session.cdp.key('Enter', 13);
  await wait(120);
}

/** Pick the first swatch in the palette that is neither white nor black. */
async function pickColour(): Promise<void> {
  await session.cdp.click('#inspector .field-color .color-picker-trigger[aria-label^="Colour"]', 'Colour');
  const found = await session.cdp.evaluate<boolean>(`(() => {
    const swatch = [...document.querySelectorAll('.color-picker-popover .color-picker-palette-button')]
      .find((node) => !['#ffffff', '#000000'].includes(node.title.toLowerCase()));
    if (!swatch) return false;
    swatch.id = 'matrix-swatch';
    return true;
  })()`);
  expect(found, 'the colour palette has no coloured swatch').toBe(true);
  await session.cdp.click('#matrix-swatch', 'colour swatch');
  await wait(120);
}

const FORMATS: FormatCase[] = [
  { name: 'bold', on: chord('b', 'KeyB', 66), off: chord('b', 'KeyB', 66),
    shows: (run) => run.bold },
  { name: 'italic', on: chord('i', 'KeyI', 73), off: chord('i', 'KeyI', 73),
    shows: (run) => run.italic },
  { name: 'underline', on: chord('u', 'KeyU', 85), off: chord('u', 'KeyU', 85),
    shows: (run) => run.underline },
  { name: 'superscript', on: chord('=', 'Equal', 187, MOD | SHIFT), off: chord('=', 'Equal', 187, MOD | SHIFT),
    shows: (run) => run.baseline === 'super' },
  { name: 'subscript', on: chord('-', 'Minus', 189, MOD | SHIFT), off: chord('-', 'Minus', 189, MOD | SHIFT),
    shows: (run) => run.baseline === 'sub' },
  { name: 'font size', on: () => setField('Font size', '48'), off: null,
    shows: (run, plain) => run.fontSize !== plain.fontSize },
  { name: 'colour', on: () => pickColour(), off: null,
    shows: (run, plain) => run.color !== plain.color },
];

const LINES = [
  { name: 'paragraph', html: '<p>alpha</p>', blockTag: 'p' },
  { name: 'bulleted list', html: '<ul><li>alpha</li></ul>', blockTag: 'li' },
  { name: 'numbered list', html: '<ol><li>alpha</li></ol>', blockTag: 'li' },
] as const;

const BREAKS = [
  { name: 'Return', press: () => session.cdp.key('Enter', 13), newBlock: true },
  { name: 'Shift+Return', press: () => session.cdp.chord('Enter', 'Enter', 13, SHIFT), newBlock: false },
] as const;

function picture(runs: TextRun[]): string {
  return runs.map((run) => `${run.text}{${run.bold ? 'b' : ''}${run.italic ? 'i' : ''}`
    + `${run.underline ? 'u' : ''} ${run.baseline} ${run.fontSize} ${run.color}}@${run.blockTag}${run.block}`)
    .join(' ');
}

function runOf(runs: TextRun[], text: string): TextRun {
  const run = runs.find((candidate) => candidate.text.includes(text));
  expect(run, `no run holding ${JSON.stringify(text)} in ${picture(runs)}`).toBeTruthy();
  return run!;
}

/** Everything other than the format under test, which must not drift. */
function others(run: TextRun, format: FormatCase): Record<string, unknown> {
  const all: Record<string, unknown> = {
    bold: run.bold, italic: run.italic, underline: run.underline,
    baseline: run.baseline, fontSize: run.fontSize, color: run.color, fontFamily: run.fontFamily,
  };
  const owned: Record<string, string[]> = {
    bold: ['bold'], italic: ['italic'], underline: ['underline'],
    // A shifted baseline also shrinks the glyphs.
    superscript: ['baseline', 'fontSize'], subscript: ['baseline', 'fontSize'],
    'font size': ['fontSize'], colour: ['color'],
  };
  for (const key of owned[format.name]) delete all[key];
  return all;
}

async function startTyping(html: string): Promise<TextRun> {
  await session.reset(html);
  await session.edit();
  await session.caretIn('alpha', 'end');
  await session.cdp.typeKeys(' ');
  return runOf(await session.runs(), 'alpha');
}

describe.skipIf(!electronBinary)('formats across Return and Shift+Return, in paragraphs and lists', () => {
  for (const line of LINES) {
    for (const brk of BREAKS) {
      for (const format of FORMATS) {
        const where = `${format.name}, ${line.name}, ${brk.name}`;

        it(`${where}: on at the break carries onto the new line`, { timeout: 120_000 }, async () => {
          const plain = await startTyping(line.html);
          await format.on();
          await session.cdp.typeKeys('styled');
          await brk.press();
          await session.cdp.typeKeys('more');
          const runs = await session.runs();
          const shown = picture(runs);
          const styled = runOf(runs, 'styled');
          const more = runOf(runs, 'more');
          expect(format.shows(styled, plain), `styled lost ${format.name}: ${shown}`).toBe(true);
          expect(format.shows(more, plain), `${brk.name} dropped ${format.name}: ${shown}`).toBe(true);
          expect(format.shows(runOf(runs, 'alpha'), plain), `alpha caught ${format.name}: ${shown}`).toBe(false);
          expect(more.block, `wrong line: ${shown}`).toBe(styled.block + (brk.newBlock ? 1 : 0));
          expect(more.blockTag, `the new line changed kind: ${shown}`).toBe(line.blockTag);
          expect(others(more, format), `other formats drifted: ${shown}`).toEqual(others(plain, format));
          if (format.name === 'font size' || format.name === 'colour') {
            expect(more.fontSize, shown).toBe(styled.fontSize);
            expect(more.color, shown).toBe(styled.color);
          }
          expect(await session.liveProblems()).toEqual([]);
        });

        if (format.off) {
          const off = format.off;
          it(`${where}: switched off before the break stays off`, { timeout: 120_000 }, async () => {
            const plain = await startTyping(line.html);
            await format.on();
            await session.cdp.typeKeys('styled');
            await off();
            await brk.press();
            await session.cdp.typeKeys('plain');
            const runs = await session.runs();
            const shown = picture(runs);
            expect(format.shows(runOf(runs, 'styled'), plain), `styled lost ${format.name}: ${shown}`).toBe(true);
            const after = runOf(runs, 'plain');
            expect(format.shows(after, plain), `${format.name} came back after ${brk.name}: ${shown}`).toBe(false);
            expect(others(after, format), `other formats drifted: ${shown}`).toEqual(others(plain, format));
            expect(await session.liveProblems()).toEqual([]);
          });
        }
      }

      it(`every keyboard format at once, ${line.name}, ${brk.name}: all carry, then all switch off`, {
        timeout: 120_000,
      }, async () => {
        const plain = await startTyping(line.html);
        const keyed = FORMATS.filter((format) => format.off && format.name !== 'subscript');
        for (const format of keyed) await format.on();
        await session.cdp.typeKeys('all');
        await brk.press();
        await session.cdp.typeKeys('again');
        for (const format of keyed) await format.off!();
        await brk.press();
        await session.cdp.typeKeys('none');
        const runs = await session.runs();
        const shown = picture(runs);
        for (const format of keyed) {
          expect(format.shows(runOf(runs, 'all'), plain), `all lost ${format.name}: ${shown}`).toBe(true);
          expect(format.shows(runOf(runs, 'again'), plain), `again lost ${format.name}: ${shown}`).toBe(true);
          expect(format.shows(runOf(runs, 'none'), plain), `none kept ${format.name}: ${shown}`).toBe(false);
        }
        expect(await session.liveProblems()).toEqual([]);
      });
    }

    it(`size and colour together, ${line.name}: both carry through two Returns`, { timeout: 120_000 }, async () => {
      const plain = await startTyping(line.html);
      await setField('Font size', '48');
      await pickColour();
      await chord('b', 'KeyB', 66)();
      await session.cdp.typeKeys('one');
      await session.cdp.key('Enter', 13);
      await session.cdp.typeKeys('two');
      await session.cdp.key('Enter', 13);
      await session.cdp.typeKeys('three');
      const runs = await session.runs();
      const shown = picture(runs);
      const one = runOf(runs, 'one');
      expect(one.fontSize, shown).not.toBe(plain.fontSize);
      expect(one.color, shown).not.toBe(plain.color);
      for (const text of ['two', 'three']) {
        const run = runOf(runs, text);
        expect({ size: run.fontSize, color: run.color, bold: run.bold }, `${text}: ${shown}`)
          .toEqual({ size: one.fontSize, color: one.color, bold: true });
        expect(run.blockTag, shown).toBe(line.blockTag);
      }
      expect(await session.liveProblems()).toEqual([]);
    });
  }
});
