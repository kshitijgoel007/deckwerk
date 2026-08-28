import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
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

/**
 * Full production-browser regression for formatting focus, scope, and undo.
 * Every mutation below is initiated through the shipping control with real
 * pointer/key input, then Ctrl+Z is dispatched through Chromium and the exact
 * original element is required to return on the collaboration server.
 */

const DECK_ID = 'formatting-undo';
const NORMAL_ID = 'normal-text';
const OL_ID = 'ordered-list';
const UL_ID = 'bullet-list';
const TABLE_ID = 'format-table';
const PANEL = '#inspector';
const ON_CANVAS = (id: string) => `#canvas [data-element-id="${id}"]`;
// CDP modifier mask: Control=2, Meta=4. Native contenteditable follows the
// platform convention (Cmd+A/Z on macOS, Ctrl+A/Z elsewhere).
const MOD = process.platform === 'darwin' ? 4 : 2;

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

describe.skipIf(!electronBinary)('formatting scope and undo in the collaboration browser', () => {
  it('clicks every text/list/table formatting path and undoes each exact change', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-format-undo-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Formatting focus and undo');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push(
      text(NORMAL_ID, 30, '<p>Normal first</p><p>Normal second</p>', 130),
      text(OL_ID, 190, '<ol><li><span class="keep">Ordered</span> one</li><li>Ordered two</li></ol>', 170),
      text(UL_ID, 390, '<ul><li><span class="keep">Bullet</span> one</li><li>Bullet two</li></ul>', 170),
      text(TABLE_ID, 590,
        '<table><tbody><tr><td>A</td><td>B</td></tr>'
          + '<tr><td>C</td><td>D</td></tr></tbody></table>', 400),
    );
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #fff; color: #111827; }',
      '.role-body { font: 400 36px/1.3 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Formatting%20Undo`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`(
      document.getElementById('status')?.textContent?.includes('connected as Formatting Undo') === true
      && Boolean(document.querySelector('${ON_CANVAS(TABLE_ID)} table'))
    )`), 'formatting browser did not finish connecting');

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
    await eventually(async () => editor!.evaluate<{
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
    await eventually(async () => editor!.evaluate<boolean>(
      `document.querySelector('${ON_CANVAS(UL_ID)} .text-content')?.isContentEditable === true`,
    ), 'unselected text did not enter editing on double-click');
    await editor.click(ON_CANVAS(NORMAL_ID), 'finish click-entry checks');

    const original = new Map<string, SlideElement>();
    for (const id of [NORMAL_ID, OL_ID, UL_ID, TABLE_ID]) {
      original.set(id, await liveElement(server.port, id));
    }

    const openProps = async () => editor!.click(
      '#side-tabs button[data-panel="inspector"]', 'Props tab');
    const beginSelectAll = async (id: string) => {
      const editing = await editor!.evaluate<boolean>(
        `document.querySelector('${ON_CANVAS(id)} .text-content')?.isContentEditable === true`,
      );
      if (!editing) await editor!.doubleClick(`${ON_CANVAS(id)} .text-content`, `${id} text`);
      else await editor!.click(`${ON_CANVAS(id)} .text-content`, `${id} reset caret`);
      await eventually(async () => editor!.evaluate<boolean>(
        `document.querySelector('${ON_CANVAS(id)} .text-content')?.isContentEditable === true`,
      ), `${id} did not enter text editing`);
      await editor!.dragSelectText(`${ON_CANVAS(id)} .text-content`, `${id} text`);
      await eventually(async () => editor!.evaluate<boolean>(
        `window.getSelection()?.isCollapsed === false`,
      ), `${id} text was not selected`);
    };
    const beginSelectFirstWord = async (id: string, descendant = '') => {
      const editing = await editor!.evaluate<boolean>(
        `document.querySelector('${ON_CANVAS(id)} .text-content')?.isContentEditable === true`,
      );
      if (!editing) {
        await editor!.doubleClickText(`${ON_CANVAS(id)} .text-content`, `${id} first word`);
      }
      await eventually(async () => editor!.evaluate<boolean>(
        `document.querySelector('${ON_CANVAS(id)} .text-content')?.isContentEditable === true`,
      ), `${id} did not enter text editing`);
      const target = `${ON_CANVAS(id)} .text-content${descendant ? ` ${descendant}` : ''}`;
      if (editing) await editor!.click(target, `${id} reset caret`);
      await editor!.dragSelectFirstWord(target, `${id} selected word`);
      await eventually(async () => editor!.evaluate<boolean>(`(() => {
        const content = document.querySelector('${ON_CANVAS(id)} .text-content');
        return content?.isContentEditable === true
          && window.getSelection()?.isCollapsed === false
          && (window.getSelection()?.toString().trim().length ?? 0) > 0;
      })()`), `${id} first word was not selected`);
    };
    const undoEditing = async (id: string, preserveTextSelection = true) => {
      const selectedText = preserveTextSelection
        ? await editor!.evaluate<string>(`window.getSelection()?.toString() ?? ''`)
        : '';
      await editor!.chord('z', 'KeyZ', 90, MOD);
      await expectRestored(server!.port, id, original.get(id)!);
      if (preserveTextSelection) {
        await eventually(async () => editor!.evaluate<{
          editing: boolean;
          collapsed: boolean;
          selected: string;
        }>(`(() => ({
          editing: document.querySelector('${ON_CANVAS(id)} .text-content')?.isContentEditable === true,
          collapsed: window.getSelection()?.isCollapsed ?? true,
          selected: window.getSelection()?.toString() ?? '',
        }))()`), `${id} lost its text selection after undo`, (state) =>
          state.editing && !state.collapsed
            && state.selected.replace(/\s+/g, ' ').trim() === selectedText.replace(/\s+/g, ' ').trim());
      }
    };
    const undoChrome = async (id: string) => {
      await openProps();
      await editor!.chord('z', 'KeyZ', 90, MOD);
      await expectRestored(server!.port, id, original.get(id)!);
    };
    const idField = async (label: string, id: string, selector: string) => {
      const found = await editor!.evaluate<boolean>(`(() => {
        const field = [...document.querySelectorAll('${PANEL} ${selector}')]
          .find((node) => node.querySelector('span')?.textContent === ${JSON.stringify(label)}
            || node.textContent?.trim() === ${JSON.stringify(label)});
        const input = field?.querySelector('input, select');
        if (!input) return false;
        input.id = ${JSON.stringify(id)};
        return true;
      })()`);
      expect(found).toBe(true);
      return `#${id}`;
    };
    const expectFormatButtonPressed = async (label: string) => {
      await eventually(async () => editor!.evaluate<{
        pressed: string | null;
        background: string;
        border: string;
        peerBackground: string;
        peerBorder: string;
      }>(`(() => {
        const button = document.querySelector('${PANEL} button[aria-label="${label}"]');
        const peer = button?.parentElement?.querySelector('button[aria-pressed="false"]');
        const style = getComputedStyle(button);
        const peerStyle = getComputedStyle(peer);
        return {
          pressed: button?.getAttribute('aria-pressed') ?? null,
          background: style.backgroundColor,
          border: style.borderColor,
          peerBackground: peerStyle.backgroundColor,
          peerBorder: peerStyle.borderColor,
        };
      })()`), `${label} did not appear toggled`, (state) =>
        state.pressed === 'true'
          && state.background !== state.peerBackground
          && state.border !== state.peerBorder);
    };

    /* Full text-kind × inline-format matrix: every path is a real click and undo. */
    await openProps();
    const textKinds = [
      [NORMAL_ID, '<p', 2],
      [OL_ID, '<li', 2],
      [UL_ID, '<li', 2],
    ] as const;
    const hasOriginalStructure = (id: string, html: string, tag: string, amount: number) =>
      count(html, tag) === amount
        && (id !== OL_ID || count(html, '<ol') === 1)
        && (id !== UL_ID || count(html, '<ul') === 1)
        && count(html, '<br') === 0;

    for (const [id, tag, amount] of textKinds) {
      await beginSelectAll(id);
      await editor.choose(`${PANEL} .font-family-field select`, '', `${id} font family`);
      await expectHtml(server.port, id, (html) => hasOriginalStructure(id, html, tag, amount)
        && html.includes('font-family: inherit'));
      await undoEditing(id);

      for (const [label, marker] of [
        ['Bold (Cmd/Ctrl+B)', /<(b|strong)\b|font-weight/i],
        ['Italic (Cmd/Ctrl+I)', /<(i|em)\b|font-style/i],
        ['Underline (Cmd/Ctrl+U)', /<u\b|text-decoration/i],
      ] as const) {
        await beginSelectFirstWord(id);
        await editor.click(`${PANEL} button[aria-label="${label}"]`, `${id} ${label}`);
        await expectHtml(server.port, id, (html) => marker.test(html)
          && hasOriginalStructure(id, html, tag, amount));
        await expectFormatButtonPressed(label);
        await undoEditing(id);
      }

      await beginSelectAll(id);
      const weight = await idField('Font weight', `test-${id}-selected-font-weight`, '.field-number');
      await editor.typeInto(weight, '700', `${id} 700 font weight`);
      await expectHtml(server.port, id, (html) => hasOriginalStructure(id, html, tag, amount)
        && html.includes('font-weight: 700'));
      await undoEditing(id);

      for (const [label, expectedTheme, upDeclaration, downDeclaration] of [
        ['Font size', '36', 'font-size: 37px', 'font-size: 35px'],
        ['Font weight', '400', 'font-weight: 425', 'font-weight: 375'],
      ] as const) {
        for (const [direction, declaration] of [
          ['up', upDeclaration], ['down', downDeclaration],
        ] as const) {
          await beginSelectAll(id);
          const selector = await idField(
            label, `test-${id}-${label.replace(' ', '-')}-${direction}`, '.field-number');
          const inheritedField = await editor.evaluate<{ value: string; theme: string | null }>(`(() => {
            const input = document.querySelector('${selector}');
            return { value: input.value, theme: input.parentElement.querySelector('.theme-value-indicator')?.textContent ?? null };
          })()`);
          expect({ ...inheritedField, theme: inheritedField.theme?.toLowerCase() ?? null })
            .toEqual({ value: expectedTheme, theme: '(theme)' });
          await editor.click(`${PANEL} button[aria-label="${label} ${direction}"]`,
            `${id} ${label} ${direction} stepper`);
          await expectHtml(server.port, id, (html) => hasOriginalStructure(id, html, tag, amount)
            && html.includes(declaration));
          await undoEditing(id);
        }
      }

      await beginSelectAll(id);
      await editor.click(`${PANEL} .align-button:nth-of-type(2)`, `${id} selected paragraph alignment`);
      await expectHtml(server.port, id, (html) => hasOriginalStructure(id, html, tag, amount)
        && count(html, 'text-align: center') === 2);
      await undoEditing(id);

      await beginSelectAll(id);
      await editor.click(`${PANEL} .field-color .color-picker-trigger[aria-label^="Colour"]`, `${id} colour`);
      await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', `${id} green`);
      await expectHtml(server.port, id, (html) => hasOriginalStructure(id, html, tag, amount)
        && /color:\s*(?:#1d7d45|rgb\(29, 125, 69\))/i.test(html));
      await undoEditing(id);
    }

    for (const [key, label, marker] of [
      ['b', 'Bold (Cmd/Ctrl+B)', /<(b|strong)\b|font-weight/i],
      ['i', 'Italic (Cmd/Ctrl+I)', /<(i|em)\b|font-style/i],
      ['u', 'Underline (Cmd/Ctrl+U)', /<u\b|text-decoration/i],
    ] as const) {
      await beginSelectFirstWord(UL_ID);
      await editor.chord(key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), MOD);
      await expectHtml(server.port, UL_ID, (html) => marker.test(html)
        && count(html, '<ul') === 1 && count(html, '<li') === 2);
      await expectFormatButtonPressed(label);
      await undoEditing(UL_ID);
    }

    /* Selecting one word changes the whole containing list, preserving markup. */
    for (const [id, selectedItem, current, next, expected] of [
      [OL_ID, 'li:first-child', 'Numbered', 'Bulleted',
        '<ul><li><span class="keep">Ordered</span> one</li><li>Ordered two</li></ul>'],
      [UL_ID, 'li:nth-child(2)', 'Bulleted', 'Numbered',
        '<ol><li><span class="keep">Bullet</span> one</li><li>Bullet two</li></ol>'],
      [OL_ID, 'li:nth-child(2)', 'Numbered', 'None',
        '<p><span class="keep">Ordered</span> one</p><p>Ordered two</p>'],
    ] as const) {
      await beginSelectFirstWord(id, selectedItem);
      const list = await idField('List', `test-list-${id}-${next}`, 'label.field');
      expect(await editor.evaluate<string>(`document.querySelector('${list}').value`)).toBe(current);
      await editor.choose(list, next, `${id} list style ${next}`);
      await expectHtml(server.port, id, (html) => html === expected);
      await undoEditing(id);
    }

    /* Every box-level typography/layout control is clicked, then undone. */
    await editor.click(ON_CANVAS(OL_ID), 'ordered list box');
    await openProps();
    const size = await idField('Font size', 'test-font-size', '.field-number');
    await editor.typeInto(size, '48', 'Font size');
    await eventually(async () => (await liveElement(server!.port, OL_ID)).style['font-size'] === '48px',
      'font size did not apply');
    await undoChrome(OL_ID);

    const weight = await idField('Font weight', 'test-font-weight', '.field-number');
    await editor.typeInto(weight, '650', 'Font weight');
    await eventually(async () => (await liveElement(server!.port, OL_ID)).style['font-weight'] === '650',
      'font weight did not apply');
    await undoChrome(OL_ID);

    await editor.click(`${PANEL} .align-button:nth-of-type(2)`, 'centre alignment');
    await eventually(async () => (await liveElement(server!.port, OL_ID) as any).align === 'center',
      'alignment did not apply');
    await undoChrome(OL_ID);

    const vertical = await idField('Vertical', 'test-vertical', 'label.field');
    await editor.choose(vertical, 'bottom', 'Vertical alignment');
    await eventually(async () => (await liveElement(server!.port, OL_ID) as any).valign === 'bottom',
      'vertical alignment did not apply');
    await undoChrome(OL_ID);

    const spacing = await idField('Paragraph spacing', 'test-spacing', '.field-number');
    await editor.typeInto(spacing, '18', 'Paragraph spacing');
    await eventually(async () => (await liveElement(server!.port, OL_ID) as any).paragraphSpacing === 18,
      'paragraph spacing did not apply');
    await undoChrome(OL_ID);

    for (const [label, property] of [
      ['Auto-fit text to box', 'autoFit'],
      ['Disable automatic line breaks', 'noWrap'],
    ] as const) {
      const toggle = await checkboxId(label, `test-${property}`, editor);
      await editor.click(toggle, label);
      await eventually(async () => Boolean((await liveElement(server!.port, OL_ID) as any)[property]),
        `${label} did not apply`);
      await undoChrome(OL_ID);
    }

    const noWrapForCompression = await checkboxId(
      'Disable automatic line breaks', 'test-nowrap-compression', editor);
    await editor.click(noWrapForCompression, 'enable no-wrap for compression');
    await eventually(async () => Boolean((await liveElement(server!.port, OL_ID) as any).noWrap),
      'no-wrap prerequisite did not apply');
    const compression = await idField('Compress by', 'test-compression', 'label.field');
    await editor.choose(compression, 'condense', 'Compress by');
    await eventually(async () => (await liveElement(server!.port, OL_ID) as any).noWrapMode === 'condense',
      'compression mode did not apply');
    await editor.click(ON_CANVAS(OL_ID), 'ordered list before compression undo');
    await editor.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => liveElement(server!.port, OL_ID), 'compression mode did not undo',
      (element) => Boolean((element as any).noWrap)
        && ((element as any).noWrapMode ?? 'shrink') === 'shrink');
    await undoChrome(OL_ID);

    const role = await idField('Role', 'test-role', 'label.field');
    await editor.choose(role, 'role-title', 'Role');
    await eventually(async () => (await liveElement(server!.port, OL_ID)).class.includes('role-title'),
      'role did not apply');
    await undoChrome(OL_ID);

    const colourTrigger = `${PANEL} .field-color .color-picker-trigger[aria-label^="Colour"]`;
    await editor.click(colourTrigger, 'text colour');
    await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green swatch');
    await eventually(async () => (await liveElement(server!.port, OL_ID)).style.color === '#1d7d45',
      'text colour did not apply');
    await undoChrome(OL_ID);

    /* A single-click object selection means the whole table. */
    await editor.click(ON_CANVAS(TABLE_ID), 'whole table object');
    await openProps();
    const wholeTableSize = await idField(
      'Font size', 'test-whole-table-font-size', '.field-number');
    await editor.typeInto(wholeTableSize, '48', 'whole table font size');
    await expectTableStyled(server.port, 'font-size: 48px', 4);
    await eventually(async () => (await liveElement(server!.port, TABLE_ID)).style['font-size'],
      'whole table box font size did not apply', (value) => value === '48px');
    await undoChrome(TABLE_ID);

    /* Native character selections inside cells mirror every inline text path. */
    await editor.doubleClick(`${ON_CANVAS(TABLE_ID)} .text-content`, 'table text for word formatting');
    const selectTableWord = async () => beginSelectFirstWord(
      TABLE_ID, 'tbody tr:first-child td:nth-child(2)',
    );
    const expectTableWordStyled = async (marker: RegExp, cellMarker: RegExp) => {
      await expectHtml(server!.port, TABLE_ID, (html) => marker.test(html) && !cellMarker.test(html));
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
      await expectFormatButtonPressed(label);
      await undoEditing(TABLE_ID);
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
      await undoEditing(TABLE_ID);
    }

    for (const [label, value, marker, cellMarker] of [
      ['Font size', '44', /font-size:\s*44px/i, /<td[^>]*style="[^"]*font-size/i],
      ['Font weight', '650', /font-weight:\s*650/i, /<td[^>]*style="[^"]*font-weight/i],
    ] as const) {
      await selectTableWord();
      const input = await idField(
        label, `test-table-word-${label.replace(' ', '-')}`, '.field-number');
      await editor.typeInto(input, value, `${label} table word`);
      await expectTableWordStyled(marker, cellMarker);
      await undoEditing(TABLE_ID);
    }

    await selectTableWord();
    await editor.choose(`${PANEL} .font-family-field select`, 'Georgia', 'table word font family');
    await expectTableWordStyled(
      /font-family:\s*Georgia/i, /<td[^>]*style="[^"]*font-family/i,
    );
    await undoEditing(TABLE_ID);

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
    await undoEditing(TABLE_ID);

    /* A real cell drag determines cell, horizontal, vertical, or rectangular scope. */
    const enterTable = async (scope: 'Cell' | 'Row' | 'Column' | 'Range') => {
      await editor!.doubleClick(`${ON_CANVAS(TABLE_ID)} .text-content`, 'table text');
      const cells = {
        A: `${ON_CANVAS(TABLE_ID)} tbody tr:first-child td:first-child`,
        B: `${ON_CANVAS(TABLE_ID)} tbody tr:first-child td:nth-child(2)`,
        D: `${ON_CANVAS(TABLE_ID)} tbody tr:nth-child(2) td:nth-child(2)`,
      };
      if (scope === 'Cell') await editor!.click(cells.B, 'table cell B');
      else if (scope === 'Row') await editor!.dragBetween(cells.A, cells.B, 'table row drag');
      else if (scope === 'Column') await editor!.dragBetween(cells.B, cells.D, 'table column drag');
      else await editor!.dragBetween(cells.A, cells.D, 'table rectangular drag');
      const expected = { Cell: 1, Row: 2, Column: 2, Range: 4 }[scope];
      await eventually(async () => editor!.evaluate<number>(
        `document.querySelectorAll('${ON_CANVAS(TABLE_ID)} .editor-table-selected').length`,
      ), `${scope} drag did not select the expected cells`, (value) => value === expected);
      expect(await editor!.evaluate<boolean>(
        `document.querySelector('${ON_CANVAS(TABLE_ID)} .text-content')?.isContentEditable === true`,
      )).toBe(true);
    };
    const refocusTableAndUndo = async () => {
      await editor!.click(`${ON_CANVAS(TABLE_ID)} tbody tr:first-child td:first-child`, 'remaining table cell');
      await undoEditing(TABLE_ID, false);
    };

    /* Every table border control is exercised through real Chromium input. */
    await enterTable('Cell');
    const borderWidth = await idField(
      'Border width', 'test-table-border-width', '.table-border-paint .field-number');
    await editor.typeInto(borderWidth, '3', 'table border width');
    await editor.click(
      `${PANEL} .table-border-paint .color-picker-trigger`, 'table border colour');
    await editor.click(
      '.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green border');
    await editor.click(await buttonId('No borders', 'test-no-borders', editor), 'no table borders');
    await eventually(async () => tableBordersFromServer(server!.port, editor!),
      'no-border preset did not clear every edge', (cells) => cells.length === 4
        && cells.every((cell) => Object.values(cell.widths).every((width) => width === '0px')));

    await editor.click(
      await buttonId('Vertical borders', 'test-vertical-borders', editor),
      'vertical table borders',
    );
    await eventually(async () => tableBordersFromServer(server!.port, editor!),
      'vertical-border preset did not isolate vertical edges', (cells) => cells.length === 4
        && cells.every((cell) => cell.widths.left === '3px' && cell.widths.right === '3px'
          && cell.widths.top === '0px' && cell.widths.bottom === '0px'
          && cell.colors.left === 'rgb(29, 125, 69)'
          && cell.colors.right === 'rgb(29, 125, 69)'));

    await editor.click(
      await buttonId('Horizontal borders', 'test-horizontal-borders', editor),
      'horizontal table borders',
    );
    await eventually(async () => tableBordersFromServer(server!.port, editor!),
      'horizontal-border preset did not isolate horizontal edges', (cells) => cells.length === 4
        && cells.every((cell) => cell.widths.top === '3px' && cell.widths.bottom === '3px'
          && cell.widths.left === '0px' && cell.widths.right === '0px'
          && cell.colors.top === 'rgb(29, 125, 69)'
          && cell.colors.bottom === 'rgb(29, 125, 69)'));

    await editor.click(
      await buttonId('No borders', 'test-no-borders-again', editor),
      'clear borders before drawing',
    );
    await editor.click(
      await buttonId('Draw borders', 'test-draw-borders', editor),
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
    await eventually(async () => tableBordersFromServer(server!.port, editor!),
      'draw-border tool did not persist the shared edge', (cells) => cells.length === 4
        && cells[0].widths.right === '3px' && cells[1].widths.left === '3px'
        && cells[0].colors.right === 'rgb(29, 125, 69)'
        && cells[1].colors.left === 'rgb(29, 125, 69)');
    await editor.click(
      await buttonId('Draw borders', 'test-draw-borders-off', editor),
      'disable border drawing',
    );
    await refocusTableAndUndo();

    for (const scope of ['Cell', 'Row', 'Column', 'Range'] as const) {
      const affected = { Cell: 1, Row: 2, Column: 2, Range: 4 }[scope];
      await enterTable(scope);
      await editor.click(`${PANEL} .text-table-options .color-picker-trigger:first-of-type`, `${scope} fill`);
      await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green fill');
      await expectTableStyled(server.port, 'background-color', affected);
      await refocusTableAndUndo();

      await enterTable(scope);
      await editor.click(`${PANEL} .text-table-options .field-color:nth-of-type(2) .color-picker-trigger`, `${scope} text colour`);
      await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', 'green text');
      await expectTableStyled(server.port, 'color:', affected);
      await refocusTableAndUndo();

      await enterTable(scope);
      // The fixture already inherits Arial from the element. Choosing Arial
      // again is correctly a no-op, so use a genuinely different family when
      // asserting that the selected cells receive an explicit declaration.
      await editor.choose(`${PANEL} .font-family-field select`, 'Georgia', `${scope} font family`);
      await expectTableStyled(server.port, 'font-family', affected);
      await refocusTableAndUndo();

      for (const [label, value, marker] of [
        ['Font weight', '400', 'font-weight'],
        ['Font size', '36', 'font-size'],
      ] as const) {
        for (const direction of ['up', 'down'] as const) {
          await enterTable(scope);
          const input = await idField(
            label, `test-table-${scope}-${label.replace(' ', '-')}-${direction}`, '.field-number');
          expect(await editor.evaluate<string>(`document.querySelector('${input}').value`)).toBe(value);
          await editor.click(`${PANEL} button[aria-label="${label} ${direction}"]`,
            `${scope} ${label} ${direction}`);
          await expectTableStyled(server.port, marker, affected);
          await refocusTableAndUndo();
        }
      }

      await enterTable(scope);
      await editor.click(`${PANEL} .align-button:nth-of-type(2)`, `${scope} centre alignment`);
      await expectTableStyled(server.port, 'text-align: center', affected);
      await refocusTableAndUndo();

      await enterTable(scope);
      const tableVertical = await idField('Vertical', `test-table-${scope}-vertical`, 'label.field');
      await editor.choose(tableVertical, 'bottom', `${scope} vertical alignment`);
      await expectTableStyled(server.port, 'vertical-align: bottom', affected);
      await refocusTableAndUndo();

      for (const [label, marker] of [
        ['Bold (Cmd/Ctrl+B)', 'font-weight'],
        ['Italic (Cmd/Ctrl+I)', 'font-style'],
        ['Underline (Cmd/Ctrl+U)', 'text-decoration'],
      ] as const) {
        await enterTable(scope);
        await editor.click(`${PANEL} button[aria-label="${label}"]`, `${scope} ${label}`);
        await expectTableStyled(server.port, marker, affected);
        await expectFormatButtonPressed(label);
        await refocusTableAndUndo();
      }
    }

    for (const [scope, action, cells] of [
      ['Column', 'Insert before', 6],
      ['Column', 'Insert after', 6],
      ['Column', 'Delete column', 2],
    ] as const) {
      await enterTable(scope);
      const actionSelector = await buttonId(action, `test-${action.replaceAll(' ', '-')}`, editor);
      await editor.click(actionSelector, action);
      await eventually(async () => await tableCellCount(server!.port) === cells,
        `${action} did not change the table`);
      await refocusTableAndUndo();
    }
  }, 120_000);
});

function text(id: string, y: number, html: string, h = 180): SlideElement {
  return {
    id, type: 'text', x: 100, y, w: 1720, h, rot: 0, z: 1, opacity: 1,
    class: ['role-body'], style: { 'font-family': 'Arial' }, html,
    align: 'left', valign: 'top',
  } as SlideElement;
}

async function fetchDeck(port: number): Promise<Deck> {
  const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${DECK_ID}`);
  if (!response.ok) throw new Error(`deck request failed (${response.status})`);
  return response.json() as Promise<Deck>;
}

async function liveElement(port: number, id: string): Promise<SlideElement> {
  const deck = await fetchDeck(port);
  const element = deck.slides[0].elements.find((candidate) => candidate.id === id);
  if (!element) throw new Error(`missing ${id}`);
  return element;
}

async function expectRestored(port: number, id: string, original: SlideElement): Promise<void> {
  await eventually(async () => liveElement(port, id), `${id} did not undo exactly`,
    (element) => JSON.stringify(element) === JSON.stringify(original));
}

async function expectHtml(port: number, id: string, accept: (html: string) => boolean): Promise<void> {
  await eventually(async () => {
    const element = await liveElement(port, id);
    return element.type === 'text' ? element.html : '';
  }, `${id} html did not change as expected`, accept);
}

async function checkboxId(label: string, id: string, cdp: Cdp): Promise<string> {
  const found = await cdp.evaluate<boolean>(`(() => {
    const field = [...document.querySelectorAll('${PANEL} .field-check')]
      .find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
    const input = field?.querySelector('input');
    if (!input) return false;
    input.id = ${JSON.stringify(id)};
    return true;
  })()`);
  expect(found).toBe(true);
  return `#${id}`;
}

async function buttonId(label: string, id: string, cdp: Cdp): Promise<string> {
  const found = await cdp.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('${PANEL} button')]
      .find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.id = ${JSON.stringify(id)};
    return true;
  })()`);
  expect(found).toBe(true);
  return `#${id}`;
}

type PersistedCellBorders = {
  widths: Record<'top' | 'right' | 'bottom' | 'left', string>;
  colors: Record<'top' | 'right' | 'bottom' | 'left', string>;
};

/** Parse the server's saved cell styles through Chromium's real CSSOM. */
async function tableBordersFromServer(port: number, cdp: Cdp): Promise<PersistedCellBorders[]> {
  const element = await liveElement(port, TABLE_ID);
  if (element.type !== 'text') return [];
  return cdp.evaluate<PersistedCellBorders[]>(`(() => {
    const template = document.createElement('template');
    template.innerHTML = ${JSON.stringify(element.html)};
    return [...template.content.querySelectorAll('td, th')].map((cell) => ({
      widths: {
        top: cell.style.borderTopWidth,
        right: cell.style.borderRightWidth,
        bottom: cell.style.borderBottomWidth,
        left: cell.style.borderLeftWidth,
      },
      colors: {
        top: cell.style.borderTopColor,
        right: cell.style.borderRightColor,
        bottom: cell.style.borderBottomColor,
        left: cell.style.borderLeftColor,
      },
    }));
  })()`);
}

async function expectTableStyled(port: number, declaration: string, countExpected: number): Promise<void> {
  await expectHtml(port, TABLE_ID, (html) => count(html, declaration) === countExpected);
}

async function tableCellCount(port: number): Promise<number> {
  const element = await liveElement(port, TABLE_ID);
  if (element.type !== 'text') return 0;
  return count(element.html, '<td');
}

function count(value: string, marker: string): number {
  return value.split(marker).length - 1;
}
