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
import {
  enterEditing,
  markupProblems,
  pasteFromClipboard,
  persistedMarkupProblems,
} from './support/pasteMarkupCorpus.js';

/**
 * URLs become links the way they do in a chat app: paste a URL onto selected
 * text and the text becomes the link, type a space or Return after a URL and
 * the URL you just typed becomes one.
 *
 * Every keystroke here is real keyboard input, the paste is a real Cmd/Ctrl+V
 * off the real clipboard, and the selection is a real pointer drag — the
 * autolink hangs off the same input plumbing as typing, so a synthetic event
 * would prove nothing about the path an author takes. Both the live box and
 * the markup the collaboration server stored are checked.
 */
const DECK_ID = 'typed-links';
const TEXT_ID = 'typed-links-text';
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
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

/** The fixture deck, served by a real collaboration server. */
async function open(html: string): Promise<Cdp> {
  workDir = await mkdtemp(join(tmpdir(), 'typed-links-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const clientDir = await collabClientDir();
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const deck = emptyDeck('Typed links');
  deck.themePreset = 'basic';
  deck.slides[0].elements.push({
    id: TEXT_ID, type: 'text', x: 120, y: 160, w: 1680, h: 600,
    rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
    html, align: 'left', valign: 'top',
  } as never);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 36px/1.3 sans-serif; }',
    '',
  ].join('\n'), 'utf8');

  server = await startCollabServer({
    rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
  });
  browser = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Typed%20Links`, profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
    browser.log,
  );
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => editor!.evaluate<boolean>(
    `Boolean(document.querySelector('${CONTENT}'))`), 'the link fixture never loaded');
  return editor;
}

/** What the collaboration server has stored for the box. */
async function committedHtml(): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
  const live = await response.json() as Deck;
  const element = live.slides[0].elements.find((candidate) => candidate.id === TEXT_ID);
  return element && element.type === 'text' ? element.html : '';
}

/** Every link in the live box, as href plus the words it covers. */
async function liveLinks(cdp: Cdp): Promise<Array<{ href: string; text: string }>> {
  return cdp.evaluate(`[...document.querySelectorAll('${CONTENT} a')].map((node) => ({
    href: node.getAttribute('href'),
    text: node.textContent.replaceAll('⁠', ''),
  }))`);
}

const text = async (cdp: Cdp): Promise<string> => (await cdp.evaluate<string>(
  `document.querySelector('${CONTENT}')?.textContent ?? ''`))
  .replaceAll('⁠', '')
  .replaceAll(' ', ' ');

/** Nothing structurally wrong, on screen and in what was stored. */
async function expectSoundMarkup(cdp: Cdp, label: string): Promise<void> {
  expect(await markupProblems(cdp, CONTENT), `${label}: live markup`).toEqual([]);
  expect(
    await persistedMarkupProblems(cdp, await committedHtml()),
    `${label}: stored markup`,
  ).toEqual([]);
}

describe.skipIf(!electronBinary)('typed and pasted URLs become links', () => {
  it('links a URL when the space after it is typed, and undoes just the link', {
    timeout: 120_000,
  }, async () => {
    const cdp = await open('<p>Docs:</p>');
    await enterEditing(cdp, CONTENT);
    await cdp.key('End', 35);

    await cdp.typeKeys(' https://example.com/deck');
    expect(await liveLinks(cdp), 'a URL mid-sentence is not a link yet').toEqual([]);

    await cdp.typeKeys(' ');
    await eventually(async () => liveLinks(cdp), 'the typed URL never became a link',
      (links) => links.length === 1);
    expect(await liveLinks(cdp)).toEqual([
      { href: 'https://example.com/deck', text: 'https://example.com/deck' },
    ]);
    expect(await text(cdp), 'linking changed no characters').toBe('Docs: https://example.com/deck ');
    await eventually(committedHtml, 'the link never reached the server',
      (html) => html.includes('<a href="https://example.com/deck">'));

    // Typing continues after the link rather than inside it: the caret was
    // left outside the anchor, on the space that ended the URL.
    await cdp.typeKeys('now');
    await eventually(async () => liveLinks(cdp), 'the next word was swallowed by the link',
      (links) => links[0]?.text === 'https://example.com/deck');
    expect(await text(cdp)).toBe('Docs: https://example.com/deck now');

    // One Ctrl/Cmd+Z per step: the word, then the linkification, then the URL.
    await cdp.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => text(cdp), 'undo did not take back the word',
      (value) => value === 'Docs: https://example.com/deck ');
    await cdp.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => liveLinks(cdp), 'undo did not take back the link',
      (links) => links.length === 0);
    expect(await text(cdp), 'undoing the link kept the URL text')
      .toBe('Docs: https://example.com/deck ');
    await expectSoundMarkup(cdp, 'after typing, linking and undoing');
  });

  it('links a URL on Return and splits the paragraph outside the link', {
    timeout: 120_000,
  }, async () => {
    const cdp = await open('<p>Site:</p>');
    await enterEditing(cdp, CONTENT);
    await cdp.key('End', 35);

    await cdp.typeKeys(' www.example.org');
    await cdp.key('Enter', 13);
    await cdp.typeKeys('next line');

    await eventually(async () => liveLinks(cdp), 'Return did not link the typed URL',
      (links) => links.length === 1);
    expect(await liveLinks(cdp), 'a www. URL links to https').toEqual([
      { href: 'https://www.example.org', text: 'www.example.org' },
    ]);
    expect(await text(cdp)).toBe('Site: www.example.orgnext line');
    await eventually(async () => cdp.evaluate<number>(
      `document.querySelectorAll('${CONTENT} > p').length`),
      'Return did not split the paragraph', (count) => count === 2);
    expect(
      await cdp.evaluate<string>(`document.querySelectorAll('${CONTENT} > p')[1].innerHTML`),
      'the words typed after Return are outside the link',
    ).toBe('next line');
    await expectSoundMarkup(cdp, 'after linking on Return');
  });

  it('makes selected text the link when a URL is pasted over it', {
    timeout: 120_000,
  }, async () => {
    const cdp = await open('<p>Read the docs today</p>');
    await enterEditing(cdp, CONTENT);
    await cdp.selectTextRange(CONTENT, 'Read the '.length, 'Read the docs'.length, 'the word');

    await pasteFromClipboard(cdp, { name: 'url', text: 'https://example.com/docs', expected: [] });

    await eventually(async () => liveLinks(cdp), 'the pasted URL did not link the selection',
      (links) => links.length === 1);
    expect(await liveLinks(cdp)).toEqual([
      { href: 'https://example.com/docs', text: 'docs' },
    ]);
    expect(await text(cdp), 'the selected words stayed, the URL did not replace them')
      .toBe('Read the docs today');
    await eventually(committedHtml, 'the pasted link never reached the server',
      (html) => html.includes('<a href="https://example.com/docs">docs</a>'));

    // Undo gives the plain words back rather than dropping them.
    await cdp.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => liveLinks(cdp), 'undo did not take back the pasted link',
      (links) => links.length === 0);
    expect(await text(cdp)).toBe('Read the docs today');
    await expectSoundMarkup(cdp, 'after pasting a URL over a selection');
  });

  it('pastes a URL as plain text when nothing is selected', {
    timeout: 120_000,
  }, async () => {
    const cdp = await open('<p>Link:</p>');
    await enterEditing(cdp, CONTENT);
    await cdp.key('End', 35);

    await pasteFromClipboard(cdp, { name: 'url', text: ' https://example.com', expected: [] });
    await eventually(async () => text(cdp), 'the URL was never pasted',
      (value) => value === 'Link: https://example.com');
    expect(await liveLinks(cdp), 'a paste with no selection inserts text, not a link')
      .toEqual([]);

    // The space that ends it still links it.
    await cdp.typeKeys(' ');
    await eventually(async () => liveLinks(cdp), 'the pasted URL never linked on the space',
      (links) => links.length === 1);
    await wait(50);
    await expectSoundMarkup(cdp, 'after pasting a URL with no selection');
  });
});

describe.skipIf(electronBinary)('typed and pasted URLs become links (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
