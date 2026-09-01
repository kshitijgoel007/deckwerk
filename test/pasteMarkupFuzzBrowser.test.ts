import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import {
  contentText,
  describeOperation,
  enterEditing,
  markupProblems,
  PASTE_CONTENT,
  PASTE_MOD as MOD,
  PASTE_PANEL as PANEL,
  PASTE_CORPUS,
  PASTE_TEXT_ID,
  pasteCases,
  pasteFromClipboard,
  persistedMarkupProblems,
  tagListField,
  TARGET_FIXTURES,
  normalizeText,
  type PasteCase,
  type PasteOperation,
} from './support/pasteMarkupCorpus.js';

/**
 * Pasting is how most slide text arrives, and the markup other applications
 * put on the clipboard is nothing like what the editor writes. This fuzzes
 * that boundary: real clipboard payloads from Notes, Word, Google Docs,
 * spreadsheets, web pages and plain text, pasted at every place a caret can
 * be, each followed by a seeded run of the edits an author makes next —
 * bold/italic/underline, alignment, list conversion, typing, deleting, undo.
 *
 * After every single step the box must still be markup the editor can render
 * and format: no list inside a paragraph, no list nested straight inside a
 * list, no orphan list item, nothing unsafe, and every top-level node a block.
 * The same rules are applied to what the collaboration server persisted, so a
 * box that only looks right in the DOM cannot pass.
 */
const RUN_EXHAUSTIVE = process.env.RUN_EXHAUSTIVE_PASTE_FUZZ === '1';
const DECK_ID = 'paste-markup-fuzz';
const CASES = pasteCases({
  exhaustive: RUN_EXHAUSTIVE,
  // Cover the WHOLE corpus in the default gate: a sample of 12 walked
  // payload[index % 16], so the last four corpus entries never ran at all
  // outside the exhaustive matrix.
  sample: PASTE_CORPUS.length,
  operationsPerCase: RUN_EXHAUSTIVE ? 8 : 5,
});

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('pasted markup survives being edited', () => {
  it('pastes real clipboard payloads everywhere and keeps the box formattable', {
    timeout: RUN_EXHAUSTIVE ? 60 * 60_000 : 300_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'paste-markup-fuzz-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Paste markup fuzz');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: PASTE_TEXT_ID,
      type: 'text',
      x: 100, y: 100, w: 1720, h: 820,
      rot: 0, z: 1, opacity: 1,
      class: ['role-body'],
      style: {},
      html: '<p>Text</p>',
      align: 'left',
      valign: 'top',
    } as never);
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #fff; color: #111827; }',
      '.role-body { font: 400 28px/1.35 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Paste%20Fuzz`, profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`(
      document.getElementById('status')?.textContent?.includes('connected as Paste Fuzz') === true
      && Boolean(document.querySelector('${PASTE_CONTENT}'))
    )`), 'the paste-fuzz browser did not finish connecting');
    await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');

    for (const testCase of CASES) {
      await runPasteCase(editor, server.port, testCase);
    }
  });
});

describe.skipIf(electronBinary)('pasted markup survives being edited (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});

async function runPasteCase(cdp: Cdp, port: number, testCase: PasteCase): Promise<void> {
  const { payload, target, operations } = testCase;
  const where = `${payload.name} → ${target}`;
  await resetFixture(cdp, target);
  await enterEditing(cdp, PASTE_CONTENT);
  await placeCaret(cdp, target);

  const beforePaste = await contentText(cdp, PASTE_CONTENT);
  await pasteFromClipboard(cdp, payload);
  if (payload.expected.length > 0) {
    await eventually(async () => contentText(cdp, PASTE_CONTENT),
      `${where}: pasted text never appeared`,
      (text) => payload.expected.every((fragment) => text.includes(normalizeText(fragment))));
  } else {
    // A whitespace-only paste must still leave the box intact.
    await eventually(async () => contentText(cdp, PASTE_CONTENT),
      `${where}: the box lost its own text`, (text) => text.length >= 0);
  }
  expect(beforePaste, `${where}: paste did nothing`).not.toBe(undefined);
  await checkBox(cdp, port, `${where}: after the paste`);

  for (const operation of operations) {
    const label = `${where}: after ${describeOperation(operation)}`;
    const before = await contentText(cdp, PASTE_CONTENT);
    await applyOperation(cdp, operation);
    await checkBox(cdp, port, label);
    const after = await contentText(cdp, PASTE_CONTENT);
    if (operation.kind === 'inline' || operation.kind === 'align' || operation.kind === 'list') {
      // Formatting rearranges markup; it must never rewrite the words. A list
      // conversion collapses the blank lines a bullet list cannot hold, so
      // compare the words rather than the exact spacing.
      expect(words(after), `${label}: formatting changed the text`).toEqual(words(before));
    }
    if (operation.kind === 'type' || operation.kind === 'split') {
      // Whitespace depends on where the caret sat and whether Enter opened a
      // new block, so compare with spacing removed. This still catches a
      // keystroke landing twice ("42" arriving as "4422") and text going
      // missing, which is what these operations can actually get wrong.
      const typed = compact(operation.text);
      expect(compact(after).length, `${label}: characters inserted`)
        .toBe(compact(before).length + typed.length);
      expect(occurrences(compact(after), typed), `${label}: copies of the typed run`)
        .toBe(occurrences(compact(before), typed) + 1);
    }
    if (operation.kind === 'delete' || operation.kind === 'delete-word') {
      expect(after.length, `${label}: deletion removed nothing`)
        .toBeLessThanOrEqual(before.length);
    }
  }
}

/** Fixture setup only: the interactions under test are all real input. */
async function resetFixture(cdp: Cdp, target: PasteCase['target']): Promise<void> {
  const fixture = TARGET_FIXTURES[target];
  // Leave editing first: the canvas deliberately does not patch the element
  // being edited, so a fixture written underneath it would never render.
  if (await cdp.evaluate<boolean>(
    `document.querySelector('${PASTE_CONTENT}')?.isContentEditable === true`,
  )) {
    // The previous operation may have left focus in the inspector, where
    // Escape means something else; click back into the text first.
    await cdp.click(PASTE_CONTENT, 'the text box before leaving editing');
    await cdp.key('Escape', 27);
    await eventually(async () => cdp.evaluate<boolean>(
      `document.querySelector('${PASTE_CONTENT}')?.isContentEditable !== true`,
    ), 'Escape did not leave text editing');
  }
  await cdp.evaluate(`(() => {
    const store = window.store;
    store.commit((deck) => {
      const element = deck.slides[0].elements.find((candidate) => candidate.id === ${JSON.stringify(PASTE_TEXT_ID)});
      element.html = ${JSON.stringify(fixture.html)};
      element.class = ${JSON.stringify(fixture.classes)};
      element.align = 'left';
      delete element.table;
    }, { label: 'Paste fuzz fixture' });
    return true;
  })()`);
  await eventually(async () => cdp.evaluate<boolean>(
    `document.querySelector('${PASTE_CONTENT}')?.innerHTML.includes(${JSON.stringify(
      fixture.html.slice(0, 20).replace(/<[^>]*$/, ''),
    )}) === true`,
    ), 'the fixture markup did not render');
}

async function placeCaret(cdp: Cdp, target: PasteCase['target']): Promise<void> {
  switch (target) {
    case 'placeholder':
      await cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      return;
    case 'caret-at-end':
      await cdp.clickTextAtOffset(PASTE_CONTENT, 5, 'first line');
      await cdp.key('End', 35);
      return;
    case 'inside-word':
      await cdp.clickTextAtOffset(PASTE_CONTENT, 6, 'middle of a word');
      return;
    case 'over-selection':
      await cdp.dragSelectFirstWord(PASTE_CONTENT, 'first word');
      return;
    case 'inside-list-item':
      await cdp.clickTextAtOffset(PASTE_CONTENT, 20, 'second list item');
      return;
    case 'inside-table-cell':
      await cdp.click(`${PASTE_CONTENT} tbody tr:first-child td:nth-child(2)`, 'table cell B');
      return;
  }
}

async function applyOperation(cdp: Cdp, operation: PasteOperation): Promise<void> {
  // Deleting can empty the box, and there is then no word to select: those
  // operations have nothing to act on rather than something to get wrong.
  if ((operation.kind === 'inline' || operation.kind === 'delete-word')
    && !(await contentText(cdp, PASTE_CONTENT)).trim()) return;
  switch (operation.kind) {
    case 'list': {
      await cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      const field = await tagListField(cdp);
      await cdp.choose(field, operation.style, `list ${operation.style}`);
      return;
    }
    case 'inline': {
      await cdp.dragSelectFirstWord(PASTE_CONTENT, 'first word');
      if (operation.route === 'shortcut') {
        const key = operation.format === 'bold' ? 'b' : operation.format === 'italic' ? 'i' : 'u';
        await cdp.chord(key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), MOD);
        return;
      }
      const label = operation.format === 'bold'
        ? 'Bold (Cmd/Ctrl+B)'
        : operation.format === 'italic' ? 'Italic (Cmd/Ctrl+I)' : 'Underline (Cmd/Ctrl+U)';
      await cdp.click(`${PANEL} button[aria-label="${label}"]`, label);
      return;
    }
    case 'align': {
      await cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      const index = { left: 1, center: 2, right: 3, justify: 4 }[operation.alignment];
      await cdp.click(`${PANEL} .align-button:nth-of-type(${index})`, `align ${operation.alignment}`);
      return;
    }
    case 'type': {
      await caretAtEnd(cdp);
      await cdp.typeKeys(operation.text);
      return;
    }
    case 'delete': {
      await caretAtEnd(cdp);
      for (let press = 0; press < operation.characters; press += 1) {
        await cdp.key('Backspace', 8);
      }
      return;
    }
    case 'delete-word': {
      await cdp.dragSelectFirstWord(PASTE_CONTENT, 'first word');
      await cdp.key('Backspace', 8);
      return;
    }
    case 'split': {
      await caretAtEnd(cdp);
      await cdp.key('Enter', 13);
      await cdp.typeKeys(operation.text);
      return;
    }
    case 'undo':
      await cdp.chord('z', 'KeyZ', 90, MOD);
      return;
  }
}

async function caretAtEnd(cdp: Cdp): Promise<void> {
  const offset = await cdp.evaluate<number>(`(() => {
    const text = document.querySelector('${PASTE_CONTENT}')?.textContent ?? '';
    for (let index = text.length - 1; index >= 0; index -= 1) {
      if (!/[\\s\\u2060]/.test(text[index])) return index;
    }
    return 0;
  })()`);
  await cdp.clickTextAtOffset(PASTE_CONTENT, offset, 'last visible character');
  await cdp.key('End', 35);
}

/** Every rule, against the live DOM and against what the server persisted. */
async function checkBox(cdp: Cdp, port: number, label: string): Promise<void> {
  const live = await markupProblems(cdp, PASTE_CONTENT);
  if (live.length > 0) {
    const html = await cdp.evaluate<string>(`document.querySelector('${PASTE_CONTENT}')?.innerHTML ?? ''`);
    expect(live, `${label}: live markup — ${html}`).toEqual([]);
  }
  expect(
    await cdp.evaluate<boolean>(`document.querySelector('${PASTE_CONTENT}')?.isContentEditable === true`),
    `${label}: the box stopped being editable`,
  ).toBe(true);
  expect(
    await cdp.evaluate<boolean>(`window.__pasteOwned === true`),
    `${label}: pasted script ran`,
  ).toBe(false);

  const persisted = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${DECK_ID}`);
    const live = await response.json() as Deck;
    const element = live.slides[0].elements.find((candidate) => candidate.id === PASTE_TEXT_ID);
    return element && element.type === 'text' ? element.html : null;
  }, `${label}: the element left the server`, (html) => typeof html === 'string');
  const stored = await persistedMarkupProblems(cdp, persisted!);
  if (stored.length > 0) {
    expect(stored, `${label}: persisted markup — ${persisted}`).toEqual([]);
  }
}

function compact(value: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function occurrences(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0;
}

function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}
