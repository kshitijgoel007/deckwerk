import { afterEach, describe, it } from 'vitest';
import { electronBinary } from './support/browserSession.js';
import {
  FORMAT_COMMANDS,
  FormattingSession,
  MOD,
  UL_ID,
  count,
  runInlineFormatMatrix,
} from './support/collabFormattingSession.js';

/**
 * Production-browser regression for formatting focus, scope, and undo on the
 * bullet-list text box (split from the former omnibus
 * collabFormattingUndoBrowser.test.ts): the full inline format matrix, plus
 * both routings of the B/I/U shortcuts (the plain chord and the same chord
 * carrying the macOS editing command Chromium delivers through `beforeinput`)
 * with real per-keystroke typing around each toggle.
 */

const DECK_ID = 'formatting-undo-bullet-list';

let session: FormattingSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe.skipIf(!electronBinary)('bullet-list formatting scope and undo in the collaboration browser', () => {
  it('clicks every bullet-list formatting path and undoes each exact change', async () => {
    session = await FormattingSession.start(DECK_ID, 'Formatting Undo');
    const { editor } = session;
    await session.captureOriginals();

    /* Full inline-format matrix on the bullet list. */
    await session.openProps();
    await runInlineFormatMatrix(session, UL_ID, '<li', 2);

    for (const [key, label, marker] of [
      ['b', 'Bold (Cmd/Ctrl+B)', /<(b|strong)\b|font-weight/i],
      ['i', 'Italic (Cmd/Ctrl+I)', /<(i|em)\b|font-style/i],
      ['u', 'Underline (Cmd/Ctrl+U)', /<u\b|text-decoration/i],
    ] as const) {
      // Both routings of the shortcut: the plain chord, and the same chord
      // carrying the macOS editing command Chromium delivers through
      // `beforeinput` (formatBold/formatItalic/formatUnderline).
      for (const commands of [undefined, [FORMAT_COMMANDS[key]]] as const) {
        await session.beginSelectFirstWord(UL_ID);
        await session.typeAtEnd(UL_ID, ' pre', `${UL_ID} ${label} typing before the shortcut`);
        await session.beginSelectFirstWord(UL_ID);
        await editor.chord(
          key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), MOD,
          commands ? [...commands] : undefined,
        );
        await session.expectHtml(UL_ID, (html) => marker.test(html)
          && count(html, '<ul') === 1 && count(html, '<li') === 2);
        await session.expectFormatButtonPressed(label);
        await session.typeAtEnd(UL_ID, ' post', `${UL_ID} ${label} typing after the shortcut`);
        await session.restore(UL_ID);
      }
    }
  }, 120_000);
});
