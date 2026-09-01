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
 * Undo takes back the step you took, not the whole time you spent in the box.
 *
 * A run of typing is one step until something ends it — a word boundary, a
 * pause, Return, a paste, or switching between typing and deleting — and a
 * formatting change is always its own step. Every keystroke here is real
 * keyboard input, and every undo is a real Ctrl/Cmd+Z.
 */
const DECK_ID = 'text-undo-steps';
const TEXT_ID = 'undo-steps-text';
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
const PANEL = '#inspector';
const MOD = process.platform === 'darwin' ? 4 : 2;
const START = 'Start here.';

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

describe.skipIf(!electronBinary)('undo steps through text edits', () => {
  it('takes back one word, one pause, and one formatting change at a time', {
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'undo-steps-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Undo steps');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: TEXT_ID, type: 'text', x: 120, y: 160, w: 1680, h: 600,
      rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
      html: `<p>${START}</p>`, align: 'left', valign: 'top',
    } as never);
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #fff; color: #111827; }',
      '.role-body { font: 400 36px/1.3 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Undo%20Steps`, profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('${CONTENT}'))`), 'the undo fixture never loaded');
    await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');

    const text = async () => (await editor!.evaluate<string>(
      `document.querySelector('${CONTENT}')?.textContent ?? ''`)).replaceAll('⁠', '');
    const undo = async () => {
      await editor!.chord('z', 'KeyZ', 90, MOD);
      // The undo lands on the collaboration server, then echoes back.
      await wait(150);
    };
    const expectText = async (expected: string, label: string) => {
      await eventually(text, `${label}: text on screen`, (value) => value === expected);
      await eventually(async () => {
        const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
        const live = await response.json() as Deck;
        const element = live.slides[0].elements.find((candidate) => candidate.id === TEXT_ID);
        return element && element.type === 'text' ? element.html.replace(/<[^>]+>/g, '') : '';
      }, `${label}: text on the server`, (value) => value === expected);
    };

    await editor.doubleClickText(CONTENT, 'text box');
    await eventually(async () => editor!.evaluate<boolean>(
      `document.querySelector('${CONTENT}')?.isContentEditable === true`), 'no editing');
    await editor.key('End', 35);

    /* Three words typed as one run: three undo steps, in reverse order. */
    await editor.typeKeys(' alpha beta gamma');
    await expectText(`${START} alpha beta gamma`, 'after typing three words');
    await undo();
    await expectText(`${START} alpha beta `, 'first undo takes back the last word');
    await undo();
    await expectText(`${START} alpha `, 'second undo takes back the word before it');
    await undo();
    await expectText(`${START} `, 'third undo takes back the first word');
    await undo();
    await expectText(START, 'the fourth undo reaches the text it started from');

    /* A pause ends a run even without a word boundary. */
    await editor.click(CONTENT, 'back into the text');
    await editor.key('End', 35);
    await editor.typeKeys('one');
    await wait(900);
    await editor.typeKeys('two');
    await wait(400);
    await expectText(`${START}onetwo`, 'after typing either side of a pause');
    await undo();
    await expectText(`${START}one`, 'undo takes back only what was typed after the pause');

    /* Formatting is its own step and never swallows the typing before it. */
    await editor.dragSelectFirstWord(CONTENT, 'first word');
    await editor.click(`${PANEL} button[aria-label="Bold (Cmd/Ctrl+B)"]`, 'Bold');
    await eventually(async () => editor!.evaluate<string>(
      `document.querySelector('${CONTENT}')?.innerHTML ?? ''`),
      'bold did not apply', (html) => /font-weight/.test(html));
    await undo();
    await eventually(async () => editor!.evaluate<string>(
      `document.querySelector('${CONTENT}')?.innerHTML ?? ''`),
      'undo did not take back the bold', (html) => !/font-weight/.test(html));
    await expectText(`${START}one`, 'undoing the format kept the words');
  });
});

describe.skipIf(electronBinary)('undo steps through text edits (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
