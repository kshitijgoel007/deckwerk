import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDeck } from '../../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { emptyDeck } from '../../src/shared/deck.js';
import {
  Cdp,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
  type RunningBrowser,
} from './browserSession.js';
import { collabClientDir } from './collabClient.js';

/**
 * One real editor for the mode-flag and focus-lifecycle bug hunt, driven only
 * through input a person can produce. Modelled on selectionSession.ts (whose
 * whole-editor invariant checker is reused verbatim below), with a fixture
 * that additionally contains an IMAGE overlapped by a text box — the layout
 * needed to reach crop/mask mode and text editing at the same time.
 *
 * The only internal pokes are `reset` (fixture setup) and the read-only state
 * snapshots.
 */

/** An image in the upper-left area. */
export const IMAGE = 'mf-image';
/** A text box lying entirely INSIDE the image's box (text over a figure). */
export const TEXT_OVER = 'mf-text-over';
/** A free-standing text box on the right. */
export const TEXT_B = 'mf-text-b';
/** A 3x3 native table below TEXT_B. */
export const TABLE = 'mf-table';

export const MOD = process.platform === 'darwin' ? 4 : 2;
/** CDP modifier bitmask: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
export const SHIFT = 8;

export const TEXT_OVER_HTML = '<p>over one</p>';
export const TEXT_B_HTML = '<p>beta one</p><p>beta two</p>';
export const TABLE_HTML = [
  '<table><tbody>',
  '<tr><td>r1c1</td><td>r1c2</td><td>r1c3</td></tr>',
  '<tr><td>r2c1</td><td>r2c2</td><td>r2c3</td></tr>',
  '<tr><td>r3c1</td><td>r3c2</td><td>r3c3</td></tr>',
  '</tbody></table>',
].join('');

/** A real 1x1 red PNG so the image element has a servable asset. */
const RED_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** What the editor believes about its modes at one moment. */
export interface ModeState {
  slideIndex: number;
  selection: string[];
  /** The element being typed into, if any. */
  editing: string | null;
  /** The element in crop/mask mode, if any. */
  masking: string | null;
  table: null | {
    elementId: string;
    mode: string;
    row: number;
    column: number;
    rowEnd: number;
    columnEnd: number;
  };
  elements: string[];
  focus: string;
  /** DOM chrome: is a `.sel-box.masking` outline being drawn? */
  maskChrome: boolean;
  /** DOM chrome: elements carrying the `.editing` class. */
  editingNodes: string[];
  /** Ids whose cells carry the editor-only table highlight. */
  highlightedTables: string[];
  /** Whether the inline theme editor panel is open. */
  themeEditorOpen: boolean;
}

/**
 * The whole-editor invariant checker, copied verbatim from
 * test/support/selectionSession.ts (that file may not be modified by this
 * hunt, and its checker is not exported). Each returned string is one
 * violation, phrased as the thing an author would see.
 */
const INVARIANTS = `() => {
  const problems = [];
  const store = window.store;
  const canvas = window.canvas;
  const state = store.get();
  const selection = [...state.selection];
  const editing = canvas.editingElementId();
  const table = canvas.tableSelectionInfo();
  const slide = state.deck.slides[state.slideIndex];
  const ids = new Set((slide ? slide.elements : []).map((el) => el.id));
  const layer = document.querySelector('.slide-layer');
  const overlay = document.querySelector('.overlay-layer');
  const show = (list) => '[' + list.join(', ') + ']';
  if (!layer || !overlay) return ['the canvas layers are missing'];

  for (const id of selection) {
    if (!ids.has(id)) problems.push('selected ' + id + ' is not on the current slide');
  }
  if (new Set(selection).size !== selection.length) {
    problems.push('the selection lists an object twice: ' + show(selection));
  }

  if (editing !== null) {
    if (!ids.has(editing)) {
      problems.push('editing ' + editing + ', which is not on the current slide');
    }
    if (selection.length !== 1 || selection[0] !== editing) {
      problems.push('editing ' + editing + ' while the selection is ' + show(selection));
    }
  }

  const editingNodes = [...layer.querySelectorAll('.editing')]
    .map((node) => node.getAttribute('data-element-id') || '(unnamed)');
  const expectedEditing = editing === null ? [] : [editing];
  if (editingNodes.join('|') !== expectedEditing.join('|')) {
    problems.push('the edit outline is on ' + show(editingNodes)
      + ' but the edit session is on ' + show(expectedEditing));
  }
  const editable = [...layer.querySelectorAll('.text-content')]
    .filter((node) => node.isContentEditable)
    .map((node) => node.closest('[data-element-id]')?.getAttribute('data-element-id')
      || '(unnamed)');
  if (editable.join('|') !== expectedEditing.join('|')) {
    problems.push('typing would reach ' + show(editable)
      + ' but the edit session is on ' + show(expectedEditing));
  }

  const active = document.activeElement;
  const activeElementId = active && active.closest
    ? active.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null
    : null;
  if (editing !== null && active && layer.contains(active) && activeElementId !== editing) {
    problems.push('focus sits in ' + (activeElementId ?? 'the canvas')
      + ' while ' + editing + ' is being edited');
  }

  const nativeSelection = window.getSelection();
  const anchor = nativeSelection && nativeSelection.anchorNode;
  const anchorElement = anchor
    ? (anchor.nodeType === 1 ? anchor : anchor.parentElement)
    : null;
  if (anchorElement && layer.contains(anchorElement)) {
    const owner = anchorElement.closest('[data-element-id]')?.getAttribute('data-element-id')
      ?? '(unnamed)';
    if (editing === null && !nativeSelection.isCollapsed) {
      problems.push('a text highlight survives in ' + owner + ' with no edit session');
    } else if (editing !== null && owner !== editing) {
      problems.push('the caret is in ' + owner + ' while ' + editing + ' is being edited');
    }
  }

  const highlighted = [...layer.querySelectorAll('.editor-table-selected')];
  const highlightOwners = [...new Set(highlighted.map((cell) =>
    cell.closest('[data-element-id]')?.getAttribute('data-element-id') ?? '(unnamed)'))];
  if (table === null) {
    if (highlighted.length > 0) {
      problems.push(highlighted.length + ' table cells stay highlighted in '
        + show(highlightOwners) + ' with no cell range selected');
    }
  } else {
    if (table.elementId !== editing) {
      problems.push('a table cell range is live in ' + table.elementId
        + ' while the edit session is on ' + (editing ?? 'nothing'));
    }
    if (!selection.includes(table.elementId)) {
      problems.push('cells of ' + table.elementId + ' are selected but the table is not: '
        + 'the selection is ' + show(selection));
    }
    const element = (slide ? slide.elements : []).find((el) => el.id === table.elementId);
    if (!element) problems.push('cells are selected in ' + table.elementId + ', which is gone');
    else if (element.type !== 'text' || !element.table) {
      problems.push('cells are selected in ' + table.elementId + ', which is not a table');
    }
    if (highlightOwners.length > 1 || (highlightOwners[0] && highlightOwners[0] !== table.elementId)) {
      problems.push('highlighted cells are in ' + show(highlightOwners)
        + ' but the cell range belongs to ' + table.elementId);
    }
    const expectedCells = (Math.abs(table.rowEnd - table.row) + 1)
      * (Math.abs(table.columnEnd - table.column) + 1);
    if (highlighted.length !== expectedCells) {
      problems.push('the cell range covers ' + expectedCells + ' cells but '
        + highlighted.length + ' are highlighted');
    }
  }

  const expectedOutlines = (slide ? slide.elements : [])
    .filter((el) => state.selection.has(el.id) && !el.layoutMasterId).length;
  const outlines = overlay.querySelectorAll('.sel-box').length;
  if (outlines !== expectedOutlines) {
    problems.push('the overlay draws ' + outlines + ' selection outlines for '
      + expectedOutlines + ' selected objects');
  }

  const slideSelection = [...state.slideSelection];
  if (slide && !state.slideSelection.has(slide.id)) {
    problems.push('the current slide is not part of the slide selection '
      + show(slideSelection));
  }
  if (selection.length > 0 && slideSelection.length > 1) {
    problems.push(selection.length + ' objects are selected alongside '
      + slideSelection.length + ' slides');
  }
  const railSelected = [...document.querySelectorAll('.rail-item')]
    .filter((row) => row.classList.contains('selected'))
    .map((row) => Number(row.dataset.index));
  const expectedRail = state.deck.slides
    .map((candidate, index) => (state.slideSelection.has(candidate.id) ? index : -1))
    .filter((index) => index >= 0);
  if (railSelected.join(',') !== expectedRail.join(',')) {
    problems.push('the rail highlights slides ' + show(railSelected)
      + ' but ' + show(expectedRail) + ' are selected');
  }
  const railActive = [...document.querySelectorAll('.rail-item.active')]
    .map((row) => Number(row.dataset.index));
  if (railActive.join(',') !== String(state.slideIndex)) {
    problems.push('the rail marks ' + show(railActive) + ' as the current slide, not '
      + state.slideIndex);
  }
  return problems;
}`;

const STATE = `() => {
  const store = window.store;
  const canvas = window.canvas;
  const state = store.get();
  const slide = state.deck.slides[state.slideIndex];
  const active = document.activeElement;
  const owner = active && active.closest
    ? active.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null
    : null;
  const layer = document.querySelector('.slide-layer');
  return {
    slideIndex: state.slideIndex,
    selection: [...state.selection],
    editing: canvas.editingElementId(),
    masking: canvas.maskingElement(),
    table: canvas.tableSelectionInfo(),
    elements: (slide ? slide.elements : []).map((el) => el.id),
    focus: owner
      ? 'inside ' + owner
      : active
        ? (active.id ? '#' + active.id : active.tagName.toLowerCase()
          + (active.className ? '.' + String(active.className).split(' ').join('.') : ''))
        : 'nothing',
    maskChrome: Boolean(document.querySelector('.overlay-layer .sel-box.masking')),
    editingNodes: layer
      ? [...layer.querySelectorAll('.editing')]
        .map((node) => node.getAttribute('data-element-id') || '(unnamed)')
      : [],
    highlightedTables: [...new Set([...document.querySelectorAll('.editor-table-selected')]
      .map((cell) => cell.closest('[data-element-id]')?.getAttribute('data-element-id')
        ?? '(unnamed)'))],
    themeEditorOpen: (() => {
      const editor = document.querySelector('.theme-inline-editor');
      return Boolean(editor && !editor.hidden);
    })(),
  };
}`;

export interface ModeFocusSession {
  cdp: Cdp;
  /** Put the deck back to its starting shape with nothing selected. */
  reset(): Promise<void>;
  click(elementId: string): Promise<void>;
  doubleClick(elementId: string): Promise<void>;
  clickEmpty(): Promise<void>;
  clickCell(row: number, column: number): Promise<void>;
  dragCells(from: [number, number], to: [number, number]): Promise<void>;
  key(key: string, code: number): Promise<void>;
  chord(key: string, code: string, virtualKey: number, modifiers: number,
    commands?: string[]): Promise<void>;
  type(value: string): Promise<void>;
  state(): Promise<ModeState>;
  /** Invariant violations that survive a short settle window. */
  problems(): Promise<string[]>;
  /** The collapsed rendered text of an element. */
  textOf(elementId: string): Promise<string>;
  /** The html the store holds for an element on the current slide. */
  storedHtml(elementId: string): Promise<string>;
}

export function elementSelector(elementId: string): string {
  return `.slide-layer [data-element-id="${elementId}"]`;
}

function cellSelector(row: number, column: number): string {
  return `${elementSelector(TABLE)} table tr:nth-child(${row}) td:nth-child(${column})`;
}

export async function startModeFocusSession(deckId: string, name: string): Promise<{
  session: ModeFocusSession;
  close: () => Promise<void>;
}> {
  const workDir = await mkdtemp(join(tmpdir(), 'mode-focus-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, deckId);
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(deckDir, 'assets', 'red.png'), RED_PIXEL_PNG);

  const deck = emptyDeck('Mode and focus');
  deck.themePreset = 'basic';
  for (const element of startingElements()) {
    deck.slides[0].elements.push(element as never);
  }
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 28px/1.4 sans-serif; }',
    'table { width: 100%; border-collapse: collapse; }',
    'td { border: 1px solid #9ca3af; padding: 8px; }',
    '',
  ].join('\n'), 'utf8');

  const clientDir = await collabClientDir();
  let server: RunningCollabServer | null = await startCollabServer({
    rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
  });
  let browser: RunningBrowser | null = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${deckId}&name=${encodeURIComponent(name)}`,
    profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (candidate) => candidate.url.includes(`deck=${deckId}`),
    browser.log,
  );
  let cdp: Cdp | null = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => cdp!.evaluate<boolean>(
    `Boolean(document.querySelector('${elementSelector(TABLE)} table'))`,
  ), 'the mode-focus fixture never loaded');

  const session = buildSession(cdp);
  return {
    session,
    close: async () => {
      cdp?.close();
      cdp = null;
      await stopBrowser(browser?.process ?? null);
      browser = null;
      await server?.close();
      server = null;
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

function buildSession(cdp: Cdp): ModeFocusSession {
  const session: ModeFocusSession = {
    cdp,
    async reset() {
      // Leave whatever state the last case ended in the way an author would,
      // then write the starting deck back. Escape / mask-off are real actions
      // where possible; the deck write is fixture setup.
      for (let attempt = 0; attempt < 3; attempt++) {
        const editing = await cdp.evaluate<string | null>(
          'window.canvas.editingElementId()');
        if (editing === null) break;
        await cdp.key('Escape', 27);
        await wait(80);
      }
      await cdp.evaluate(`(() => {
        document.getElementById('ctx-menu')?.remove();
        if (window.canvas.maskingElement()) window.canvas.toggleMaskMode(null);
        window.store.commit((deck) => {
          deck.slides[0].elements = ${JSON.stringify(startingElements())};
        }, { label: 'Mode fixture' });
        window.store.selectSlide(0);
        window.store.clearSelection();
        return true;
      })()`);
      await eventually(async () => cdp.evaluate<boolean>(
        `Boolean(document.querySelector('${elementSelector(TABLE)} table'))`,
      ), 'the fixture deck did not render');
      await wait(60);
    },
    async click(elementId) {
      await cdp.click(elementSelector(elementId), elementId);
      await wait(60);
    },
    async doubleClick(elementId) {
      await cdp.doubleClick(elementSelector(elementId), elementId);
      await wait(120);
    },
    async clickEmpty() {
      // The lower band of the slide holds nothing.
      await cdp.clickWithin('.slide-layer', 0.5, 0.96, 'empty canvas');
      await wait(60);
    },
    async clickCell(row, column) {
      await cdp.click(cellSelector(row, column), `cell ${row},${column}`);
      await wait(80);
    },
    async dragCells(from, to) {
      await cdp.dragBetween(
        cellSelector(from[0], from[1]),
        cellSelector(to[0], to[1]),
        `cells ${from.join(',')} to ${to.join(',')}`,
      );
      await wait(80);
    },
    async key(key, code) {
      await cdp.key(key, code);
      await wait(60);
    },
    async chord(key, code, virtualKey, modifiers, commands) {
      await cdp.chord(key, code, virtualKey, modifiers, commands);
      await wait(80);
    },
    async type(value) {
      await cdp.typeKeys(value);
      await wait(60);
    },
    state() {
      return cdp.evaluate<ModeState>(`(${STATE})()`);
    },
    async problems() {
      // A violation only counts if it survives a settle window.
      const first = await cdp.evaluate<string[]>(`(${INVARIANTS})()`);
      if (first.length === 0) return first;
      await wait(200);
      const second = await cdp.evaluate<string[]>(`(${INVARIANTS})()`);
      return second.filter((problem) => first.includes(problem));
    },
    async textOf(elementId) {
      const value = await cdp.evaluate<string>(
        `document.querySelector('${elementSelector(elementId)} .text-content')?.textContent ?? ''`);
      return value.replace(/[\s ​⁠]+/g, ' ').trim();
    },
    storedHtml(elementId) {
      return cdp.evaluate<string>(`(() => {
        const state = window.store.get();
        const slide = state.deck.slides[state.slideIndex];
        const el = slide?.elements.find((e) => e.id === ${JSON.stringify(elementId)});
        return el ? el.html : '(missing)';
      })()`);
    },
  };
  return session;
}

function textElement(
  id: string,
  html: string,
  box: { x: number; y: number; w: number; h: number },
  z = 1,
): Record<string, unknown> {
  return {
    id, type: 'text', ...box, rot: 0, z, opacity: 1,
    class: ['role-body'], style: {}, html, align: 'left', valign: 'top',
  };
}

function startingElements(): Array<Record<string, unknown>> {
  return [
    {
      id: IMAGE, type: 'image', x: 200, y: 120, w: 900, h: 520, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, src: 'assets/red.png', fit: 'cover',
      alt: '', sourceBox: null,
    },
    // Entirely inside the image's box, but leaving the image's centre and its
    // lower half uncovered so the image itself stays right-clickable.
    { ...textElement(TEXT_OVER, TEXT_OVER_HTML, { x: 250, y: 160, w: 420, h: 110 }, 5) },
    textElement(TEXT_B, TEXT_B_HTML, { x: 1250, y: 120, w: 560, h: 200 }, 2),
    {
      ...textElement(TABLE, TABLE_HTML, { x: 1250, y: 430, w: 560, h: 300 }, 2),
      table: { columnWidths: [1, 1, 1], autoHeight: true },
    },
  ];
}
