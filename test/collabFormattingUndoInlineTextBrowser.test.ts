import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import {
  FormattingSession,
  MOD,
  NORMAL_ID,
  OL_ID,
  ON_CANVAS,
  UL_ID,
  count,
  runInlineFormatMatrix,
} from './support/collabFormattingSession.js';

/**
 * Production-browser regression for formatting focus, scope, and undo on a
 * plain paragraph text box (split from the former omnibus
 * collabFormattingUndoBrowser.test.ts): click-to-edit entry, the full inline
 * format matrix, and the collapsed-caret shortcut typing contract — each
 * keystroke must place exactly one character, and the run typed between the
 * two toggles must be the only styled text.
 */

const DECK_ID = 'formatting-undo-inline-text';

let session: FormattingSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe.skipIf(!electronBinary)('inline text formatting scope and undo in the collaboration browser', () => {
  it('clicks every inline text formatting path and undoes each exact change', async () => {
    session = await FormattingSession.start(DECK_ID, 'Formatting Undo');
    const { editor } = session;

    /* First click selects; a later single click edits; double-click still does both. */
    await editor.click(ON_CANVAS(NORMAL_ID), 'unselected text first click');
    expect(await editor.evaluate<boolean>(`(() => {
      const content = document.querySelector('${ON_CANVAS(NORMAL_ID)} .text-content');
      return window.store.get().selection.has('${NORMAL_ID}')
        && content?.isContentEditable !== true;
    })()`)).toBe(true);
    await editor.clickTextAtOffset(
      `${ON_CANVAS(NORMAL_ID)} .text-content`, 7, 'selected text at requested caret position',
    );
    await eventually(async () => editor.evaluate<{
      editing: boolean;
      collapsed: boolean;
      beforeCaret: string;
    }>(`(() => {
      const content = document.querySelector('${ON_CANVAS(NORMAL_ID)} .text-content');
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      return {
        editing: content?.isContentEditable === true,
        collapsed: selection?.isCollapsed ?? false,
        beforeCaret: anchor?.nodeType === Node.TEXT_NODE
          ? (anchor.textContent ?? '').slice(0, selection?.anchorOffset ?? 0)
          : '',
      };
    })()`), 'selected text did not enter editing at the clicked character', (state) =>
      state.editing && state.collapsed && state.beforeCaret === 'Normal ');
    await editor.click(ON_CANVAS(OL_ID), 'leave editing and select another text box');
    await editor.doubleClick(ON_CANVAS(UL_ID), 'unselected text double-click');
    await eventually(async () => editor.evaluate<boolean>(
      `document.querySelector('${ON_CANVAS(UL_ID)} .text-content')?.isContentEditable === true`,
    ), 'unselected text did not enter editing on double-click');
    await editor.click(ON_CANVAS(NORMAL_ID), 'finish click-entry checks');

    await session.captureOriginals();

    /* Full inline-format matrix on the paragraph text box. */
    await session.openProps();
    await runInlineFormatMatrix(session, NORMAL_ID, '<p', 2);

    /* The reported flow: a collapsed-caret shortcut, then ordinary typing.
       Each keystroke must place exactly one character ("not", never
       "nnoott"), and the run typed between the two toggles must be the only
       styled text. */
    for (const [key, declaration, commands] of [
      ['i', /font-style:\s*italic/i, undefined],
      ['i', /font-style:\s*italic/i, ['italic']],
      ['b', /font-weight:\s*(?:700|bold)/i, undefined],
      ['u', /text-decoration(?:-line)?:\s*underline/i, undefined],
    ] as const) {
      await session.beginSelectFirstWord(NORMAL_ID);
      await session.placeCaretAtEnd(NORMAL_ID);
      await session.typeHere(NORMAL_ID, ' plain', `caret ${key} typing before the shortcut`);
      await editor.chord(
        key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), MOD,
        commands ? [...commands] : undefined,
      );
      await session.typeHere(NORMAL_ID, ' not', `caret ${key} typing while the style is pending`);
      await editor.chord(
        key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), MOD,
        commands ? [...commands] : undefined,
      );
      await session.typeHere(NORMAL_ID, ' again', `caret ${key} typing after the style ended`);
      await session.expectHtml(NORMAL_ID, (html) => {
        const styled = [...html.matchAll(/<span[^>]*style="([^"]*)"[^>]*>([^<]*)<\/span>/g)]
          .filter(([, style]) => declaration.test(style));
        return count(html, '<p') === 2
          && styled.length === 1
          && session!.plainTextOf(styled[0][2]) === ' not';
      });
      await session.restore(NORMAL_ID);
    }
  }, 120_000);
});
