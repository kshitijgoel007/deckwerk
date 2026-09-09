// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { normalizeParagraphHtml } from '../src/shared/paragraphs.js';
import { sanitizePastedTextHtml } from '../src/shared/htmlSafety.js';
import { MARKUP_INVARIANTS } from './support/pasteMarkupCorpus.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';

/**
 * Fuzzing the markup repair that every paste, cut and indent goes through.
 *
 * The editor does not write list markup itself: Chromium's contenteditable
 * does, and other applications' clipboards do, and both produce shapes the
 * block model cannot express — items outside a list, a list as a sibling of
 * its items, whitespace between blocks (which `white-space: pre-wrap` paints
 * as blank lines), runs wearing the computed layout of the box they were cut
 * from. `repairPastedMarkup` in canvas.ts runs the pasted box through
 * `sanitizePastedTextHtml` and `normalizeParagraphHtml`; this file generates
 * thousands of such shapes from a seeded vocabulary of cut-and-paste artefacts
 * and checks the repaired markup against the invariants the renderer, the
 * exporters and the list operations assume.
 *
 * `LIST_MARKUP_FUZZ_SEED=<n>` walks a different corpus; `FUZZ_SEED` (CI's
 * nightly date) adds seeds. A failure message carries the input, so any case
 * reproduces on its own.
 */

const SEED = Number.parseInt(process.env.LIST_MARKUP_FUZZ_SEED ?? '', 10) || 20260909;
const SEEDS = [...new Set([SEED, ...extraFuzzSeeds()])];
const CASES = process.env.RUN_EXHAUSTIVE_LIST_MARKUP_FUZZ === '1' ? 20_000 : 1500;

function random(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
/** Whitespace as clipboards and pretty-printers place it between markup. */
const GAPS = ['', '', '', '\n', '\n\n', ' ', '\n  ', '\r\n'];
/** The style Chromium writes onto a run cut out of a bullet in this editor. */
const CUT_RUN_STYLE = 'color: rgb(0, 0, 0); font-family: Avenir; font-size: 48px; '
  + 'font-weight: 700; letter-spacing: 0px; text-indent: -1.4em; white-space: pre-wrap; '
  + 'line-height: 1.32; text-align: left; display: inline !important; float: none;';
const INLINE_WRAPS = [
  (text: string) => text,
  (text: string) => `<b>${text}</b>`,
  (text: string) => `<span style="font-style: italic;">${text}</span>`,
  (text: string) => `<span style="${CUT_RUN_STYLE}">${text}</span>`,
  (text: string) => `<b><span style="font-style: normal;">${text}</span></b>`,
  (text: string) => `<strong style="text-indent: -1.4em">${text}</strong>`,
];

interface Generator { next: () => number; depth: number }

function pick<T>(g: Generator, items: readonly T[]): T {
  return items[Math.floor(g.next() * items.length)];
}

function inlineRun(g: Generator, allowNewlineTail: boolean): string {
  const word = pick(g, WORDS);
  const wrapped = pick(g, INLINE_WRAPS)(word);
  const tail = allowNewlineTail ? pick(g, GAPS) : '';
  const head = allowNewlineTail ? pick(g, GAPS) : '';
  const soft = g.next() < 0.15 ? '<br>' : '';
  return `${head}${wrapped}${soft}${tail}`;
}

function item(g: Generator): string {
  const parts: string[] = [];
  const runs = 1 + Math.floor(g.next() * 2);
  for (let i = 0; i < runs; i++) parts.push(inlineRun(g, true));
  // A sub-list inside the item (the saved shape) ...
  if (g.depth < 3 && g.next() < 0.3) {
    g.depth += 1;
    parts.push(pick(g, GAPS) + list(g) + pick(g, GAPS));
    g.depth -= 1;
  }
  // ... an item nested straight inside an item (Chromium's Return) ...
  if (g.depth < 3 && g.next() < 0.08) parts.push(`<li>${inlineRun(g, false)}</li>`);
  // ... or an empty item, which is how a cut leaves the bullet behind.
  if (g.next() < 0.1) return '<li><br></li>';
  return `<li>${parts.join('')}</li>`;
}

function list(g: Generator): string {
  const tag = g.next() < 0.7 ? 'ul' : 'ol';
  const children: string[] = [];
  const count = 1 + Math.floor(g.next() * 4);
  for (let i = 0; i < count; i++) {
    const roll = g.next();
    if (roll < 0.12 && g.depth < 3) {
      // Chromium's indent: a list as a sibling of the items.
      g.depth += 1;
      children.push(list(g));
      g.depth -= 1;
    } else {
      children.push(item(g));
    }
  }
  return `<${tag}>${pick(g, GAPS)}${children.join(pick(g, GAPS))}${pick(g, GAPS)}</${tag}>`;
}

function paragraph(g: Generator): string {
  const roll = g.next();
  if (roll < 0.15) return `<div>${inlineRun(g, true)}</div>`;
  if (roll < 0.25) return `<li>${inlineRun(g, true)}</li>`; // orphan, as a partial copy pastes
  if (roll < 0.35) return inlineRun(g, false); // bare text at the top level
  if (roll < 0.45) return `<p style="margin: 0 0 12pt; text-indent: 2em; line-height: 115%">${inlineRun(g, true)}</p>`;
  return `<p>${inlineRun(g, true)}</p>`;
}

function markup(g: Generator): string {
  const blocks: string[] = [];
  const count = 1 + Math.floor(g.next() * 4);
  for (let i = 0; i < count; i++) {
    blocks.push(g.next() < 0.5 ? list(g) : paragraph(g));
  }
  return blocks.join(pick(g, GAPS));
}

const check = new Function(`return ${MARKUP_INVARIANTS}`)() as (root: Element) => string[];

function problemsIn(html: string): string[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  // One plain paragraph is saved as bare inline markup by design (a
  // single-line label stays what it was imported as); that is not a stray
  // top-level node.
  const bare = root.children.length > 0 && ![...root.children].some((child) => BLOCK.test(child.tagName));
  return check(root).filter((problem) => !(bare && problem.startsWith('top-level ')));
}
const BLOCK = /^(P|UL|OL|TABLE|H[1-6]|BLOCKQUOTE|PRE|DIV)$/;

/** The repair as the editor applies it after a paste. */
function repaired(html: string): string {
  return normalizeParagraphHtml(sanitizePastedTextHtml(html), true);
}

/** Every non-whitespace character, in order: what the repair must keep. */
function letters(html: string): string {
  const root = document.createElement('div');
  root.innerHTML = html;
  return (root.textContent ?? '').replace(/\s+/g, '');
}

describe('list and paragraph markup repair under fuzzed cut-and-paste shapes', () => {
  for (const seed of SEEDS) {
    it(`repairs ${CASES} generated shapes from seed ${seed} into sound markup`, () => {
      const g: Generator = { next: random(seed), depth: 0 };
      for (let index = 0; index < CASES; index++) {
        const input = markup(g);
        const label = `seed ${seed}, case ${index + 1}: ${JSON.stringify(input)}`;
        const once = repaired(input);
        expect(problemsIn(once), `${label}\nrepaired to ${JSON.stringify(once)}`).toEqual([]);
        // Every word survives; only markup formatting is allowed to go.
        expect(letters(once), `${label}: text lost or invented`).toBe(letters(input));
        // Saving what was repaired and repairing it again must be a no-op:
        // the entering and leaving passes both run it, and a normalisation
        // that keeps changing the markup shows up as phantom undo entries.
        const twice = repaired(once);
        expect(twice, `${label}: the repair is not idempotent`).toBe(once);
        // The leaving pass keeps soft breaks; it must agree with the entering
        // pass on everything else.
        expect(normalizeParagraphHtml(once), `${label}: the leaving pass disagrees`).toBe(once);
      }
    });
  }
});
