import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary } from './support/browserSession.js';
import {
  MOD,
  SHAPE,
  TABLE,
  TEXT_A,
  TEXT_B,
  TEXT_C,
  startSelectionSession,
  type SelectionSession,
} from './support/selectionSession.js';

/**
 * What is selected, and where the keyboard points, driven by real input.
 *
 * There are four selections in this editor and they are not independent: the
 * objects selected on the slide, the text box being typed into, the range of
 * table cells inside that box, and the slides selected in the rail. An author
 * can only ever be doing one of those things at a time, so:
 *
 *  - typing into a box means that box, and only that box, is selected;
 *  - a range of table cells belongs to the table being edited, and both the
 *    cell highlight and the table's own selection go away together;
 *  - slides and objects are never selected at once;
 *  - and whatever the state, the chrome on screen — the edit outline, the
 *    selection outlines, the highlighted cells, the rail rows — shows exactly
 *    that state and nothing else.
 *
 * Each case checks the specific thing it is about *and* the full invariant
 * set, so a fix that trades one broken state for another cannot pass.
 */
const DECK_ID = 'selection-focus';

let session: SelectionSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startSelectionSession(DECK_ID, 'Selection Focus');
  session = started.session;
  close = started.close;
}, 120_000);

afterAll(async () => {
  await close?.();
  close = null;
});

/** Nothing anywhere in the editor contradicts anything else. */
async function expectSound(label: string): Promise<void> {
  expect(await session.problems(), label).toEqual([]);
}

describe.skipIf(!electronBinary)('selection and text editing', () => {
  it('narrows a multiple selection to the box being typed into', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.click(TEXT_A);
    await session.shiftClick(TEXT_B);
    expect((await session.state()).selection.sort(), 'shift-click adds the second box')
      .toEqual([TEXT_A, TEXT_B].sort());

    await session.doubleClick(TEXT_A);
    const state = await session.state();
    expect(state.editing, 'the double-clicked box is being edited').toBe(TEXT_A);
    expect(state.selection, 'only the edited box stays selected').toEqual([TEXT_A]);
    expect(state.outlines, 'one selection outline is drawn').toBe(1);
    await expectSound('editing one of two selected boxes');
  });

  it('narrows a select-all to the box being typed into', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.click(TEXT_A);
    await session.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    expect((await session.state()).selection.length, 'Cmd+A selects every object')
      .toBeGreaterThan(1);

    await session.doubleClick(TEXT_B);
    const state = await session.state();
    expect(state.editing).toBe(TEXT_B);
    expect(state.selection, 'the other objects are dropped').toEqual([TEXT_B]);
    await expectSound('editing after select-all');
  });

  it('keeps typing inside the edited box when another box is selected first', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.click(TEXT_B);
    await session.shiftClick(TEXT_A);
    await session.doubleClick(TEXT_A);
    await session.type('ZZ');
    await expectSound('typing into one of two previously selected boxes');
    // Paragraphs run together in textContent; what matters is that nothing
    // was typed into, or deleted from, the box the author is not in.
    expect(await session.textOf(TEXT_B), 'the other box is untouched')
      .toBe('beta onebeta two');
    expect(await session.textOf(TEXT_A), 'the typed characters landed once')
      .toContain('ZZ');
  });

  it('ends the edit when a shift-click reaches for another object', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    await session.type('x');
    await session.shiftClick(TEXT_B);
    const state = await session.state();
    expect(state.editing, 'shift-clicking away leaves text editing').toBeNull();
    expect(state.selection, 'both objects are selected as objects')
      .toEqual(expect.arrayContaining([TEXT_A, TEXT_B]));
    await expectSound('shift-click away from an edit');
  });

  it('leaves editing on Escape and clears the selection on the next one', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    await session.key('Escape', 27);
    let state = await session.state();
    expect(state.editing, 'the first Escape leaves text editing').toBeNull();
    expect(state.selection, 'the box stays selected as an object').toEqual([TEXT_A]);
    await expectSound('after leaving an edit with Escape');

    await session.key('Escape', 27);
    state = await session.state();
    expect(state.selection, 'the second Escape deselects').toEqual([]);
    await expectSound('after deselecting with Escape');
  });

  it('does not delete objects with the Backspace that edits text', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    await session.key('Backspace', 8);
    await session.key('Backspace', 8);
    const state = await session.state();
    expect(state.elements, 'every object survives typing')
      .toEqual(expect.arrayContaining([TEXT_A, TEXT_B, TABLE, SHAPE]));
    await expectSound('Backspace while editing');
  });

  it('commits and deselects when the canvas beside the box is clicked', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    await session.type('q');
    await session.clickEmpty();
    const state = await session.state();
    expect(state.editing, 'clicking empty canvas leaves editing').toBeNull();
    expect(state.selection, 'and selects nothing').toEqual([]);
    await expectSound('after clicking empty canvas');
  });

  it('ends the edit when the author moves to another slide', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TEXT_A);
    await session.type('w');
    await session.clickRail(1);
    const state = await session.state();
    expect(state.slideIndex, 'the rail switched slides').toBe(1);
    expect(state.editing, 'no edit session survives the slide change').toBeNull();
    expect(state.elements, 'the other slide is showing').toEqual([TEXT_C]);
    await expectSound('after changing slides mid-edit');
  });

  it('keeps slide and object selections apart', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.clickRail(0);
    await session.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    let state = await session.state();
    expect(state.slideSelection.length, 'the rail selects every slide').toBe(2);
    expect(state.selection, 'no object is selected alongside them').toEqual([]);
    await expectSound('after selecting every slide');

    await session.click(TEXT_A);
    state = await session.state();
    expect(state.selection, 'clicking an object selects it').toEqual([TEXT_A]);
    expect(state.slideSelection.length, 'and collapses the slide selection to one').toBe(1);
    await expectSound('after selecting an object from a slide selection');
  });
});

describe.skipIf(!electronBinary)('table cell selection', () => {
  it('selects a column inside the table that is selected', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TABLE);
    await session.dragCells([1, 2], [3, 2]);
    const state = await session.state();
    expect(state.table?.elementId, 'the range belongs to the table').toBe(TABLE);
    expect(state.table?.mode, 'a vertical drag is a column').toBe('column');
    expect(state.selection, 'the table itself is the selected object').toEqual([TABLE]);
    expect(state.highlightedTables, 'only the table shows highlighted cells').toEqual([TABLE]);
    await expectSound('a column selected inside an edited table');
  });

  it('drops the cell highlight when the edit ends with Escape', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TABLE);
    await session.dragCells([2, 1], [2, 3]);
    expect((await session.state()).table?.mode, 'a horizontal drag is a row').toBe('row');

    await session.key('Escape', 27);
    const state = await session.state();
    expect(state.editing, 'Escape leaves the table').toBeNull();
    expect(state.table, 'and takes the cell range with it').toBeNull();
    expect(state.highlightedTables, 'no cells stay highlighted').toEqual([]);
    await expectSound('after leaving a table with cells selected');
  });

  it('drops the cell highlight when another object is clicked', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TABLE);
    await session.dragCells([1, 1], [3, 1]);
    await session.click(TEXT_B);
    const state = await session.state();
    expect(state.selection, 'the clicked object is selected').toEqual([TEXT_B]);
    expect(state.table, 'the cell range is gone').toBeNull();
    expect(state.highlightedTables, 'and so is its highlight').toEqual([]);
    await expectSound('after clicking away from selected table cells');
  });

  it('drops the cell highlight when the empty canvas is clicked', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TABLE);
    await session.clickCell(2, 2);
    expect((await session.state()).table?.elementId, 'a single cell is the range').toBe(TABLE);

    await session.clickEmpty();
    const state = await session.state();
    expect(state.table, 'nothing is selected, cells included').toBeNull();
    expect(state.highlightedTables).toEqual([]);
    await expectSound('after clicking empty canvas from a table cell');
  });

  it('drops the cell highlight when the author moves to another slide', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TABLE);
    await session.dragCells([1, 3], [3, 3]);
    await session.clickRail(1);
    const state = await session.state();
    expect(state.table, 'the cell range does not survive the slide change').toBeNull();
    await expectSound('after changing slides from a table cell range');

    await session.clickRail(0);
    expect((await session.state()).highlightedTables, 'nor does its highlight').toEqual([]);
    await expectSound('after returning to the slide with the table');
  });

  it('keeps the table the only selected object while its cells are selected', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.click(TEXT_A);
    await session.shiftClick(TABLE);
    await session.doubleClick(TABLE);
    await session.dragCells([1, 1], [3, 1]);
    const state = await session.state();
    expect(state.table?.elementId, 'the cells belong to the table').toBe(TABLE);
    expect(state.selection, 'and the table is what is selected').toEqual([TABLE]);
    await expectSound('cells selected in a table that was part of a multiple selection');
  });

  it('types into the clicked cell instead of over the whole table', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    // The table is selected first, so the next press gets straight into the
    // text: the way an author reaches a cell after picking the table up.
    await session.click(TABLE);
    await session.doubleClick(TABLE);
    await session.type('zz');
    const rows = await session.tableShape();
    expect(rows.length, 'the table still has its rows').toBe(3);
    expect(rows.map((row) => row.length), 'and its columns').toEqual([3, 3, 3]);
    expect(rows[0], 'the row above the caret is untouched')
      .toEqual(['r1c1', 'r1c2', 'r1c3']);
    expect(rows[2], 'so is the row below').toEqual(['r3c1', 'r3c2', 'r3c3']);
    expect(rows[1].join('|'), 'the characters landed in the clicked cell')
      .toContain('zz');
    await expectSound('after typing into a table cell');
  });

  it('moves the cell range with the caret, one table at a time', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.doubleClick(TABLE);
    await session.clickCell(1, 1);
    await session.clickCell(3, 3);
    const state = await session.state();
    expect(state.table, 'the last clicked cell is the range')
      .toMatchObject({ row: 2, column: 2, rowEnd: 2, columnEnd: 2 });
    expect(state.highlightedTables).toEqual([TABLE]);
    await expectSound('after moving between cells');
  });
});
