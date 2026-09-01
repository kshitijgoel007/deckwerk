import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import { MOD, TEXT_A, TEXT_B } from './support/selectionSession.js';
import { startImeSession, type ImeSession } from './support/imeSession.js';

/**
 * IME composition against the text-editing machinery.
 *
 * Every text-editing path in this editor was built and tested against per-key
 * ASCII input. A composing IME (Chinese pinyin, Japanese, dead keys, macOS
 * press-and-hold) delivers text differently: an uncommitted preedit lives in
 * the DOM while compositionstart/update/end and `insertCompositionText`
 * beforeinput/input events fire around it. These tests drive that path with
 * the DevTools protocol's own IME surface (`Input.imeSetComposition` +
 * `Input.insertText`), which exercises the same InputMethodController a
 * native IME uses.
 *
 * The first test validates the driver itself against the documented native
 * event sequence before anything else is trusted.
 */
const DECK_ID = 'ime-composition';

let session: ImeSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startImeSession(DECK_ID, 'IME Composition');
  session = started.session;
  close = started.close;
  await session.installProbe();
}, 120_000);

afterAll(async () => {
  await close?.();
  close = null;
});

describe.skipIf(!electronBinary)('IME composition', () => {
  it('driver validation: CDP IME produces the native composition event sequence', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.editAtEnd(TEXT_A);
    await session.clearProbe();

    await session.compose(['n', 'ni', 'nih', 'niha', 'nihao'], '你好');

    const log = await session.probeLog();
    const types = log.map((event) => event.type);

    // The composition lifecycle, in order, exactly once.
    expect(types.filter((t) => t === 'compositionstart'), JSON.stringify(log)).toHaveLength(1);
    expect(types.filter((t) => t === 'compositionend'), JSON.stringify(log)).toHaveLength(1);
    expect(types.indexOf('compositionstart')).toBeLessThan(types.indexOf('compositionupdate'));
    expect(types.lastIndexOf('compositionupdate')).toBeLessThan(types.indexOf('compositionend'));
    expect(types.filter((t) => t === 'compositionupdate').length).toBeGreaterThanOrEqual(5);

    // Every beforeinput/input during the composition is insertCompositionText.
    const inputs = log.filter((e) => e.type === 'beforeinput' || e.type === 'input');
    expect(inputs.length).toBeGreaterThan(0);
    for (const event of inputs) {
      expect(event.inputType, JSON.stringify(log)).toBe('insertCompositionText');
    }
    // The commit is delivered through the composition, not as a plain
    // insertText, and it carries the committed string.
    const commit = inputs[inputs.length - 1];
    expect(commit.data).toBe('你好');

    // And the preedit really was live in the page: the last update before the
    // commit shows the full pinyin string.
    const updates = log.filter((e) => e.type === 'compositionupdate');
    expect(updates.some((e) => e.data === 'nihao')).toBe(true);

    expect(await session.pageErrors()).toEqual([]);
  });

  it('compose-commit basic: one clean 你好 lands in the committed markup', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.editAtEnd(TEXT_A);
    await session.compose(['n', 'ni', 'nihao'], '你好');
    await session.key('Escape', 27);
    await session.clickEmpty();

    const html = await session.committedHtml(TEXT_A);
    expect(countOf(html, '你好'), html).toBe(1);
    expect(countOf(html, 'nihao'), html).toBe(0);
    expect(await session.committedDebris(TEXT_A)).toEqual([]);
    expect(await session.textOf(TEXT_A)).toContain('你好');
    expect(await session.pageErrors()).toEqual([]);
    expect(await session.problems()).toEqual([]);
  });

  it('undo granularity: one undo removes exactly the composed run', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.editAtEnd(TEXT_A);
    // A word of ordinary typing, sealed by the idle timer.
    await session.type(' hello');
    await wait(750);
    // Then a composed word, also sealed.
    await session.compose(['n', 'ni', 'nihao'], '你好');
    await wait(750);

    await session.chord('z', 'KeyZ', 90, MOD);
    await wait(200);

    const text = await session.textOf(TEXT_A);
    expect(text, 'one undo must remove only the composed text').toContain('hello');
    expect(text, 'one undo must remove only the composed text').not.toContain('你好');
    // The DOM and the store agree after the undo.
    const html = await session.committedHtml(TEXT_A);
    expect(countOf(html, '你好'), html).toBe(0);
    expect(countOf(html, 'hello'), html).toBe(1);
    expect(await session.pageErrors()).toEqual([]);
    expect(await session.problems()).toEqual([]);
  });

  it('blur mid-composition: clicking another box leaves no orphan preedit', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.editAtEnd(TEXT_A);
    await session.setComposition('nihao');
    // Uncommitted preedit is on screen. Click straight into the other box.
    await session.click(TEXT_B);
    await wait(200);

    expect(await session.pageErrors()).toEqual([]);
    const html = await session.committedHtml(TEXT_A);
    // Commit-or-discard, but never duplicated and never half-committed.
    expect(countOf(html, 'nihao'), html).toBeLessThanOrEqual(1);
    expect(await session.committedDebris(TEXT_A)).toEqual([]);
    expect(await session.problems()).toEqual([]);

    // Typing still works afterwards.
    await session.editAtEnd(TEXT_B);
    await session.type('ok');
    await wait(750);
    expect(await session.textOf(TEXT_B)).toContain('ok');
    await session.key('Escape', 27);
    await session.clickEmpty();
    expect(await session.problems()).toEqual([]);
  });

  it('blur mid-composition: clicking empty canvas leaves no orphan preedit', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.editAtEnd(TEXT_A);
    await session.setComposition('nihao');
    await session.clickEmpty();
    await wait(200);

    expect(await session.pageErrors()).toEqual([]);
    const html = await session.committedHtml(TEXT_A);
    expect(countOf(html, 'nihao'), html).toBeLessThanOrEqual(1);
    expect(await session.committedDebris(TEXT_A)).toEqual([]);
    expect(await session.problems()).toEqual([]);

    await session.editAtEnd(TEXT_A);
    await session.type('ok');
    await wait(750);
    expect(await session.textOf(TEXT_A)).toContain('ok');
    await session.key('Escape', 27);
    await session.clickEmpty();
    expect(await session.problems()).toEqual([]);
  });

  it('control: plainly typed text after a collapsed-caret Cmd+B is bold', {
    timeout: 120_000,
  }, async () => {
    // Soundness control for the composition case below: the same gesture with
    // per-key ASCII input must produce bold text, proving the fixture and the
    // bold detector work. Only then does the composed variant failing mean
    // composition itself loses the pending style.
    await session.reset();
    await session.editAtEnd(TEXT_A);
    await session.chord('b', 'KeyB', 66, MOD);
    await session.type('bd');
    await session.key('Escape', 27);
    await session.clickEmpty();

    const html = await session.committedHtml(TEXT_A);
    expect(countOf(html, 'bd'), html).toBe(1);
    expect(await session.committedDebris(TEXT_A)).toEqual([]);
    expect(await isBoldIn(html, 'bd'), `typed control must be bold: ${html}`).toBe(true);
    expect(await session.problems()).toEqual([]);
  });

  // BUG: a pending collapsed-caret style (Cmd+B with nothing selected) is
  // dropped by IME composition. The beforeinput hook that steers typed text
  // into the [data-editor-typing-style] marker span skips composition events
  // (`event.isComposing` early return), Chromium inserts the composed text
  // beside the empty marker, and authoredTextHtml then discards the empty
  // marker — so 你好 lands committed as plain text while the same gesture with
  // ASCII keystrokes (control above) is bold. Reproduced 3/3 runs.
  it('composition after Cmd+B: the composed text is bold, markers cleaned up', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.editAtEnd(TEXT_A);
    // A collapsed-caret bold toggle: the editor parks a pending-style marker
    // span with an invisible sentinel at the caret.
    await session.chord('b', 'KeyB', 66, MOD);
    await session.compose(['n', 'ni', 'nihao'], '你好');
    await session.key('Escape', 27);
    await session.clickEmpty();

    const html = await session.committedHtml(TEXT_A);
    expect(countOf(html, '你好'), html).toBe(1);
    expect(await session.committedDebris(TEXT_A)).toEqual([]);
    expect(
      await isBoldIn(html, '你好'),
      `composed text must inherit the pending bold style: ${html}`,
    ).toBe(true);
    expect(await session.pageErrors()).toEqual([]);
    expect(await session.problems()).toEqual([]);
  });

  // BUG: the 600ms idle-seal timer fires while an IME preedit is still
  // uncommitted and commits the raw preedit text into history. Composition
  // updates fire `input` (insertCompositionText), which schedules the idle
  // seal; sealTextChunk has no isComposing guard, so pausing over the
  // candidate window (ordinary IME use) seals "…ni" as its own undo step.
  // The final text is clean, but one Cmd+Z after committing 你好 resurrects
  // "alpha twoni" — an on-screen state that never existed as authored text.
  // Reproduced 3/3 runs.
  it('idle seal mid-composition: the 600ms seal must not capture or corrupt the preedit', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.editAtEnd(TEXT_A);
    await session.setComposition('ni');
    // Let the idle-seal window elapse while the preedit is still uncommitted.
    await wait(900);
    await session.setComposition('niha');
    await session.commitText('你好');
    await wait(750);

    // The final text is clean...
    const text = await session.textOf(TEXT_A);
    expect(countOf(text, '你好'), text).toBe(1);
    expect(text, 'raw preedit must not survive in the text').not.toContain('ni');
    expect(await session.pageErrors()).toEqual([]);

    // ...and no history step holds the raw preedit: one undo steps back to
    // the pre-composition text, never to "…ni".
    await session.chord('z', 'KeyZ', 90, MOD);
    await wait(200);
    const undone = await session.textOf(TEXT_A);
    expect(undone, 'undo must not resurrect the uncommitted preedit').not.toContain('ni');
    expect(undone, 'undo must remove the composed run').not.toContain('你好');
    expect(await session.problems()).toEqual([]);
  });

  it('slide switch mid-composition: no crash, no duplication, invariants hold', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.editAtEnd(TEXT_A);
    await session.type('pre');
    await wait(750);
    await session.setComposition('nihao');
    // Preedit is live; click the slide rail.
    await session.clickRail(1);
    await wait(200);

    expect(await session.pageErrors()).toEqual([]);
    expect(await session.problems()).toEqual([]);

    await session.clickRail(0);
    await wait(200);
    const html = await session.committedHtml(TEXT_A);
    // Known bug class: an unsealed run can be lost on slide switch. Losing
    // the preedit is same-class; duplicating it or leaving debris is worse.
    expect(countOf(html, 'nihao'), html).toBeLessThanOrEqual(1);
    expect(countOf(html, 'pre'), `typed text before the preedit: ${html}`).toBe(1);
    expect(await session.committedDebris(TEXT_A)).toEqual([]);

    // The editor still takes ordinary typing afterwards.
    await session.editAtEnd(TEXT_A);
    await session.type('ok');
    await wait(750);
    expect(await session.textOf(TEXT_A)).toContain('ok');
    await session.key('Escape', 27);
    await session.clickEmpty();
    expect(await session.problems()).toEqual([]);
  });
});

function countOf(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** Whether `needle`'s text node sits under a bold ancestor in `html`. */
function isBoldIn(html: string, needle: string): Promise<boolean> {
  return session.cdp.evaluate<boolean>(`(() => {
    const template = document.createElement('template');
    template.innerHTML = ${JSON.stringify(html)};
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.includes(${JSON.stringify(needle)})) continue;
      for (let up = node.parentElement; up; up = up.parentElement) {
        if (up.tagName === 'B' || up.tagName === 'STRONG') return true;
        const weight = up.style ? up.style.fontWeight : '';
        if (weight === 'bold' || Number(weight) >= 600) return true;
      }
      return false;
    }
    return false;
  })()`);
}
