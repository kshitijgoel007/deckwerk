import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary } from './support/browserSession.js';
import {
  FormattingSession,
  OL_ID,
  UL_ID,
  runInlineFormatMatrix,
} from './support/collabFormattingSession.js';

/**
 * Production-browser regression for formatting focus, scope, and undo on the
 * ordered-list text box (split from the former omnibus
 * collabFormattingUndoBrowser.test.ts): the full inline format matrix, plus
 * Keynote-style list marker changes across both list kinds.
 */

const DECK_ID = 'formatting-undo-ordered-list';

let session: FormattingSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe.skipIf(!electronBinary)('ordered-list formatting scope and undo in the collaboration browser', () => {
  it('clicks every ordered-list formatting path and undoes each exact change', async () => {
    session = await FormattingSession.start(DECK_ID, 'Formatting Undo');
    const { editor } = session;
    await session.captureOriginals();

    /* Full inline-format matrix on the ordered list. */
    await session.openProps();
    await runInlineFormatMatrix(session, OL_ID, '<li', 2);

    /* Selecting one word changes the marker kind of the whole containing list,
       preserving markup — while "None" frees just the paragraph the selection
       is in, the way Keynote does, leaving the items around it bulleted. */
    for (const [id, selectedItem, current, next, expected] of [
      [OL_ID, 'li:first-child', 'Numbered', 'Bulleted',
        '<ul><li><span class="keep">Ordered</span> one</li><li>Ordered two</li></ul>'],
      [UL_ID, 'li:nth-child(2)', 'Bulleted', 'Numbered',
        '<ol><li><span class="keep">Bullet</span> one</li><li>Bullet two</li></ol>'],
      [OL_ID, 'li:nth-child(2)', 'Numbered', 'None',
        '<ol><li><span class="keep">Ordered</span> one</li></ol><p>Ordered two</p>'],
    ] as const) {
      await session.beginSelectFirstWord(id, selectedItem);
      const list = await session.idField('List', `test-list-${id}-${next}`, 'label.field');
      expect(await editor.evaluate<string>(`document.querySelector('${list}').value`)).toBe(current);
      await editor.choose(list, next, `${id} list style ${next}`);
      await session.expectHtml(id, (html) => html === expected);
      await session.undoEditing(id);
    }
  }, 120_000);
});
