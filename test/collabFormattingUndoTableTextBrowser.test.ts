import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import {
  FormattingSession,
  MOD,
  ON_CANVAS,
  PANEL,
  TABLE_ID,
} from './support/collabFormattingSession.js';

/**
 * Production-browser regression for table formatting, borders, scopes, and
 * structure (split from the former omnibus
 * collabFormattingUndoBrowser.test.ts): whole-table object formatting, native
 * character selections inside cells through every inline text path, every
 * border control (presets and the draw tool), every dragged selection scope
 * (cell, row, column, rectangle) through every formatting control, and column
 * insert/delete — each applied through real input and undone back to the
 * exact original.
 */

// A serif preference list rather than one hardcoded family: Georgia is on
// macOS but not stock Ubuntu CI, where the Liberation/DejaVu faces stand in.
// The first one actually in the dropdown is chosen and asserted against.
const SERIF_CHOICES = ['Georgia', 'Liberation Serif', 'DejaVu Serif', 'Times New Roman'];

const DECK_ID = 'formatting-undo-table-text';

let session: FormattingSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe.skipIf(!electronBinary)('table text formatting and borders in the collaboration browser', () => {
  it('formats table words, borders, and structure, undoing each exact change', async () => {
    session = await FormattingSession.start(DECK_ID, 'Formatting Undo');
    const { editor } = session;
    await session.captureOriginals();

    /* A single-click object selection means the whole table. */
    await editor.click(ON_CANVAS(TABLE_ID), 'whole table object');
    await session.openProps();
    const wholeTableSize = await session.idField(
      'Font size', 'test-whole-table-font-size', '.field-number');
    await editor.typeInto(wholeTableSize, '48', 'whole table font size');
    await session.expectTableStyled('font-size: 48px', 4);
    await eventually(async () => (await session!.liveElement(TABLE_ID)).style['font-size'],
      'whole table box font size did not apply', (value) => value === '48px');
    await session.undoChrome(TABLE_ID);

    /* Native character selections inside cells mirror every inline text path. */
    await editor.doubleClick(`${ON_CANVAS(TABLE_ID)} .text-content`, 'table text for word formatting');
    const selectTableWord = async () => session!.beginSelectFirstWord(
      TABLE_ID, 'tbody tr:first-child td:nth-child(2)',
    );
    const expectTableWordStyled = async (marker: RegExp, cellMarker: RegExp) => {
      await session!.expectHtml(TABLE_ID, (html) => marker.test(html) && !cellMarker.test(html));
    };

    for (const [label, marker, cellMarker] of [
      ['Bold (Cmd/Ctrl+B)', /<(?:b|strong)\b|font-weight:\s*700/i,
        /<td[^>]*style="[^"]*font-weight/i],
      ['Italic (Cmd/Ctrl+I)', /<(?:i|em)\b|font-style:\s*italic/i,
        /<td[^>]*style="[^"]*font-style/i],
      ['Underline (Cmd/Ctrl+U)', /<u\b|text-decoration(?:-line)?:\s*underline/i,
        /<td[^>]*style="[^"]*text-decoration/i],
    ] as const) {
      await selectTableWord();
      await editor.click(`${PANEL} button[aria-label="${label}"]`, `${label} table word`);
      await expectTableWordStyled(marker, cellMarker);
      await session.expectFormatButtonPressed(label);
      await session.undoEditing(TABLE_ID);
    }

    for (const [key, marker, cellMarker] of [
      ['b', /<(?:b|strong)\b|font-weight:\s*700/i, /<td[^>]*style="[^"]*font-weight/i],
      ['i', /<(?:i|em)\b|font-style:\s*italic/i, /<td[^>]*style="[^"]*font-style/i],
      ['u', /<u\b|text-decoration(?:-line)?:\s*underline/i,
        /<td[^>]*style="[^"]*text-decoration/i],
    ] as const) {
      await selectTableWord();
      await editor.chord(key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), MOD);
      await expectTableWordStyled(marker, cellMarker);
      await session.undoEditing(TABLE_ID);
    }

    for (const [label, value, marker, cellMarker] of [
      ['Font size', '44', /font-size:\s*44px/i, /<td[^>]*style="[^"]*font-size/i],
      ['Font weight', '650', /font-weight:\s*650/i, /<td[^>]*style="[^"]*font-weight/i],
    ] as const) {
      await selectTableWord();
      const input = await session.idField(
        label, `test-table-word-${label.replace(' ', '-')}`, '.field-number');
      await editor.typeInto(input, value, `${label} table word`);
      await expectTableWordStyled(marker, cellMarker);
      await session.undoEditing(TABLE_ID);
    }

    await selectTableWord();
    const wordFamily = await session.chooseFontFamily(SERIF_CHOICES, 'table word font family');
    await expectTableWordStyled(
      new RegExp(`font-family:\\s*${wordFamily}`, 'i'), /<td[^>]*style="[^"]*font-family/i,
    );
    await session.undoEditing(TABLE_ID);

    await selectTableWord();
    const wordColourTrigger = `${PANEL} .field-color .color-picker-trigger[aria-label^="Colour"]`;
    await editor.click(wordColourTrigger, 'table word colour');
    await editor.click(
      '.color-picker-popover .color-picker-palette-button[title="#1d7d45"]',
      'green table word',
    );
    await expectTableWordStyled(
      /color:\s*(?:#1d7d45|rgb\(29,\s*125,\s*69\))/i,
      /<td[^>]*style="[^"]*color/i,
    );
    await session.undoEditing(TABLE_ID);

    /* Every table border control is exercised through real Chromium input. */
    await session.enterTable('Cell');
    const borderWidth = await session.idField(
      'Border width', 'test-table-border-width', '.table-border-paint .field-number');
    await editor.typeInto(borderWidth, '3', 'table border width');
    await editor.click(
      `${PANEL} .table-border-paint .color-picker-trigger`, 'table border colour');
    await editor.click(
      '.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green border');
    await editor.click(await session.buttonId('No borders', 'test-no-borders'), 'no table borders');
    await eventually(async () => session!.tableBordersFromServer(),
      'no-border preset did not clear every edge', (cells) => cells.length === 4
        && cells.every((cell) => Object.values(cell.widths).every((width) => width === '0px')));

    await editor.click(
      await session.buttonId('Vertical borders', 'test-vertical-borders'),
      'vertical table borders',
    );
    await eventually(async () => session!.tableBordersFromServer(),
      'vertical-border preset did not isolate vertical edges', (cells) => cells.length === 4
        && cells.every((cell) => cell.widths.left === '3px' && cell.widths.right === '3px'
          && cell.widths.top === '0px' && cell.widths.bottom === '0px'
          && cell.colors.left === 'rgb(29, 125, 69)'
          && cell.colors.right === 'rgb(29, 125, 69)'));

    await editor.click(
      await session.buttonId('Horizontal borders', 'test-horizontal-borders'),
      'horizontal table borders',
    );
    await eventually(async () => session!.tableBordersFromServer(),
      'horizontal-border preset did not isolate horizontal edges', (cells) => cells.length === 4
        && cells.every((cell) => cell.widths.top === '3px' && cell.widths.bottom === '3px'
          && cell.widths.left === '0px' && cell.widths.right === '0px'
          && cell.colors.top === 'rgb(29, 125, 69)'
          && cell.colors.bottom === 'rgb(29, 125, 69)'));

    await editor.click(
      await session.buttonId('No borders', 'test-no-borders-again'),
      'clear borders before drawing',
    );
    await editor.click(
      await session.buttonId('Draw borders', 'test-draw-borders'),
      'enable border drawing',
    );
    const firstCell = `${ON_CANVAS(TABLE_ID)} tbody tr:first-child td:first-child`;
    expect(await editor.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(firstCell)})?.closest('table')?.classList.contains('editor-table-border-drawing') === true`,
    )).toBe(true);
    await editor.hoverWithin(firstCell, 0.995, 0.5, 'hover first-cell right border');
    const hoveredCellClass = await editor.evaluate<string>(
      `document.querySelector(${JSON.stringify(firstCell)})?.className ?? ''`,
    );
    expect(hoveredCellClass).toContain('editor-table-border-preview-right');
    await editor.clickWithin(firstCell, 0.995, 0.5, 'draw first-cell right border');
    await eventually(async () => session!.tableBordersFromServer(),
      'draw-border tool did not persist the shared edge', (cells) => cells.length === 4
        && cells[0].widths.right === '3px' && cells[1].widths.left === '3px'
        && cells[0].colors.right === 'rgb(29, 125, 69)'
        && cells[1].colors.left === 'rgb(29, 125, 69)');
    await editor.click(
      await session.buttonId('Draw borders', 'test-draw-borders-off'),
      'disable border drawing',
    );
    await session.refocusTableAndUndo();

    /* A real cell drag determines cell, horizontal, vertical, or rectangular
       scope, and every control styles exactly the dragged cells. */
    for (const scope of ['Cell', 'Row', 'Column', 'Range'] as const) {
      const affected = { Cell: 1, Row: 2, Column: 2, Range: 4 }[scope];
      await session.enterTable(scope);
      await editor.click(`${PANEL} .text-table-options .color-picker-trigger:first-of-type`, `${scope} fill`);
      await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green fill');
      await session.expectTableStyled('background-color', affected);
      await session.refocusTableAndUndo();

      await session.enterTable(scope);
      await editor.click(`${PANEL} .text-table-options .field-color:nth-of-type(2) .color-picker-trigger`, `${scope} text colour`);
      await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green text');
      await session.expectTableStyled('color:', affected);
      await session.refocusTableAndUndo();

      await session.enterTable(scope);
      // The fixture already inherits Arial from the element. Choosing Arial
      // again is correctly a no-op, so use a genuinely different family when
      // asserting that the selected cells receive an explicit declaration.
      await session.chooseFontFamily(SERIF_CHOICES, `${scope} font family`);
      await session.expectTableStyled('font-family', affected);
      await session.refocusTableAndUndo();

      for (const [label, value, marker] of [
        ['Font weight', '400', 'font-weight'],
        ['Font size', '36', 'font-size'],
      ] as const) {
        for (const direction of ['up', 'down'] as const) {
          await session.enterTable(scope);
          const input = await session.idField(
            label, `test-table-${scope}-${label.replace(' ', '-')}-${direction}`, '.field-number');
          expect(await editor.evaluate<string>(`document.querySelector('${input}').value`)).toBe(value);
          await editor.click(`${PANEL} button[aria-label="${label} ${direction}"]`,
            `${scope} ${label} ${direction}`);
          await session.expectTableStyled(marker, affected);
          await session.refocusTableAndUndo();
        }
      }

      await session.enterTable(scope);
      await editor.click(`${PANEL} .align-button:nth-of-type(2)`, `${scope} centre alignment`);
      await session.expectTableStyled('text-align: center', affected);
      await session.refocusTableAndUndo();

      await session.enterTable(scope);
      const tableVertical = await session.idField('Vertical', `test-table-${scope}-vertical`, 'label.field');
      await editor.choose(tableVertical, 'bottom', `${scope} vertical alignment`);
      await session.expectTableStyled('vertical-align: bottom', affected);
      await session.refocusTableAndUndo();

      for (const [label, marker] of [
        ['Bold (Cmd/Ctrl+B)', 'font-weight'],
        ['Italic (Cmd/Ctrl+I)', 'font-style'],
        ['Underline (Cmd/Ctrl+U)', 'text-decoration'],
      ] as const) {
        await session.enterTable(scope);
        await editor.click(`${PANEL} button[aria-label="${label}"]`, `${scope} ${label}`);
        await session.expectTableStyled(marker, affected);
        await session.expectFormatButtonPressed(label);
        await session.refocusTableAndUndo();
      }
    }

    for (const [scope, action, cells] of [
      ['Column', 'Insert before', 6],
      ['Column', 'Insert after', 6],
      ['Column', 'Delete column', 2],
    ] as const) {
      await session.enterTable(scope);
      const actionSelector = await session.buttonId(action, `test-${action.replaceAll(' ', '-')}`);
      await editor.click(actionSelector, action);
      await eventually(async () => await session!.tableCellCount() === cells,
        `${action} did not change the table`);
      await session.refocusTableAndUndo();
    }
  }, 120_000);
});
