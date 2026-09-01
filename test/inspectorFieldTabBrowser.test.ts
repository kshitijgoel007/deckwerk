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
  wait,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Tab out of an inspector field, not into the text.
 *
 * A number field commits on Return, and the canvas puts the caret back in the
 * live text so typing continues where it left off. The next key an author
 * presses is the Tab that leaves the field — it must not reach the text body
 * as "indent this bullet" and nest the list they were formatting, and it must
 * not end the edit and throw away the selection they were formatting either.
 *
 * Every key here is a real key event, dispatched the way a keyboard delivers
 * it, and the structure is read straight after the keystroke that would break
 * it — no waiting for the 250 ms live sync to decide the outcome.
 */
const DECK_ID = 'inspector-field-tab';
const TEXT_ID = 'tab-list';
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
const PANEL = '#inspector';

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

describe.skipIf(!electronBinary)('leaving an inspector field with Tab', () => {
  it('commits the field and leaves the list, caret and selection alone', {
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'inspector-field-tab-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Inspector field tab');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: TEXT_ID, type: 'text', x: 120, y: 160, w: 1680, h: 600,
      rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
      html: '<ol><li>Ordered one</li><li>Ordered two</li></ol>',
      align: 'left', valign: 'top',
    } as never);
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #fff; color: #111827; }',
      '.role-body { font: 400 36px/1.3 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Field%20Tab`, profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('${CONTENT} li'))`), 'the list fixture never loaded');
    await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');

    const count = (value: string, needle: string) => value.split(needle).length - 1;
    const liveHtml = async () => editor!.evaluate<string>(
      `document.querySelector('${CONTENT}')?.innerHTML ?? ''`);
    const serverHtml = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      const live = await response.json() as Deck;
      const element = live.slides[0].elements.find((candidate) => candidate.id === TEXT_ID);
      return element && element.type === 'text' ? element.html : '';
    };
    const isFlatList = (html: string) => count(html, '<ol') === 1
      && count(html, '<ul') === 0
      && count(html, '<li') === 2;

    const selectAllText = async () => {
      const editing = await editor!.evaluate<boolean>(
        `document.querySelector('${CONTENT}')?.isContentEditable === true`);
      if (!editing) await editor!.doubleClick(CONTENT, 'list text');
      await eventually(async () => editor!.evaluate<boolean>(
        `document.querySelector('${CONTENT}')?.isContentEditable === true`),
        'the list did not enter text editing');
      await editor!.dragSelectText(CONTENT, 'list text');
      await eventually(async () => editor!.evaluate<boolean>(
        'window.getSelection()?.isCollapsed === false'), 'the list text was not selected');
    };

    /* Type a weight into Props → Font weight and leave the field the ordinary
       way: Return commits it, Tab leaves it. */
    await selectAllText();
    const field = await editor.evaluate<boolean>(`(() => {
      const wrap = [...document.querySelectorAll('${PANEL} .field-number')]
        .find((node) => node.querySelector('span')?.textContent === 'Font weight');
      const input = wrap?.querySelector('input');
      if (!input) return false;
      input.id = 'test-font-weight';
      return true;
    })()`);
    expect(field, 'the Font weight field is in Props').toBe(true);
    await editor.click('#test-font-weight', 'Font weight field');
    await editor.evaluate('document.getElementById("test-font-weight").select()');
    await editor.typeKeys('700');
    await editor.key('Enter', 13);
    await eventually(liveHtml, 'the weight was never applied to the selected text',
      (html) => /font-weight:\s*700/.test(html));

    const beforeTab = await liveHtml();
    const selected = await editor.evaluate<string>('window.getSelection()?.toString() ?? ""');
    // Twice: the whole gesture belongs to the field, not just its first key.
    await editor.key('Tab', 9);
    await editor.key('Tab', 9);

    // Read straight after the keystroke: `execCommand('indent')` runs inside
    // the keydown handler, so a nested list would already be in the DOM.
    const afterTab = await editor.evaluate<{
      html: string;
      editing: boolean;
      text: string;
      selected: string;
    }>(`(() => {
      const content = document.querySelector('${CONTENT}');
      return {
        html: content?.innerHTML ?? '',
        editing: content?.isContentEditable === true,
        text: content?.textContent ?? '',
        selected: window.getSelection()?.toString() ?? '',
      };
    })()`);
    expect(afterTab.html, 'Tab out of the field changed the text').toBe(beforeTab);
    expect(isFlatList(afterTab.html), `Tab nested the list: ${afterTab.html}`).toBe(true);
    expect(afterTab.text.includes('\t'), 'Tab typed into the text').toBe(false);
    // The author is still formatting this text: the box they were working in
    // stays open, with the same characters selected.
    expect(afterTab.editing, 'Tab ended the text edit').toBe(true);
    expect(afterTab.selected, 'Tab lost the selection being formatted').toBe(selected);

    // The live sync carries whatever the DOM holds; give it more than its
    // interval and require the server to agree.
    await wait(600);
    const synced = await serverHtml();
    expect(isFlatList(synced), `the server received a nested list: ${synced}`).toBe(true);
    expect(synced, 'the weight never reached the server').toMatch(/font-weight:\s*700/);

    /* Tab is still the indent key for an author who is actually in the text. */
    await editor.click(CONTENT, 'back into the list');
    await eventually(async () => editor!.evaluate<boolean>(
      `document.querySelector('${CONTENT}')?.isContentEditable === true`),
      'clicking the list did not re-enter text editing');
    await editor.clickTextAtOffset(CONTENT, 14, 'second list item');
    await editor.key('Tab', 9);
    await eventually(liveHtml, 'Tab in the text no longer indents the bullet',
      (html) => count(html, '<ol') === 2);
  });
});

describe.skipIf(electronBinary)('leaving an inspector field with Tab (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
