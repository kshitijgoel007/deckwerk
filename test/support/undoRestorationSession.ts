import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * A two-textbox editor for the undo-restoration oracle: one box holding a
 * committed list, one holding committed plain paragraphs. Everything is real
 * input, and the state the oracles compare is what the collaboration server
 * has persisted — the deck an author would actually get back.
 */

export const BOX_A = 'undo-restore-list';
export const BOX_B = 'undo-restore-paragraphs';
export const CONTENT_A = `#canvas [data-element-id="${BOX_A}"] .text-content`;
export const CONTENT_B = `#canvas [data-element-id="${BOX_B}"] .text-content`;
export const MOD = process.platform === 'darwin' ? 4 : 2;

/** The typing run seals after 600 ms of idle; wait comfortably past that. */
export const SEAL_MS = 900;

const A_HTML = '<ul><li>alpha item</li><li>beta item</li><li>gamma item</li></ul>';
const B_HTML = '<p>first paragraph</p><p>second paragraph</p>';

/**
 * Normalise element markup for equality: strip the caret-anchoring word
 * joiners the editor sprinkles into live text, then round-trip through the
 * browser's own parser so attribute order and entity encoding are canonical.
 */
const NORMALIZE = `(htmls) => htmls.map((html) => {
  const template = document.createElement('template');
  template.innerHTML = String(html).replaceAll('\\u2060', '');
  return template.innerHTML;
})`;

/** One element's comparable state: everything the deck stores, html normalised. */
export type Snapshot = Record<string, string>;

export interface UndoSession {
  cdp: Cdp;
  port: number;
  deckId: string;
  /** The persisted deck as id → serialized element (html normalised). */
  snapshot(): Promise<Snapshot>;
  /** Poll until two consecutive persisted snapshots agree, then return one. */
  settle(label: string): Promise<Snapshot>;
  /** Real-time pause long enough to seal the current typing run. */
  seal(): Promise<void>;
  /** A real Ctrl/Cmd+Z. */
  undo(): Promise<void>;
  /** A real Ctrl/Cmd+Shift+Z. */
  redo(): Promise<void>;
  /** Enter editing in a box with a real double-click, if not already there. */
  edit(selector: string): Promise<void>;
  editing(selector: string): Promise<boolean>;
  /** Rendered text of a box, word joiners stripped. */
  text(selector: string): Promise<string>;
  /** Live innerHTML of a box, for failure messages. */
  liveMarkup(selector: string): Promise<string>;
}

export async function startUndoSession(deckId: string, name: string): Promise<{
  session: UndoSession;
  close: () => Promise<void>;
}> {
  const workDir = await mkdtemp(join(tmpdir(), 'undo-restore-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, deckId);
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const deck = emptyDeck('Undo restoration');
  deck.themePreset = 'basic';
  deck.slides[0].elements.push({
    id: BOX_A, type: 'text', x: 80, y: 120, w: 820, h: 820,
    rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
    html: A_HTML, align: 'left', valign: 'top',
  } as never, {
    id: BOX_B, type: 'text', x: 960, y: 120, w: 820, h: 820,
    rot: 0, z: 2, opacity: 1, class: ['role-body'], style: {},
    html: B_HTML, align: 'left', valign: 'top',
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
    `Boolean(document.querySelector('${CONTENT_A}')) && Boolean(document.querySelector('${CONTENT_B}'))`,
  ), 'the undo fixture never loaded');
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

function buildSession(cdp: Cdp, port: number, deckId: string): UndoSession {
  /** Every element, markup normalised the way the page's parser writes it. */
  const snapshotOf = async (deck: Deck): Promise<Snapshot> => {
    const elements = deck.slides.flatMap((slide, index) =>
      slide.elements.map((element) => ({ slide: index, element })));
    const htmls = elements.map(({ element }) =>
      'html' in element ? (element as { html: string }).html : '');
    const normalized = await cdp.evaluate<string[]>(
      `(${NORMALIZE})(${JSON.stringify(htmls)})`);
    const snapshot: Snapshot = { '#slides': String(deck.slides.length) };
    elements.forEach(({ slide, element }, index) => {
      const comparable = { ...element as Record<string, unknown>, html: normalized[index] };
      snapshot[`${slide}:${(element as { id: string }).id}`] = JSON.stringify(comparable);
    });
    return snapshot;
  };
  const session: UndoSession = {
    cdp,
    port,
    deckId,
    async snapshot() {
      const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${deckId}`);
      return snapshotOf(await response.json() as Deck);
    },
    async settle(label) {
      // Settled when the server holds exactly what the editor holds — the
      // moment sync is done, rather than a fixed wait per check. A deck that
      // never matches (text mid-edit is in the editor, not yet the server)
      // falls back to the server's copy holding still for 600 ms.
      const deadline = Date.now() + 12_000;
      let previous = '';
      let stableSince = Date.now();
      while (Date.now() < deadline) {
        const current = await session.snapshot();
        const live = await snapshotOf(await cdp.evaluate<Deck>('window.store.get().deck'));
        const shown = JSON.stringify(current);
        if (shown === JSON.stringify(live)) return current;
        if (shown !== previous) {
          previous = shown;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 600) {
          return current;
        }
        await wait(75);
      }
      throw new Error(`${label}: the persisted deck never settled`);
    },
    seal: () => wait(SEAL_MS),
    // Callers settle() after these; that waits for the result to sync.
    async undo() {
      await cdp.chord('z', 'KeyZ', 90, MOD);
    },
    async redo() {
      await cdp.chord('z', 'KeyZ', 90, MOD | 8);
    },
    async editing(selector) {
      return cdp.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(selector)})?.isContentEditable === true`);
    },
    async edit(selector) {
      if (await session.editing(selector)) return;
      await cdp.doubleClickText(selector, 'text box');
      await eventually(async () => session.editing(selector),
        `the box ${selector} did not enter editing`);
    },
    async text(selector) {
      const value = await cdp.evaluate<string>(
        `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
      return value.replaceAll('⁠', '');
    },
    liveMarkup(selector) {
      return cdp.evaluate<string>(
        `document.querySelector(${JSON.stringify(selector)})?.innerHTML ?? ''`);
    },
  };
  return session;
}

/** A readable unified diff of two snapshots, element by element. */
export function diffSnapshots(expected: Snapshot, observed: Snapshot): string {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(observed)])].sort();
  const lines: string[] = [];
  for (const key of keys) {
    if (expected[key] === observed[key]) continue;
    lines.push(`  ${key}:`);
    lines.push(`    expected: ${expected[key] ?? '(absent)'}`);
    lines.push(`    observed: ${observed[key] ?? '(absent)'}`);
  }
  return lines.length > 0 ? lines.join('\n') : '  (identical)';
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Poll the persisted deck until it matches `expected` or the timeout passes. */
export async function snapshotEventually(
  session: UndoSession,
  expected: Snapshot,
  timeoutMs = 8_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  let observed = await session.snapshot();
  while (!sameSnapshot(observed, expected) && Date.now() < deadline) {
    await wait(250);
    observed = await session.snapshot();
  }
  return observed;
}
