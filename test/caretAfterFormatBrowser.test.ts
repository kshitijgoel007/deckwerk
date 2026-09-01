import { afterAll, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import {
  BOX_A,
  BOX_B,
  CONTENT_A,
  CONTENT_B,
  MOD,
  startUndoSession,
  type UndoSession,
} from './support/undoRestorationSession.js';

/**
 * The caret must stay put across a collapsed-caret format toggle.
 *
 * Reported: in a bulleted list, type "Test", press Cmd+B, type "test", press
 * Cmd+B again — and the caret jumps to the NEXT bullet. Sealing the pending
 * typing-style marker restored the caret through flat text offsets, and a
 * caret at the end of a list item sits exactly on the offset boundary where
 * a forward-affinity restore walks into the next item's first text node.
 *
 * Every keystroke here is real hardware-path input. The oracle is exact: the
 * block (list item / paragraph) that holds the caret, and the caret's visible
 * character offset inside it, read straight from the live selection.
 */

const FORMATS = [
  ['b', 66, 'bold'],
  ['i', 73, 'italic'],
  ['u', 85, 'underline'],
] as const;

interface CaretPosition {
  /** Index of the top-level block (li or p) holding the caret, or -1. */
  block: number;
  /** Visible character offset of the caret inside that block. */
  offset: number;
  /** The block's visible text, for failure messages. */
  text: string;
}

let closeSession: (() => Promise<void>) | null = null;

describe.skipIf(!electronBinary)('caret position across format toggles', () => {
  let session: UndoSession;

  afterAll(async () => {
    await closeSession?.();
  });

  async function start(): Promise<void> {
    if (session) return;
    const started = await startUndoSession('caret-after-format', 'Caret');
    session = started.session;
    closeSession = started.close;
  }

  function caretPosition(content: string): Promise<CaretPosition> {
    return session.cdp.evaluate<CaretPosition>(`(() => {
      const body = document.querySelector('${content}');
      const selection = window.getSelection();
      if (!body || !selection || selection.rangeCount === 0) {
        return { block: -1, offset: -1, text: '(no selection)' };
      }
      const range = selection.getRangeAt(0);
      const anchor = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      if (!anchor || !body.contains(anchor)) {
        return { block: -1, offset: -1, text: '(outside the box)' };
      }
      const blocks = [...body.querySelectorAll('li, p')]
        .filter((node) => !node.querySelector('li, p'));
      const block = blocks.find((candidate) => candidate.contains(anchor)) ?? null;
      const visible = (value) => value.replace(/[\\u2060]/g, '');
      if (!block) return { block: -1, offset: -1, text: visible(body.textContent ?? '') };
      const prefix = document.createRange();
      prefix.selectNodeContents(block);
      prefix.setEnd(range.startContainer, range.startOffset);
      return {
        block: blocks.indexOf(block),
        offset: visible(prefix.toString()).length,
        text: visible(block.textContent ?? ''),
      };
    })()`);
  }

  async function caretToEndOfBlock(content: string, blockIndex: number): Promise<void> {
    // A real click near the block's right end, then End to pin the caret at
    // the end of its line the way an author would.
    await session.cdp.evaluate(`(() => {
      const body = document.querySelector('${content}');
      const blocks = [...body.querySelectorAll('li, p')]
        .filter((node) => !node.querySelector('li, p'));
      blocks[${blockIndex}]?.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    const box = await session.cdp.evaluate<{ x: number; y: number } | null>(`(() => {
      const body = document.querySelector('${content}');
      const blocks = [...body.querySelectorAll('li, p')]
        .filter((node) => !node.querySelector('li, p'));
      const rect = blocks[${blockIndex}]?.getBoundingClientRect();
      return rect ? { x: rect.right - 4, y: rect.top + rect.height / 2 } : null;
    })()`);
    expect(box, `block ${blockIndex} exists in ${content}`).not.toBeNull();
    await session.cdp.clickAt(box!.x, box!.y);
    await session.cdp.key('End', 35);
    await wait(80);
  }

  it('keeps the caret in its bullet across type, Cmd+B, type, Cmd+B', {
    timeout: 120_000,
  }, async () => {
    await start();
    await session.edit(CONTENT_A);
    await caretToEndOfBlock(CONTENT_A, 0);
    const before = await caretPosition(CONTENT_A);
    expect(before.block, `caret starts in the first bullet: ${JSON.stringify(before)}`).toBe(0);

    await session.cdp.typeKeys('Test');
    await session.cdp.chord('b', 'KeyB', 66, MOD);
    await session.cdp.typeKeys('test');
    await session.cdp.chord('b', 'KeyB', 66, MOD);
    const after = await caretPosition(CONTENT_A);
    // BUG (reported): the second Cmd+B seals the pending style run and the
    // flat-offset caret restore walks into the NEXT bullet.
    expect(after.block, `caret jumped out of its bullet: ${JSON.stringify(after)}`).toBe(0);
    expect(after.offset, `caret moved within its bullet: ${JSON.stringify(after)}`)
      .toBe(before.offset + 'Testtest'.length);

    // Typing continues exactly where the author left off, in the same bullet.
    await session.cdp.typeKeys('X');
    const typed = await caretPosition(CONTENT_A);
    expect(typed.block).toBe(0);
    expect(typed.text, 'the next keystroke landed away from the caret')
      .toContain('TesttestX');
  });

  it('keeps the caret still across every format toggle, everywhere', {
    timeout: 240_000,
  }, async () => {
    await start();
    for (const [content, blocks] of [[CONTENT_A, 3], [CONTENT_B, 2]] as const) {
      for (const [key, code, name] of FORMATS) {
        for (let block = 0; block < blocks; block += 1) {
          await session.edit(content);
          await caretToEndOfBlock(content, block);
          await session.cdp.typeKeys('qq');
          const before = await caretPosition(content);
          await session.cdp.chord(key, `Key${key.toUpperCase()}`, code, MOD);
          await session.cdp.typeKeys('ww');
          await session.cdp.chord(key, `Key${key.toUpperCase()}`, code, MOD);
          const after = await caretPosition(content);
          const label = `${name} in ${content === CONTENT_A ? BOX_A : BOX_B} block ${block}`;
          expect(after.block, `${label}: caret left its block: ${JSON.stringify(after)}`)
            .toBe(before.block);
          expect(after.offset, `${label}: caret drifted: ${JSON.stringify(after)}`)
            .toBe(before.offset + 2);
          await session.cdp.key('Escape', 27);
          await wait(150);
        }
      }
    }
  });

  it('holds the caret through a seeded fuzz of typing and format toggles', {
    timeout: 240_000,
  }, async () => {
    await start();
    const seeds = [11, 4242, 20260901];
    for (const seed of seeds) {
      let state = seed % 2147483647;
      const next = () => {
        state = (state * 16807) % 2147483647;
        return (state - 1) / 2147483646;
      };
      await session.edit(CONTENT_A);
      await caretToEndOfBlock(CONTENT_A, Math.floor(next() * 3));

      let position = await caretPosition(CONTENT_A);
      for (let step = 0; step < 24; step += 1) {
        const roll = next();
        if (roll < 0.4) {
          const word = `w${Math.floor(next() * 1e6).toString(36)}`;
          await session.cdp.typeKeys(word);
          const after = await caretPosition(CONTENT_A);
          expect(after.block, `seed ${seed} step ${step}: typing left block `
            + `${position.block}: ${JSON.stringify(after)}`).toBe(position.block);
          expect(after.offset, `seed ${seed} step ${step}: typed text landed away `
            + `from the caret: ${JSON.stringify(after)}`).toBe(position.offset + word.length);
          position = after;
        } else if (roll < 0.85) {
          const [key, code, name] = FORMATS[Math.floor(next() * FORMATS.length)];
          await session.cdp.chord(key, `Key${key.toUpperCase()}`, code, MOD);
          const after = await caretPosition(CONTENT_A);
          // A format toggle must never move the caret at all.
          expect(after.block, `seed ${seed} step ${step}: Cmd+${name} moved the caret `
            + `to another block: ${JSON.stringify(after)} from ${JSON.stringify(position)}`)
            .toBe(position.block);
          expect(after.offset, `seed ${seed} step ${step}: Cmd+${name} drifted the caret: `
            + `${JSON.stringify(after)} from ${JSON.stringify(position)}`).toBe(position.offset);
        } else {
          // A real arrow move re-baselines the expectation.
          const left = next() < 0.5;
          await session.cdp.key(left ? 'ArrowLeft' : 'ArrowRight', left ? 37 : 39);
          await wait(40);
          position = await caretPosition(CONTENT_A);
        }
      }
      await session.cdp.key('Escape', 27);
      await wait(200);
    }
  });
});

describe.skipIf(electronBinary)('caret position across format toggles (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
