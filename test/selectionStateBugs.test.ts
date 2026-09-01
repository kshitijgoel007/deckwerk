import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import {
  MOD,
  TEXT_A,
  TEXT_B,
  elementSelector,
  startSelectionSession,
  type SelectionSession,
} from './support/selectionSession.js';

/**
 * Bug hunt: selection state vs. the live text edit, driven by real input.
 *
 * The reported fault class is "one textbox can be selected while I'm typing
 * in another": the store's object selection, the canvas's edit session, the
 * DOM's contenteditable/focus, and the overlay chrome disagree about which
 * single element the author is working in.
 *
 * Every case here reuses the production fixture and the whole-editor
 * invariant checker from test/support/selectionSession.ts, and adds the
 * specific observable an author would notice (where the keystrokes landed).
 *
 * Cases marked with a `// BUG:` comment FAIL on current code — they are
 * reproductions, not regressions of this test.
 */
const DECK_ID = 'selection-state-bugs';

let session: SelectionSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startSelectionSession(DECK_ID, 'Selection State Bugs');
  session = started.session;
  close = started.close;
}, 180_000);

afterAll(async () => {
  await close?.();
  close = null;
});

/** Viewport-space box of the first node matching a selector. */
async function boxOf(selector: string): Promise<{
  left: number; top: number; width: number; height: number;
}> {
  const box = await session.cdp.evaluate<{
    left: number; top: number; width: number; height: number;
  } | null>(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`);
  if (!box) throw new Error(`no element matches ${selector}`);
  return box;
}

/** A real primary-button drag along a path of viewport points. */
async function dragPath(
  points: Array<{ x: number; y: number }>,
  betweenPoints?: () => Promise<void>,
): Promise<void> {
  const cdp = session.cdp;
  const start = points[0];
  const end = points[points.length - 1];
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0,
  });
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1,
  });
  for (const point of points.slice(1)) {
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1,
    });
    await wait(30);
    await betweenPoints?.();
  }
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1,
  });
}

/** The html the store holds for an element on the current slide. */
async function storedHtml(elementId: string): Promise<string> {
  return session.cdp.evaluate<string>(`(() => {
    const state = window.store.get();
    const slide = state.deck.slides[state.slideIndex];
    const el = slide?.elements.find((e) => e.id === ${JSON.stringify(elementId)});
    return el ? el.html : '(missing)';
  })()`);
}

describe.skipIf(!electronBinary)('selection state during a live text edit', () => {
  // PASSES on current code: right-clicking B while editing A stays consistent.
  it('does not leave B selected while keystrokes still go to A after a right-click', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    await session.type('hi');
    expect((await session.state()).editing, 'the edit session is on A').toBe(TEXT_A);

    // A real right-click on B, the gesture that opens its context menu.
    await session.cdp.rightClick(elementSelector(TEXT_B), 'right-click text B');
    await wait(150);

    const state = await session.state();
    const problems = await session.problems();

    // Where do keystrokes actually go now? Type and look.
    await session.type('QQ');
    await wait(150);
    const aText = await session.textOf(TEXT_A);
    const bText = await session.textOf(TEXT_B);

    // Close the context menu with a real click so later cases are unobstructed.
    await session.cdp.evaluate('document.getElementById("ctx-menu") ? "menu open" : "no menu"');
    await session.clickEmpty();

    const seen = `editing=${state.editing} selection=[${state.selection.join(', ')}]`
      + ` focus=${state.focus}; after typing QQ: A="${aText}" B="${bText}"`;
    expect(
      problems,
      `right-click on B during A's edit must not desynchronise selection (${seen})`,
    ).toEqual([]);
    // Keystrokes must land in the box the UI marks as being edited/selected.
    if (state.selection.join() === TEXT_B) {
      expect(aText, `B is shown selected, so typing must not reach A (${seen})`)
        .not.toContain('QQ');
    }
  });

  it('re-enters the edit through the context menu without doubling keystrokes', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    // Arm a pending collapsed-caret style, then re-enter the same box through
    // the context menu's "Edit text" — the re-entry route commit 3ccce4a did
    // not touch. A stacked listener set would insert every character twice.
    await session.chord('b', 'KeyB', 66, MOD);
    await session.cdp.rightClick(elementSelector(TEXT_A), 'right-click edited A');
    await wait(150);
    await session.cdp.clickByText('#ctx-menu button', 'Edit text', 'context menu Edit text');
    await wait(200);

    const state = await session.state();
    const problems = await session.problems();
    await session.type('not');
    await wait(300);
    await session.key('Escape', 27);
    await wait(150);

    const text = await session.textOf(TEXT_A);
    expect(
      problems,
      `after context-menu re-entry (editing=${state.editing}, selection=`
      + `[${state.selection.join(', ')}])`,
    ).toEqual([]);
    expect(text, 'the typed word landed').toContain('not');
    expect(text, 'no keystroke doubled ("nnoott")').not.toContain('nnoott');
    expect(await session.problems(), 'after leaving the re-entered edit').toEqual([]);
  });

  // BUG: a single click on an already-selected text box begins an edit session
  // (canvas.ts onPointerDown sets pendingTextEdit whenever the hit is already
  // selected) without narrowing the selection — the editor then shows BOTH
  // boxes selected, draws two selection outlines, and keeps an open edit
  // session on one of them. This is the reported "one textbox can be selected
  // while I'm typing in another" state, reached with a plain left click.
  it('narrows a multi-selection when a single click re-enters the selected box', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.click(TEXT_A);
    await session.shiftClick(TEXT_B);
    // A single (not double) click on a selected text box is the editor's
    // "click into selected text" affordance.
    await session.click(TEXT_A);
    await wait(150);

    const state = await session.state();
    const problems = await session.problems();
    // Show where keystrokes go while the UI claims two boxes are selected.
    await session.type('TT');
    await wait(150);
    const aText = await session.textOf(TEXT_A);
    const bText = await session.textOf(TEXT_B);
    await session.key('Escape', 27);

    if (state.editing !== null) {
      expect(state.editing, 'the click edits the clicked box').toBe(TEXT_A);
      expect(
        problems,
        `single-click edit entry left editing=${state.editing} with selection=`
        + `[${state.selection.join(', ')}], outlines=${state.outlines}; typing`
        + ` then landed in A="${aText}" while B="${bText}" stayed selected`,
      ).toEqual([]);
      expect(state.selection, 'only the edited box stays selected').toEqual([TEXT_A]);
    }
  });

  it('keeps a pending Cmd+B in A out of the next box typed into', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    // Collapsed caret: Cmd+B arms a pending typing style in A.
    await session.chord('b', 'KeyB', 66, MOD);
    // Leave A for B without typing into the pending run.
    await session.click(TEXT_B);
    await session.doubleClick(TEXT_B);
    await session.type('xy');
    await wait(300);
    await session.key('Escape', 27);
    await wait(150);

    const problems = await session.problems();
    const aHtml = await storedHtml(TEXT_A);
    const bHtml = await storedHtml(TEXT_B);
    expect(problems, 'the editor stays consistent across the pending-style handoff')
      .toEqual([]);
    expect(aHtml, 'no editor-only typing marker leaks into A\'s saved html')
      .not.toContain('data-editor-typing-style');
    expect(aHtml, 'no invisible sentinel character leaks into A\'s saved html')
      .not.toContain('⁠');
    expect(bHtml, 'the characters typed in B are there').toContain('xy');
    expect(
      /<[^>]*(font-weight|<b\b|<strong)[^>]*>[^<]*xy/i.test(bHtml),
      `the pending bold from A must not style B's text: ${bHtml}`,
    ).toBe(false);
  });

  it('survives Escape pressed in the middle of a marquee drag', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    const layer = await boxOf('.slide-layer');
    // Start in the empty lower band and sweep up across the shape and text B.
    const startX = layer.left + layer.width * 0.7;
    const startY = layer.top + layer.height * 0.93;
    const bBox = await boxOf(elementSelector(TEXT_B));
    let escaped = false;
    await dragPath([
      { x: startX, y: startY },
      { x: startX, y: layer.top + layer.height * 0.55 },
      { x: bBox.left + bBox.width / 2, y: bBox.top + bBox.height / 2 },
    ], async () => {
      if (escaped) return;
      escaped = true;
      await session.cdp.key('Escape', 27);
    });
    await wait(150);

    const state = await session.state();
    const problems = await session.problems();
    const marqueeLeft = await session.cdp.evaluate<number>(
      'document.querySelectorAll(".overlay-layer .marquee").length');
    expect(problems, `after Escape mid-marquee (selection=[${state.selection.join(', ')}])`)
      .toEqual([]);
    expect(marqueeLeft, 'no marquee rectangle survives the drag').toBe(0);

    // The next keyboard gestures act on whatever is selected; they must not
    // resurrect a stale selection or dangling edit session.
    await session.key('ArrowRight', 39);
    await session.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    expect(await session.problems(), 'after Cmd+A following the interrupted drag')
      .toEqual([]);
  });

  it('does not sweep a native text highlight while a marquee ends an edit', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    await session.type('z');
    const layer = await boxOf('.slide-layer');
    const bText = await boxOf(`${elementSelector(TEXT_B)} .text-content`);
    // Start the drag on empty canvas while A's edit is still live, then sweep
    // through B's glyphs. The pointer-down both ends the edit and starts a
    // marquee; the browser's own selection must not ride along.
    await dragPath([
      { x: layer.left + layer.width * 0.7, y: layer.top + layer.height * 0.93 },
      { x: bText.left + bText.width * 0.8, y: bText.top + bText.height * 0.7 },
      { x: bText.left + bText.width * 0.2, y: bText.top + bText.height * 0.3 },
    ]);
    await wait(150);

    const state = await session.state();
    const problems = await session.problems();
    const native = await session.cdp.evaluate<string>(`(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return 'collapsed';
      const anchor = sel.anchorNode;
      const owner = (anchor instanceof Element ? anchor : anchor?.parentElement)
        ?.closest('[data-element-id]')?.getAttribute('data-element-id');
      return 'expanded in ' + (owner ?? 'unknown') + ': ' + JSON.stringify(sel.toString());
    })()`);
    expect(
      problems,
      `marquee out of an edit (native selection: ${native}, editing=${state.editing})`,
    ).toEqual([]);
    expect(state.editing, 'the marquee ended the edit').toBeNull();
  });

  it('inserts characters exactly once after Escape and an immediate re-entry', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    await session.type('m');
    // Escape and dive straight back in, no settling pause: the double-click
    // must replace the session, not stack a second listener set on it.
    await session.cdp.key('Escape', 27);
    await session.cdp.doubleClick(elementSelector(TEXT_A), 'text A again');
    await wait(120);
    await session.type('once');
    await wait(300);
    await session.key('Escape', 27);
    await wait(150);

    const text = await session.textOf(TEXT_A);
    const problems = await session.problems();
    expect(problems, 'after the rapid Escape/double-click round trip').toEqual([]);
    expect(text, 'the typed word landed').toContain('once');
    expect(text, 'no keystroke doubled ("oonnccee")').not.toMatch(/oonn|cc(?:ee)/);
    const occurrences = text.split('once').length - 1;
    expect(occurrences, `"once" appears exactly once in "${text}"`).toBe(1);
  });

  it('keeps keystrokes in the box the UI shows after rapid A-B-A clicks', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    // No settling waits between clicks: the third and fourth land inside the
    // native double-click interval, racing selection against edit entry.
    await session.cdp.click(elementSelector(TEXT_A), 'A');
    await session.cdp.click(elementSelector(TEXT_B), 'B');
    await session.cdp.click(elementSelector(TEXT_A), 'A');
    await session.cdp.click(elementSelector(TEXT_A), 'A');
    await wait(250);

    const state = await session.state();
    const problems = await session.problems();
    await session.type('RR');
    await wait(200);
    const aText = await session.textOf(TEXT_A);
    const bText = await session.textOf(TEXT_B);
    await session.key('Escape', 27);

    expect(
      problems,
      `after rapid A,B,A,A clicks (editing=${state.editing}, selection=`
      + `[${state.selection.join(', ')}], A="${aText}", B="${bText}")`,
    ).toEqual([]);
    expect(bText, 'nothing typed reaches B').not.toContain('RR');
    if (state.editing === TEXT_A) {
      expect(aText, 'the keystrokes landed in A exactly once').toContain('RR');
      expect(aText, 'and were not doubled').not.toContain('RRRR');
    }
  });
});
