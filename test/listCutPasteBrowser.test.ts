import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import {
  CONTENT,
  MOD,
  startListEditingSession,
  TEXT_ID,
  type ListEditingSession,
} from './support/listEditingSession.js';
import { SEAL_MS } from './support/pasteMarkupCorpus.js';

/**
 * Cutting a bullet and pasting it above another, and the spacing of indented
 * bullets, in the production editor with the real clipboard.
 *
 * One slide of a real talk showed what goes wrong here: the pasted run
 * carried the source item's hanging indent as inline style, the item it
 * landed near kept literal newlines that painted as blank lines, and the
 * deck's paragraph spacing pushed indented bullets apart as if each were a
 * paragraph. The jsdom suites pin the repair of the markup; this file checks
 * the outcome an author sees, and measures the spacing the stylesheet gives.
 */
const DECK_ID = 'list-cut-paste';

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession(DECK_ID, 'List cut and paste');
  session = started.session;
  close = started.close;
}, 120_000);

afterAll(async () => {
  await close?.();
  close = null;
});

const cut = () => session.cdp.chord('x', 'KeyX', 88, MOD, ['cut']);
const paste = () => session.cdp.chord('v', 'KeyV', 86, MOD, ['paste']);
const shiftEnd = () => session.cdp.chord('End', 'End', 35, 8);
const shiftDown = () => session.cdp.chord('ArrowDown', 'ArrowDown', 40, 8);

/** Inline style declarations anywhere in the box, for "nothing leaked" checks. */
async function inlineStyles(): Promise<string[]> {
  return session.cdp.evaluate<string[]>(`(() => {
    const root = document.querySelector('${CONTENT}');
    return root ? [...root.querySelectorAll('[style]')].map((node) => node.getAttribute('style')) : [];
  })()`);
}

async function expectSound(label: string): Promise<void> {
  expect(await session.problems(), `${label}: live markup`).toEqual([]);
  await wait(SEAL_MS);
  await eventually(async () => session.persistedProblems(), `${label}: stored markup never settled`,
    (problems) => problems.length === 0, 15_000);
}

describe.skipIf(!electronBinary)('cutting a bullet and pasting it above another', () => {
  it('moves a whole bullet, selected with its line break, above another bullet', async () => {
    await session.reset('<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>');
    await session.edit();
    await session.caretIn('beta', 'start');
    await shiftDown();
    await cut();
    await eventually(async () => session.outline(), 'the cut did not remove the bullet',
      (lines) => lines.join('|') === 'ul|- alpha|- gamma');
    await session.caretIn('alpha', 'start');
    await paste();
    await eventually(async () => session.outline(), 'the pasted bullet did not land above alpha',
      (lines) => lines.join('|') === 'ul|- beta|- alpha|- gamma');
    await expectSound('a bullet moved above another');
    await session.expectPersisted(
      (lines) => lines.join('|') === 'ul|- beta|- alpha|- gamma', 'the moved bullet is stored');
  }, 60_000);

  it('pastes the words of a cut bullet into another without the source item\'s layout', async () => {
    await session.reset('<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>');
    await session.edit();
    await session.caretIn('beta', 'start');
    await shiftEnd();
    await cut();
    await eventually(async () => session.outline(), 'the cut did not empty the bullet',
      (lines) => lines.join('|') === 'ul|- alpha|- |- gamma');
    await session.caretIn('gamma', 'start');
    await paste();
    // Chromium copies a fully selected item as an item, so the words come
    // back as a bullet of their own above gamma; the emptied bullet stays.
    await eventually(async () => session.outline(), 'the words did not arrive above gamma',
      (lines) => lines.join('|') === 'ul|- alpha|- |- beta|- gamma');
    for (const style of await inlineStyles()) {
      expect(style, 'the source item\'s layout came along as inline style')
        .not.toMatch(/text-indent|line-height|white-space|text-align|display|float/);
    }
    await expectSound('words of a bullet pasted into another');
  }, 60_000);

  it('pastes a bullet cut from an indented group above a top-level bullet', async () => {
    await session.reset(
      '<ul><li>alpha<ul><li>beta</li><li>gamma</li></ul></li><li>delta</li></ul>');
    await session.edit();
    await session.caretIn('beta', 'start');
    await shiftDown();
    await cut();
    await eventually(async () => session.outline(), 'the cut did not take the indented bullet',
      (lines) => lines.join('|') === 'ul|- alpha|  ul|  - gamma|- delta');
    await session.caretIn('delta', 'start');
    await paste();
    await eventually(async () => session.outline(), 'the words did not arrive above delta',
      (lines) => lines.join('|') === 'ul|- alpha|  ul|  - gamma|- beta|- delta');
    await expectSound('an indented bullet moved to the top level');
    const markup = await session.markup();
    expect(markup, 'literal newlines in list markup paint as blank lines').not.toMatch(/\n/);
  }, 60_000);
});

describe.skipIf(!electronBinary)('paragraph spacing around indented bullets', () => {
  it('spaces top-level bullets and leaves an indented group closed up', async () => {
    await session.reset(
      '<ul><li>alpha</li><li>beta<ul><li>gamma</li><li>delta</li></ul></li><li>epsilon</li></ul>');
    // Fixture setup: the deck's paragraph spacing, as the inspector writes it.
    await session.cdp.evaluate(`(() => {
      window.store.commit((deck) => {
        const element = deck.slides[0].elements.find((c) => c.id === ${JSON.stringify(TEXT_ID)});
        element.paragraphSpacing = 30;
      }, { label: 'Paragraph spacing fixture' });
      return true;
    })()`);
    const margins = await eventually(async () => session.cdp.evaluate<Record<string, string>>(`(() => {
      const root = document.querySelector('${CONTENT}');
      const out = {};
      for (const item of root.querySelectorAll('li')) {
        const text = item.firstChild?.textContent?.trim() ?? '';
        out[text] = getComputedStyle(item).marginTop;
      }
      return out;
    })()`), 'the spacing never applied', (value) => value.epsilon === '30px');
    expect(margins).toEqual({
      alpha: '0px', beta: '30px', gamma: '0px', delta: '0px', epsilon: '30px',
    });
    const nestedListMargin = await session.cdp.evaluate<string>(
      `getComputedStyle(document.querySelector('${CONTENT} li ul')).marginTop`);
    expect(nestedListMargin, 'no paragraph gap before the first indented bullet').toBe('0px');
  }, 60_000);
});

describe.skipIf(electronBinary)('cutting and pasting bullets (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
