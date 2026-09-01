import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import { PASTE_CORPUS, pasteFromClipboard } from './support/pasteMarkupCorpus.js';
import {
  BOX_A,
  BOX_B,
  CONTENT_A,
  CONTENT_B,
  diffSnapshots,
  MOD,
  sameSnapshot,
  snapshotEventually,
  startUndoSession,
  type Snapshot,
  type UndoSession,
} from './support/undoRestorationSession.js';

/**
 * The oracle the other fuzz suites lack: undo must actually *restore state*.
 *
 * A seeded walk edits two committed textboxes — one a list, one plain
 * paragraphs — with real keyboard and pointer input. At random checkpoints the
 * walk seals the current typing run, snapshots the whole persisted slide,
 * performs exactly one more operation, and then demands that:
 *
 *   1. one Ctrl/Cmd+Z brings the whole slide back to the pre-op snapshot
 *      (every element, full normalised markup — not just text);
 *   2. Ctrl/Cmd+Shift+Z re-reaches the undone state exactly;
 *   3. undoing an edit in one box never changes the other box;
 *   4. at the end of the walk, repeated Ctrl/Cmd+Z returns the deck to its
 *      exact starting state, and further Ctrl/Cmd+Z is a no-op.
 *
 * The state compared is what the collaboration server persisted: word joiners
 * are stripped and markup is round-tripped through the browser's parser, so
 * only real differences count.
 *
 * `UNDO_RESTORE_SEED=<n>` walks one extra seed of your choosing.
 */

const SEEDS = [11, 909, 20260901, 424242, 777001];
const EXTRA_SEED = Number.parseInt(process.env.UNDO_RESTORE_SEED ?? '', 10);
if (Number.isFinite(EXTRA_SEED)) SEEDS.push(EXTRA_SEED);
const STEPS = 12;

/** Small rich-ish payloads from the shared paste corpus. */
const PASTE_NAMES = ['plain-text-single-line', 'own-editor-markup', 'google-docs-list'];
const PAYLOADS = PASTE_NAMES.map((name) => {
  const payload = PASTE_CORPUS.find((candidate) => candidate.name === name);
  if (!payload) throw new Error(`the paste corpus lost ${name}`);
  return payload;
});

/** The same reproducible pseudo-random source the other fuzz suites use. */
function random(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

const WALK_ACTIONS = [
  'type', 'softbreak', 'split', 'bold', 'italic', 'underline',
  'list-toggle', 'indent', 'outdent', 'paste', 'switch', 'escape', 'backspace',
] as const;
type WalkAction = typeof WALK_ACTIONS[number];

/**
 * Checkpoint operations are the single-undo-step subset: one sealed run of
 * typing, one formatting toggle, one backspace run, one paste. Each of these
 * is documented (and separately tested) to be exactly one undo step, so one
 * Ctrl/Cmd+Z afterwards must land exactly on the pre-op state.
 */
const CHECKPOINT_ACTIONS = ['type', 'bold', 'backspace', 'paste'] as const;

const LIST_FIELD = '#inspector .text-list-style select';

let closeSession: (() => Promise<void>) | null = null;

afterEach(async () => {
  await closeSession?.();
  closeSession = null;
});

interface Walker {
  session: UndoSession;
  next: () => number;
  current: string;
  other: string;
  trace: string[];
}

function contentOf(id: string): string {
  return `#canvas [data-element-id="${id}"] .text-content`;
}

/** Length of the rendered, joiner-free text in the current box. */
async function renderedLength(walker: Walker): Promise<number> {
  return (await walker.session.text(contentOf(walker.current))).length;
}

/** Put a real caret somewhere in the current box (editing already entered). */
async function placeCaret(walker: Walker, where: 'start' | 'end' | 'middle'): Promise<void> {
  const { session, next, current } = walker;
  const selector = contentOf(current);
  const length = await session.cdp.evaluate<number>(
    `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').length`);
  if (length === 0) {
    await session.cdp.click(selector, 'the empty box');
    return;
  }
  const offset = Math.min(length - 1, Math.floor(next() * length));
  try {
    await session.cdp.clickTextAtOffset(selector, offset, `text offset ${offset}`);
  } catch {
    // A soft break or emptied line can leave the chosen glyph unrendered;
    // clicking the box itself still places a real caret.
    await session.cdp.click(selector, 'the box (glyph fallback)');
  }
  if (where === 'start') await session.cdp.key('Home', 36);
  if (where === 'end') await session.cdp.key('End', 35);
}

/** Real shift-click selection over a short random range of the current box. */
async function selectSomeText(walker: Walker): Promise<boolean> {
  const { session, next, current } = walker;
  const length = await renderedLength(walker);
  if (length < 2) return false;
  const start = Math.floor(next() * (length - 1));
  const end = Math.min(length, start + 1 + Math.floor(next() * Math.min(8, length - start - 1) + 1));
  await session.cdp.selectTextRange(contentOf(current), start, Math.max(end, start + 1));
  return true;
}

/** A Shift+Enter delivered as the physical keyboard delivers it. */
async function softBreak(session: UndoSession): Promise<void> {
  const key = {
    key: 'Enter', code: 'Enter', modifiers: 8,
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  };
  await session.cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await session.cdp.call('Input.dispatchKeyEvent', {
    type: 'char', text: '\r', unmodifiedText: '\r', ...key,
  });
  await session.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/** One press of type-ahead at the List dropdown, changing the list style. */
async function toggleList(walker: Walker): Promise<void> {
  const { session } = walker;
  await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
  const present = await session.cdp.evaluate<boolean>(
    `Boolean(document.querySelector('${LIST_FIELD}'))`);
  if (!present) return;
  const shown = await session.cdp.evaluate<string>(
    `document.querySelector('${LIST_FIELD}').value`);
  // Type-ahead moves to the *next* option starting with the letter, so press
  // the letter of an option we are not on: 'b' flips to Bulleted, and from
  // Bulleted 'n' reaches None first.
  const letter = shown === 'Bulleted' ? 'n' : 'b';
  await session.cdp.pressOptionKey(LIST_FIELD, letter, 'the List dropdown');
  await wait(150);
}

/** Perform one walk operation with real input. Returns what it did. */
async function performAction(walker: Walker, action: WalkAction, step: number): Promise<string> {
  const { session } = walker;
  const editable = contentOf(walker.current);
  const needsEditing = action !== 'switch' && action !== 'escape';
  if (needsEditing) await session.edit(editable);
  switch (action) {
    case 'type': {
      await placeCaret(walker, 'end');
      const word = `w${step}x`;
      await session.cdp.typeKeys(word);
      return `type ${word} into ${walker.current}`;
    }
    case 'softbreak':
      await placeCaret(walker, 'end');
      await softBreak(session);
      return `shift+enter in ${walker.current}`;
    case 'split':
      await placeCaret(walker, 'middle');
      await session.cdp.key('Enter', 13);
      return `enter split in ${walker.current}`;
    case 'bold':
    case 'italic':
    case 'underline': {
      if (!(await selectSomeText(walker))) return `${action}: nothing to select`;
      const letter = action === 'bold' ? 'b' : action === 'italic' ? 'i' : 'u';
      await session.cdp.chord(letter, `Key${letter.toUpperCase()}`,
        letter.toUpperCase().charCodeAt(0), MOD);
      await wait(150);
      return `${action} over a shift-click selection in ${walker.current}`;
    }
    case 'list-toggle':
      await toggleList(walker);
      return `list toggle in ${walker.current}`;
    case 'indent':
      await placeCaret(walker, 'middle');
      await session.cdp.key('Tab', 9);
      return `tab indent in ${walker.current}`;
    case 'outdent':
      await placeCaret(walker, 'middle');
      await session.cdp.chord('Tab', 'Tab', 9, 8);
      return `shift+tab outdent in ${walker.current}`;
    case 'paste': {
      await placeCaret(walker, 'end');
      const payload = PAYLOADS[Math.floor(walker.next() * PAYLOADS.length)];
      await pasteFromClipboard(session.cdp, payload);
      await wait(200);
      return `paste ${payload.name} into ${walker.current}`;
    }
    case 'switch': {
      const target = walker.other;
      [walker.current, walker.other] = [walker.other, walker.current];
      await session.edit(contentOf(target));
      return `switch editing into ${target}`;
    }
    case 'escape':
      await session.cdp.key('Escape', 27);
      await wait(150);
      return 'escape out of editing';
    case 'backspace':
      await placeCaret(walker, 'end');
      await session.cdp.key('Backspace', 8);
      return `backspace at end in ${walker.current}`;
  }
}

/** Elements that differ between two snapshots, for isolation reporting. */
function changedKeys(a: Snapshot, b: Snapshot): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => a[key] !== b[key]).sort();
}

function report(walker: Walker, label: string, expected: Snapshot, observed: Snapshot): string {
  return [
    `${label}`,
    `walk so far:`,
    ...walker.trace.map((line) => `  ${line}`),
    `snapshot difference (expected vs observed):`,
    diffSnapshots(expected, observed),
  ].join('\n');
}

/**
 * The undo-restoration checkpoint: seal, snapshot, do exactly one operation,
 * seal, then prove Ctrl/Cmd+Z restores the pre-op slide and Ctrl/Cmd+Shift+Z
 * re-reaches the post-op slide — whole slide, every element.
 */
async function runCheckpoint(walker: Walker, step: number): Promise<void> {
  const { session, next } = walker;
  await session.seal();
  const before = await session.settle(`checkpoint at step ${step}: pre-op`);
  const action = CHECKPOINT_ACTIONS[Math.floor(next() * CHECKPOINT_ACTIONS.length)];
  const did = await performAction(walker, action, step);
  walker.trace.push(`CHECKPOINT op: ${did}`);
  await session.seal();
  const after = await session.settle(`checkpoint at step ${step}: post-op`);
  if (sameSnapshot(before, after)) {
    walker.trace.push('  (op was a persisted no-op; undo check skipped)');
    return;
  }
  const editedKeys = changedKeys(before, after);

  // Oracle 1: one undo restores the whole pre-op slide exactly.
  await session.undo();
  const undone = await snapshotEventually(session, before);
  if (!sameSnapshot(undone, before)) {
    // Oracle 4 first, for a sharper message: did the undo bleed into elements
    // the op never touched?
    const bled = changedKeys(before, undone).filter((key) => !editedKeys.includes(key));
    expect.fail(report(
      walker,
      bled.length > 0
        ? `undo of [${did}] changed untouched element(s) ${bled.join(', ')} (cross-element isolation)`
        : `one undo after [${did}] did not restore the pre-op slide`,
      before,
      undone,
    ));
  }

  // Oracle 2: redo re-reaches the undone state exactly.
  await session.redo();
  const redone = await snapshotEventually(session, after);
  if (!sameSnapshot(redone, after)) {
    expect.fail(report(
      walker,
      `redo after undoing [${did}] did not re-reach the post-op slide`,
      after,
      redone,
    ));
  }
}

async function runWalk(seed: number): Promise<void> {
  const { session, close } = await startUndoSession(`undo-restore-${seed}`, 'Undo Oracle');
  closeSession = close;
  const next = random(seed);
  const walker: Walker = { session, next, current: BOX_A, other: BOX_B, trace: [] };

  const origin = await session.settle('origin');
  expect(Object.keys(origin).filter((key) => key.includes(BOX_A) || key.includes(BOX_B)),
    'both boxes are committed in the starting deck').toHaveLength(2);

  for (let step = 0; step < STEPS; step++) {
    const action = WALK_ACTIONS[Math.floor(next() * WALK_ACTIONS.length)];
    const did = await performAction(walker, action, step);
    walker.trace.push(`step ${step + 1}: ${did}`);
    if (next() < 0.35) await runCheckpoint(walker, step);
  }

  // Oracle 3: unwind the whole walk. Leave editing first so the final run is
  // committed, then undo (bounded) until the deck is back at its origin.
  if (await session.editing(contentOf(walker.current))) {
    await session.cdp.key('Escape', 27);
  }
  await session.seal();
  await session.settle('end of walk');
  const bound = STEPS * 4 + 16;
  let reached = false;
  for (let press = 0; press < bound; press++) {
    await session.undo();
    const now = await session.settle(`unwind press ${press + 1}`);
    if (sameSnapshot(now, origin)) {
      reached = true;
      break;
    }
  }
  if (!reached) {
    const now = await session.snapshot();
    expect.fail(report(walker,
      `${bound} undos never returned the deck to its starting state`, origin, now));
  }

  // Beyond the origin, undo must be a no-op: nothing deleted, nothing changed.
  for (let press = 0; press < 3; press++) {
    await session.undo();
  }
  const past = await session.settle('after undoing past the origin');
  if (!sameSnapshot(past, origin)) {
    expect.fail(report(walker,
      'undo past the origin changed the deck (it must be a no-op)', origin, past));
  }
}

/* ------------------------------------------------------------------------ *
 * Directed repros minimised from the failing seeded walks.
 * ------------------------------------------------------------------------ */

/** Click into the list item whose text contains `text`, caret at its end. */
async function caretInText(session: UndoSession, selector: string, text: string): Promise<void> {
  const offset = await session.cdp.evaluate<number>(`(
    (document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').indexOf(${JSON.stringify(text)})
  )`);
  expect(offset, `the box shows ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
  await session.cdp.clickTextAtOffset(selector, offset, `the line holding ${text}`);
  await session.cdp.key('End', 35);
}

async function sealAndSettle(session: UndoSession, label: string): Promise<Snapshot> {
  await session.seal();
  return session.settle(label);
}

function expectRestored(expected: Snapshot, observed: Snapshot, label: string): void {
  if (sameSnapshot(observed, expected)) return;
  expect.fail(`${label}\n${diffSnapshots(expected, observed)}`);
}

describe.skipIf(!electronBinary)('minimised undo restoration bugs', () => {
  // Sanity control: the oracle itself passes on a trivially correct sequence.
  it('control: undo/redo of two sealed typing runs restores each state exactly', {
    timeout: 180_000,
  }, async () => {
    const { session, close } = await startUndoSession('undo-min-control', 'Undo Min');
    closeSession = close;
    await session.settle('origin');
    await session.edit(CONTENT_B);
    await caretInText(session, CONTENT_B, 'second paragraph');
    await session.cdp.typeKeys('AAA');
    const s1 = await sealAndSettle(session, 'after first run');
    await session.cdp.typeKeys('BBB');
    const s2 = await sealAndSettle(session, 'after second run');
    await session.undo();
    expectRestored(s1, await snapshotEventually(session, s1),
      'control: one undo did not restore the state before the second run');
    await session.redo();
    expectRestored(s2, await snapshotEventually(session, s2),
      'control: redo did not re-reach the second run');
  });

  // BUG: a Shift+Tab outdent of a list item never becomes its own undo entry.
  // The unbullet path (canvas.ts, Tab handler: `unbulletCaretItem(...,
  // 'outdent')` + `pushLive()`) streams the change as a *transient* commit and
  // returns without firing an input event, so no idle seal is ever scheduled
  // and the coalesce key never moves. The next sealed run (typing here, a
  // paste in seeded walk 20260901) commits under the same key and folds the
  // outdent into its entry — one Cmd/Ctrl+Z then takes back both.
  it('BUG: undo after typing also reverts a prior Shift+Tab outdent', {
    timeout: 180_000,
  }, async () => {
    const { session, close } = await startUndoSession('undo-min-outdent', 'Undo Min');
    closeSession = close;
    await session.settle('origin');
    await session.edit(CONTENT_A);
    await caretInText(session, CONTENT_A, 'beta item');
    await session.cdp.chord('Tab', 'Tab', 9, 8); // Shift+Tab: li -> p
    const outdented = await sealAndSettle(session, 'after the outdent');
    expect(outdented['0:undo-restore-list'], 'the outdent took beta out of the list')
      .toContain('<p>');
    await caretInText(session, CONTENT_A, 'beta item');
    await session.cdp.typeKeys('ZZZ');
    await sealAndSettle(session, 'after typing');
    await session.undo();
    expectRestored(outdented, await snapshotEventually(session, outdented),
      'one undo after typing must take back only the typing, not the outdent too');
  });

  // Guard: Tab indent goes through execCommand, which fires an input event
  // and so schedules a seal — it gets its own undo entry and does NOT show
  // the overshoot. This passing test pins the boundary of the bug above.
  it('guard: undo after typing does not revert a prior Tab indent', {
    timeout: 180_000,
  }, async () => {
    const { session, close } = await startUndoSession('undo-min-indent', 'Undo Min');
    closeSession = close;
    await session.settle('origin');
    await session.edit(CONTENT_A);
    await caretInText(session, CONTENT_A, 'beta item');
    await session.cdp.key('Tab', 9); // indent: beta becomes a nested item
    const indented = await sealAndSettle(session, 'after the indent');
    await caretInText(session, CONTENT_A, 'beta item');
    await session.cdp.typeKeys('ZZZ');
    await sealAndSettle(session, 'after typing');
    await session.undo();
    expectRestored(indented, await snapshotEventually(session, indented),
      'one undo after typing must take back only the typing, not the indent too');
  });

  // Guard: a *lone* outdent IS undoable, because pressing Cmd/Ctrl+Z while
  // editing first finishes the edit, and that finish commits the outdent as a
  // real entry. The bug above needs a sealed run after the outdent.
  it('guard: a lone Shift+Tab outdent can be undone', {
    timeout: 180_000,
  }, async () => {
    const { session, close } = await startUndoSession('undo-min-outdent-solo', 'Undo Min');
    closeSession = close;
    const origin = await session.settle('origin');
    await session.edit(CONTENT_A);
    await caretInText(session, CONTENT_A, 'beta item');
    await session.cdp.chord('Tab', 'Tab', 9, 8);
    const outdented = await sealAndSettle(session, 'after the outdent');
    expect(sameSnapshot(outdented, origin), 'the outdent changed the deck').toBe(false);
    await session.undo();
    expectRestored(origin, await snapshotEventually(session, origin),
      'one undo straight after an outdent must restore the original list');
  });

  // BUG: the simplest form of the overshoot — no lists at all. A formatting
  // change (`commitLiveTextDom`) deliberately leaves the coalesce key in
  // place so that leaving edit mode folds its re-commit into the same entry.
  // But the *next sealed typing run* also commits under that key before the
  // key is bumped, so the run coalesces into the formatting entry: one
  // Cmd/Ctrl+Z after the typing takes back the typing AND the bold.
  it('BUG: undo after typing also reverts the bold applied just before it', {
    timeout: 180_000,
  }, async () => {
    const { session, close } = await startUndoSession('undo-min-bold-type', 'Undo Min');
    closeSession = close;
    await session.settle('origin');
    await session.edit(CONTENT_B);
    await session.cdp.selectTextRange(CONTENT_B, 0, 5, 'the first word');
    await session.cdp.chord('b', 'KeyB', 66, MOD);
    await wait(150);
    const bolded = await sealAndSettle(session, 'after bold');
    expect(bolded['0:undo-restore-paragraphs']).toContain('font-weight');
    await caretInText(session, CONTENT_B, 'second paragraph');
    await session.cdp.typeKeys('ZZZ');
    await sealAndSettle(session, 'after typing');
    await session.undo();
    expectRestored(bolded, await snapshotEventually(session, bolded),
      'one undo after typing must take back only the typing, not the bold too');
  });

  // BUG: an inspector list-style change during a live text edit never becomes
  // its own undo entry either: undoing the following bold also flips the list
  // style back. While focus sits in the panel's <select>, `sealTextChunk`
  // bails on `document.activeElement !== body` *before* bumping the coalesce
  // key, so the toggle's html is streamed but no boundary is drawn between it
  // and the next formatting commit. Minimised from seeded walk 424242.
  it('BUG: undo after Cmd+B also reverts a prior list-style change', {
    timeout: 180_000,
  }, async () => {
    const { session, close } = await startUndoSession('undo-min-listtoggle', 'Undo Min');
    closeSession = close;
    await session.settle('origin');
    await session.edit(CONTENT_A);
    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    // One real type-ahead press at the inspector List dropdown: ul -> next
    // option starting with n (Numbered).
    const value = await session.cdp.pressOptionKey(
      '#inspector .text-list-style select', 'n', 'the List dropdown');
    await wait(150);
    expect(value, 'the press changed the list style').not.toBe('Bulleted');
    const toggled = await sealAndSettle(session, 'after the list toggle');
    await session.cdp.selectTextRange(CONTENT_A, 0, 5, 'the first word');
    await session.cdp.chord('b', 'KeyB', 66, MOD);
    await wait(150);
    const bolded = await sealAndSettle(session, 'after bold');
    expect(bolded['0:undo-restore-list']).toContain('font-weight');
    await session.undo();
    expectRestored(toggled, await snapshotEventually(session, toggled),
      'one undo after bold must take back only the bold, not the list style too');
  });
});

describe.skipIf(!electronBinary)('undo and redo restore the exact slide state', () => {
  for (const seed of SEEDS) {
    it(`seeded walk ${seed} survives the restoration oracles`, {
      timeout: 420_000,
    }, async () => {
      await runWalk(seed);
    });
  }
});

describe.skipIf(electronBinary)('undo and redo restore the exact slide state (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
