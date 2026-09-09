import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';
import {
  CONTENT,
  MOD,
  OTHER_CONTENT,
  startListEditingSession,
  type ListEditingSession,
} from './support/listEditingSession.js';
import {
  deckSnapshotEventually,
  diffDeckSnapshots,
  markupProblems,
  sameDeckSnapshot,
  SEAL_MS,
  selectionProblems,
  settledDeckSnapshot,
} from './support/pasteMarkupCorpus.js';

/**
 * A sweep and a random walk over list editing, all of it real input.
 *
 * The sweep is the sequence that exposed the bug: bullet a whole box of
 * paragraphs, open an empty bullet in the middle of the list, delete that
 * bullet, and write plain text where it was. Every position in the list, both
 * marker kinds, and both ways of deleting the empty bullet — Return on it, or
 * Backspace at its start — are run, and the exact structure that must result
 * is spelled out rather than merely checked for soundness.
 *
 * The random walk then throws the rest of an author's list vocabulary at the
 * box in a seeded order: bullet, number and free the selection, split lines,
 * delete backwards, indent, outdent, type, undo. After every single step the
 * markup must still be something the editor and the exporters can work with,
 * on screen and as stored by the collaboration server.
 *
 * `RUN_EXHAUSTIVE_LIST_FUZZ=1` runs every sweep case and a much longer walk,
 * `LIST_FUZZ_SEED=<n>` walks a different order, and `LIST_FUZZ_TRACE=1` prints
 * the box's markup before every step — the three knobs a failure needs.
 */
const RUN_EXHAUSTIVE = process.env.RUN_EXHAUSTIVE_LIST_FUZZ === '1';
/** `LIST_FUZZ_SEED=<n>` walks a different order through the same vocabulary. */
const SEED = Number.parseInt(process.env.LIST_FUZZ_SEED ?? '', 10) || 9012026;
/**
 * The LIST_FUZZ_SEED walk (or the fixed default) is the regression corpus;
 * FUZZ_SEED (CI's nightly exports the current date) walks extra seeds too.
 */
const WALK_SEEDS = [...new Set([SEED, ...extraFuzzSeeds()])];
const DECK_ID = 'list-editing-fuzz';
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession(DECK_ID, 'List Fuzz');
  session = started.session;
  close = started.close;
}, 120_000);

afterAll(async () => {
  await close?.();
  close = null;
});

/** A small, reproducible pseudo-random source. */
function random(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

type Kind = 'Bulleted' | 'Numbered';
type Route = 'return' | 'backspace';
interface SweepCase { kind: Kind; length: number; at: number; route: Route }

function sweepCases(): SweepCase[] {
  const kinds: Kind[] = ['Bulleted', 'Numbered'];
  const routes: Route[] = ['return', 'backspace'];
  const lengths = RUN_EXHAUSTIVE ? [2, 3, 4, 5, 6] : [3, 5];
  const all: SweepCase[] = [];
  for (const kind of kinds) {
    for (const length of lengths) {
      for (let at = 0; at < length; at++) {
        for (const route of routes) all.push({ kind, length, at, route });
      }
    }
  }
  if (RUN_EXHAUSTIVE) return all;
  // A seeded spread that still covers every kind, route and position.
  const next = random(20260901);
  return all.filter(() => next() < 12 / all.length);
}

/**
 * Structural problems that matter in the live contenteditable surface.
 *
 * Chromium writes sub-lists as *siblings* of the item they belong to, and its
 * Return inside such an item can leave an item nested in an item. Those are
 * the browser's own shapes, not the editor's, and normalisation repairs them
 * on the way to the deck — where they are checked with no exception at all.
 * So they are tolerated here, and only while the box actually has a sub-list:
 * a flat list must be sound on screen too.
 */
const CHROMIUM_NESTING_QUIRKS = [
  'a list is nested directly inside a list',
  'a block is nested inside a block that cannot contain it',
  'a list item is outside a list',
];

async function liveProblems(): Promise<string[]> {
  const problems = await session.problems();
  const nested = await session.cdp.evaluate<boolean>(
    `Boolean(document.querySelector('${CONTENT} :is(ul, ol) :is(ul, ol, li li)'))`);
  return nested ? problems.filter((problem) => !CHROMIUM_NESTING_QUIRKS.includes(problem))
    : problems;
}

async function expectSound(label: string): Promise<void> {
  const live = await liveProblems();
  expect(live, `${label}: live markup ${live.length > 0 ? await session.markup() : ''}`)
    .toEqual([]);
  const stored = await session.persistedProblems();
  expect(stored, `${label}: stored markup`).toEqual([]);
  expect(await markupProblems(session.cdp, OTHER_CONTENT), `${label}: the other box's markup`)
    .toEqual([]);
  expect(await selectionProblems(session.cdp), `${label}: selection/editing invariants`)
    .toEqual([]);
}

const compact = (value: string) => value.replace(/\s+/g, '');

describe.skipIf(!electronBinary)('list editing under a sweep of real edits', () => {
  it('opens, deletes and replaces an empty bullet at every position', {
    timeout: RUN_EXHAUSTIVE ? 60 * 60_000 : 600_000,
  }, async () => {
    const cases = sweepCases();
    expect(cases.length, 'the sweep has cases to run').toBeGreaterThan(0);
    for (const testCase of cases) {
      await runSweepCase(testCase);
    }
  });

  for (const walkSeed of WALK_SEEDS) {
    it(`survives a seeded walk through the list vocabulary (seed ${walkSeed})`, {
      timeout: RUN_EXHAUSTIVE ? 60 * 60_000 : 600_000,
    }, async () => {
      await runWalk(walkSeed);
    });
  }
});

async function runWalk(seed: number): Promise<void> {
  const steps = RUN_EXHAUSTIVE ? 200 : 40;
  console.log(`walking ${steps} steps from seed ${seed}`);
  const next = random(seed);
  const actions = [
    'bullet all', 'number all', 'free all', 'caret', 'return', 'empty bullet',
    'backspace at start', 'type', 'indent', 'outdent', 'undo',
    'other box', 'escape and re-enter', 'cut words', 'cut bullet', 'paste',
  ] as const;
  // The clipboard holds whatever the last cut put there; a paste before any
  // cut would paste another test's leftovers, which reproduces nothing.
  let clipboardArmed = false;

  await session.reset('<p>alpha</p><p>beta</p><p>gamma</p><p>delta</p>');
  await session.edit();
  let typed = 0;
  for (let step = 0; step < steps; step++) {
    const action = actions[Math.floor(next() * actions.length)];
    const label = `seed ${seed}, step ${step + 1} (${action})`;
    const before = compact(await session.text());
    if (process.env.LIST_FUZZ_TRACE === '1') {
      console.log(label, 'BEFORE', await session.markup());
    }
    switch (action) {
      case 'bullet all':
        await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
        await session.chooseList('Bulleted');
        break;
      case 'number all':
        await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
        await session.chooseList('Numbered');
        break;
      case 'free all':
        await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
        await session.chooseList('None');
        break;
      case 'caret':
        await moveCaret(next);
        break;
      case 'return':
        await moveCaret(next);
        await session.cdp.key('Enter', 13);
        break;
      case 'empty bullet':
        await moveCaret(next, 'end');
        await session.cdp.key('Enter', 13);
        await session.cdp.key('Enter', 13);
        break;
      case 'backspace at start':
        await moveCaret(next, 'start');
        await session.cdp.key('Backspace', 8);
        break;
      case 'type': {
        const word = `w${step}`;
        await moveCaret(next, 'end');
        await session.cdp.typeKeys(word);
        typed += 1;
        const after = compact(await session.text());
        expect(after.length, `${label}: characters inserted`)
          .toBe(before.length + word.length);
        break;
      }
      case 'indent':
        await moveCaret(next);
        await session.cdp.key('Tab', 9);
        break;
      case 'outdent':
        await moveCaret(next);
        await session.cdp.chord('Tab', 'Tab', 9, 8);
        break;
      case 'undo':
        // The restoration oracle: undo must actually restore the previous
        // persisted state, and redo must re-reach the undone state.
        await runUndoCheckpoint(next, label);
        break;
      case 'other box': {
        // Straight into the other box — no Escape first — type a nonce that
        // must land ONLY there, then back into the list box via the same
        // caret-placement helper the walk always uses, so the OUTLINE model
        // stays deterministic and the list box's content stays untouched.
        if ((await session.text()).length === 0) break;
        const nonce = nextNonce();
        await session.cdp.doubleClickText(OTHER_CONTENT, 'the other text box');
        await eventually(async () => session.cdp.evaluate<boolean>(
          `document.querySelector('${OTHER_CONTENT}')?.isContentEditable === true`,
        ), `${label}: the other box did not enter editing`);
        await session.cdp.key('End', 35);
        await session.cdp.typeKeys(nonce);
        const otherText = await session.cdp.evaluate<string>(
          `document.querySelector('${OTHER_CONTENT}')?.textContent ?? ''`);
        expect(otherText, `${label}: the nonce landed in the other box`).toContain(nonce);
        expect(await session.text(), `${label}: the nonce stayed out of the list box`)
          .not.toContain(nonce);
        await session.edit();
        await moveCaret(next);
        expect(compact(await session.text()), `${label}: the excursion left the list box unchanged`)
          .toBe(before);
        break;
      }
      case 'cut words': {
        // The words of an item, without its line break: Chromium's clipboard
        // fragment is an inline run wearing the item's computed style.
        await moveCaret(next, 'start');
        await session.cdp.chord('End', 'End', 35, 8);
        await session.cdp.chord('x', 'KeyX', 88, MOD, ['cut']);
        clipboardArmed = true;
        break;
      }
      case 'cut bullet': {
        // The item with its line break: the fragment is a list of one item.
        await moveCaret(next, 'start');
        await session.cdp.chord('ArrowDown', 'ArrowDown', 40, 8);
        await session.cdp.chord('x', 'KeyX', 88, MOD, ['cut']);
        clipboardArmed = true;
        break;
      }
      case 'paste': {
        if (!clipboardArmed) break;
        await moveCaret(next, next() < 0.5 ? 'start' : 'middle');
        await session.cdp.chord('v', 'KeyV', 86, MOD, ['paste']);
        // The repair runs on the input event; the seal and the store follow.
        await wait(150);
        const markup = await session.markup();
        expect(markup, `${label}: pasted layout style survived`)
          .not.toMatch(/text-indent|line-height:|white-space:/);
        break;
      }
      case 'escape and re-enter': {
        if ((await session.text()).length === 0) break;
        // Focus may sit in the inspector, where Escape means something else.
        await session.cdp.click(CONTENT, 'the text box before Escape');
        await session.cdp.key('Escape', 27);
        await eventually(async () => session.cdp.evaluate<boolean>(
          `document.querySelector('${CONTENT}')?.isContentEditable !== true`,
        ), `${label}: Escape did not leave text editing`);
        await session.edit();
        await moveCaret(next);
        expect(compact(await session.text()), `${label}: the round trip changed the list box`)
          .toBe(before);
        break;
      }
    }
    await expectSound(label);
    const outline = await session.outline();
    expect(outline.length, `${label}: the box still has blocks`).toBeGreaterThan(0);
    for (const line of outline) {
      // `?ul`/`?ol` is the sibling sub-list Chromium's indent writes, which
      // the editor repairs on the way to the deck. Anything else with a
      // question mark is a node inside a list with no business being there.
      if (line.trim().startsWith('?')) {
        expect(['?ul', '?ol'], `${label}: unexpected node inside a list`)
          .toContain(line.trim());
      }
    }
  }
  expect(typed, 'the walk typed at least once').toBeGreaterThan(0);
}

/** A nonce no other step has typed anywhere, so "landed only there" is exact. */
let nonceCounter = 0;
function nextNonce(): string {
  nonceCounter += 1;
  return `n${nonceCounter}q`;
}

/**
 * The undo-restoration oracle, at a sealed boundary: pause past the idle seal,
 * settle the persisted deck, run one sealed typing run (a documented single
 * undo step), settle again, then demand that one Cmd/Ctrl+Z restores the whole
 * pre-op deck exactly and one Cmd/Ctrl+Shift+Z re-reaches the post-op deck.
 */
async function runUndoCheckpoint(next: () => number, label: string): Promise<void> {
  const { cdp, port } = session;
  await wait(SEAL_MS);
  const before = await settledDeckSnapshot(cdp, port, DECK_ID, `${label}: pre-op`);
  const nonce = nextNonce();
  await moveCaret(next, 'end');
  await cdp.typeKeys(nonce);
  await wait(SEAL_MS);
  const after = await settledDeckSnapshot(cdp, port, DECK_ID, `${label}: post-op`);
  if (sameDeckSnapshot(before, after)) {
    // Typing landed nowhere persistable (an emptied box gives the caret
    // nothing to hold); there is no entry to undo, so nothing to check.
    return;
  }
  await cdp.click(CONTENT, 'the text box before undoing');
  await session.undo();
  const undone = await deckSnapshotEventually(cdp, port, DECK_ID, before);
  if (!sameDeckSnapshot(undone, before)) {
    expect.fail(`${label}: one undo after typing ${JSON.stringify(nonce)} did not restore `
      + `the pre-op deck\n${diffDeckSnapshots(before, undone)}`);
  }
  await cdp.chord('z', 'KeyZ', 90, MOD | 8);
  await wait(200);
  const redone = await deckSnapshotEventually(cdp, port, DECK_ID, after);
  if (!sameDeckSnapshot(redone, after)) {
    expect.fail(`${label}: redo after the undo did not re-reach the post-op deck\n`
      + diffDeckSnapshots(after, redone));
  }
}

describe.skipIf(electronBinary)('list editing under a sweep of real edits (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});

/** Click into a random paragraph or item, then go to one end of it. */
async function moveCaret(next: () => number, where: 'start' | 'end' | 'middle' = 'middle') {
  const length = await session.cdp.evaluate<number>(
    `(document.querySelector('${CONTENT}')?.textContent ?? '').length`);
  if (length === 0) return;
  const offset = Math.min(length - 1, Math.floor(next() * length));
  await session.caretAt(offset);
  if (where === 'start') await session.cdp.key('Home', 36);
  if (where === 'end') await session.cdp.key('End', 35);
}

async function runSweepCase({ kind, length, at, route }: SweepCase): Promise<void> {
  const words = WORDS.slice(0, length);
  const where = `${kind.toLowerCase()} ${length} items, empty bullet after ${words[at]}, `
    + `deleted with ${route === 'return' ? 'Return' : 'Backspace'}`;
  const tag = kind === 'Bulleted' ? 'ul' : 'ol';
  const marked = (list: string[]) => list.map((word) => `- ${word}`);

  await session.reset(words.map((word) => `<p>${word}</p>`).join(''));
  await session.edit();

  // Make the whole box a list.
  await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
  expect(await session.chooseList(kind), `${where}: one press reaches ${kind}`).toEqual([kind]);
  expect(await session.outline(), `${where}: the whole box is one list`)
    .toEqual([tag, ...marked(words)]);

  // Open an empty bullet after the chosen item.
  await session.caretIn(words[at], 'end');
  await session.cdp.key('Enter', 13);
  expect(await session.outline(), `${where}: an empty bullet opened`).toEqual([
    tag, ...marked(words.slice(0, at + 1)), '- ', ...marked(words.slice(at + 1)),
  ]);
  await expectSound(`${where}: with an empty bullet`);

  // Delete it, the way the author asks to stop being in a list.
  if (route === 'return') await session.cdp.key('Enter', 13);
  else await session.cdp.key('Backspace', 8);

  const tail = words.slice(at + 1);
  const tailTag = kind === 'Numbered' ? `${tag}@${at + 2}` : tag;
  const expected = (paragraph: string) => [
    tag,
    ...marked(words.slice(0, at + 1)),
    `p: ${paragraph}`,
    ...(tail.length > 0 ? [tailTag, ...marked(tail)] : []),
  ];
  expect(await session.outline(), `${where}: the bullet is gone`).toEqual(expected(''));

  // Write plain text where the bullet was.
  const note = `note ${at}`;
  await session.cdp.typeKeys(note);
  expect(await session.outline(), `${where}: plain text where the bullet was`)
    .toEqual(expected(note));
  await session.expectPersisted(
    (lines) => lines.join('|') === expected(note).join('|'), `${where}: stored`);
  await expectSound(`${where}: after typing plain text`);
}
