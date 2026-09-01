import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { saveDeck } from '../../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../../src/shared/deck.js';
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
import { MARKUP_INVARIANTS } from './pasteMarkupCorpus.js';

/**
 * One real editor, driven by real keyboard and pointer input, for the list
 * editing tests.
 *
 * Everything an author does here goes through the paths the app ships: keys
 * arrive as the physical-keyboard event triples, the caret is placed by
 * clicking glyphs, and the List dropdown is changed with arrow keys the
 * browser routes into the `<select>` itself. Only fixture setup writes to the
 * store directly, which is called out where it happens.
 */

export const TEXT_ID = 'list-editing-text';
export const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
export const MOD = process.platform === 'darwin' ? 4 : 2;

/**
 * A readable picture of the block structure: one line per top-level block,
 * a header line for each list so that two adjacent lists can never look like
 * one, and indented items for sub-lists. This is the shape the assertions
 * talk about, because it is what an author sees.
 */
const OUTLINE = `(root) => {
  const clean = (value) => value.replace(/[\\s\\u00a0\\u200b\\u2060]+/g, ' ').trim();
  const ownText = (item) => {
    const clone = item.cloneNode(true);
    clone.querySelectorAll('ul, ol').forEach((nested) => nested.remove());
    return clean(clone.textContent ?? '');
  };
  const out = [];
  const walk = (list, depth) => {
    const start = list.getAttribute('start');
    out.push('  '.repeat(depth) + list.tagName.toLowerCase() + (start ? '@' + start : ''));
    for (const item of [...list.children]) {
      if (item.tagName !== 'LI') {
        out.push('  '.repeat(depth) + '?' + item.tagName.toLowerCase());
        continue;
      }
      out.push('  '.repeat(depth) + '- ' + ownText(item));
      for (const child of [...item.children]) {
        if (/^(?:UL|OL)$/.test(child.tagName)) walk(child, depth + 1);
      }
    }
  };
  for (const child of [...root.children]) {
    if (/^(?:UL|OL)$/.test(child.tagName)) walk(child, 0);
    else out.push(child.tagName.toLowerCase() + ': ' + clean(child.textContent ?? ''));
  }
  return out;
}`;

export interface ListEditingSession {
  cdp: Cdp;
  port: number;
  /** Replace the box's markup. Fixture setup only — never the thing tested. */
  reset(html: string): Promise<void>;
  /** Enter text editing with a real double-click. */
  edit(): Promise<void>;
  /** Click the glyph at a flat text offset, putting a real caret there. */
  caretAt(offset: number): Promise<void>;
  /** Click into the first item/paragraph whose text starts with `text`. */
  caretIn(text: string, where?: 'start' | 'end'): Promise<void>;
  /** The live block structure. */
  outline(): Promise<string[]>;
  /** The block structure of what the collaboration server has stored. */
  persistedOutline(): Promise<string[]>;
  /** Wait until the server has stored a box matching `accept`. */
  expectPersisted(accept: (outline: string[]) => boolean, label: string): Promise<string[]>;
  /** Structural problems in the live box, by the shared markup invariants. */
  problems(): Promise<string[]>;
  /** The same rules applied to the stored markup. */
  persistedProblems(): Promise<string[]>;
  /** Collapsed text of the box. */
  text(): Promise<string>;
  /** The live markup, for failure messages. */
  markup(): Promise<string>;
  /**
   * Choose a List dropdown option with real key presses, returning the options
   * it settled on along the way — type-ahead can only step one option per
   * press, and every stop is applied.
   */
  chooseList(style: 'None' | 'Bulleted' | 'Numbered'): Promise<string[]>;
  /** One type-ahead press at the List dropdown; the option it settled on. */
  pressList(letter: 'n' | 'b'): Promise<string>;
  /** What the List dropdown currently shows. */
  shownList(): Promise<string>;
  /** A real Ctrl/Cmd+Z. */
  undo(): Promise<void>;
}

export async function startListEditingSession(deckId: string, name: string): Promise<{
  session: ListEditingSession;
  close: () => Promise<void>;
}> {
  const workDir = await mkdtemp(join(tmpdir(), 'list-editing-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, deckId);
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const deck = emptyDeck('List editing');
  deck.themePreset = 'basic';
  deck.slides[0].elements.push({
    id: TEXT_ID, type: 'text', x: 100, y: 100, w: 1720, h: 860,
    rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
    html: '<p>Text</p>', align: 'left', valign: 'top',
  } as never);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 28px/1.4 sans-serif; }',
    '',
  ].join('\n'), 'utf8');

  const clientDir = await collabClientDir();
  let server: RunningCollabServer | null = await startCollabServer({
    rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
  });
  let browser: RunningBrowser | null = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${deckId}&name=${encodeURIComponent(name)}`, profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (candidate) => candidate.url.includes(`deck=${deckId}`),
    browser.log,
  );
  let cdp: Cdp | null = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => cdp!.evaluate<boolean>(
    `Boolean(document.querySelector('${CONTENT}'))`), 'the list fixture never loaded');
  await cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');

  const port = server.port;
  const session = buildSession(cdp, port, deckId);
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

function buildSession(cdp: Cdp, port: number, deckId: string): ListEditingSession {
  const persistedHtml = async (): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${deckId}`);
    const live = await response.json() as Deck;
    const element = live.slides[0].elements.find((candidate) => candidate.id === TEXT_ID);
    return element && (element.type === 'text' || element.type === 'html') ? element.html : '';
  };
  const outlineOf = (html: string) => cdp.evaluate<string[]>(`(() => {
    const outline = ${OUTLINE};
    const template = document.createElement('template');
    template.innerHTML = ${JSON.stringify(html)};
    const root = document.createElement('div');
    root.append(...template.content.childNodes);
    return outline(root);
  })()`);

  const session: ListEditingSession = {
    cdp,
    port,
    async reset(html) {
      // Fixture setup, not an interaction: leave editing, then write the
      // markup the scenario starts from straight into the store. The canvas
      // does not patch the element being edited, so this has to come first.
      if (await cdp.evaluate<boolean>(
        `document.querySelector('${CONTENT}')?.isContentEditable === true`,
      )) {
        await cdp.click(CONTENT, 'the text box before leaving editing');
        await cdp.key('Escape', 27);
        await eventually(async () => cdp.evaluate<boolean>(
          `document.querySelector('${CONTENT}')?.isContentEditable !== true`,
        ), 'Escape did not leave text editing');
      }
      await cdp.evaluate(`(() => {
        window.store.commit((deck) => {
          const element = deck.slides[0].elements.find(
            (candidate) => candidate.id === ${JSON.stringify(TEXT_ID)});
          element.html = ${JSON.stringify(html)};
        }, { label: 'List editing fixture' });
        return true;
      })()`);
      await eventually(async () => session.outline(), 'the fixture markup did not render',
        (lines) => lines.length > 0);
    },
    async edit() {
      await cdp.doubleClickText(CONTENT, 'text box');
      await eventually(async () => cdp.evaluate<boolean>(
        `document.querySelector('${CONTENT}')?.isContentEditable === true`,
      ), 'the text box did not enter editing');
    },
    async caretAt(offset) {
      await cdp.clickTextAtOffset(CONTENT, offset, `text offset ${offset}`);
    },
    async caretIn(text, where = 'start') {
      const offset = await cdp.evaluate<number>(`(() => {
        const root = document.querySelector('${CONTENT}');
        const flat = root?.textContent ?? '';
        return flat.indexOf(${JSON.stringify(text)});
      })()`);
      if (offset < 0) throw new Error(`no text starting ${JSON.stringify(text)} to click`);
      await cdp.clickTextAtOffset(CONTENT, offset, `the paragraph holding ${text}`);
      await cdp.key(where === 'start' ? 'Home' : 'End', where === 'start' ? 36 : 35);
    },
    outline() {
      return cdp.evaluate<string[]>(`(() => {
        const outline = ${OUTLINE};
        const root = document.querySelector('${CONTENT}');
        return root ? outline(root) : ['the text box is gone'];
      })()`);
    },
    async persistedOutline() {
      return outlineOf(await persistedHtml());
    },
    async expectPersisted(accept, label) {
      return eventually(async () => session.persistedOutline(),
        `${label}: the server never stored it`, accept, 15_000);
    },
    problems() {
      return cdp.evaluate<string[]>(`(() => {
        const check = ${MARKUP_INVARIANTS};
        const root = document.querySelector('${CONTENT}');
        return root ? check(root) : ['the text box is gone'];
      })()`);
    },
    async persistedProblems() {
      const html = await persistedHtml();
      return cdp.evaluate<string[]>(`(() => {
        const check = ${MARKUP_INVARIANTS};
        const template = document.createElement('template');
        template.innerHTML = ${JSON.stringify(html)};
        const root = document.createElement('div');
        root.append(...template.content.childNodes);
        return check(root);
      })()`);
    },
    markup() {
      return cdp.evaluate<string>(
        `document.querySelector('${CONTENT}')?.innerHTML ?? ''`);
    },
    async text() {
      const value = await cdp.evaluate<string>(
        `document.querySelector('${CONTENT}')?.textContent ?? ''`);
      return value.replace(/[\s\u00a0\u200b\u2060]+/g, ' ').trim();
    },
    async chooseList(style) {
      // Type-ahead always moves to the *next* matching option, so asking for
      // the option already showing would walk away from it and come back,
      // applying something else on the way. Nothing to press is nothing to do.
      if (await session.shownList() === style) return [];
      const walk = await cdp.chooseByKeys(LIST_FIELD, style, `the List dropdown (${style})`);
      // The change handler runs synchronously; the caret goes back into the
      // box, and the panel redraws from the new markup.
      await wait(120);
      return walk;
    },
    async pressList(letter) {
      const value = await cdp.pressOptionKey(LIST_FIELD, letter, 'the List dropdown');
      await wait(120);
      return value;
    },
    async shownList() {
      await listFieldPresent(cdp);
      return cdp.evaluate<string>(`document.querySelector('${LIST_FIELD}').value`);
    },
    async undo() {
      await cdp.chord('z', 'KeyZ', 90, MOD);
      await wait(200);
    },
  };
  return session;
}

/**
 * The inspector's List `<select>`. Addressed by the class the panel puts on
 * the field, because applying an option redraws the panel and replaces the
 * element — an id assigned by the test would not survive the first press.
 */
const LIST_FIELD = '#inspector .text-list-style select';

async function listFieldPresent(cdp: Cdp): Promise<void> {
  const found = await cdp.evaluate<boolean>(
    `Boolean(document.querySelector('${LIST_FIELD}'))`);
  expect(found, 'the inspector List control is missing').toBe(true);
}
