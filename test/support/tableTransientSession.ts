import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { saveDeck } from '../../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { emptyDeck, type Deck, type SlideElement } from '../../src/shared/deck.js';
import { themeById, themeStyleOf } from '../../src/shared/themes.js';
import type { AgentOperation } from '../../src/shared/agent.js';
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
 * Fixture and plumbing for the table/transient-commit bug hunt: one collab
 * server, one real Electron browser client driven by genuine input, and — for
 * multi-author scenarios — additional lightweight peers that speak the real
 * WebSocket wire protocol (hello → welcome → txn), exactly the frames a second
 * browser would send, without the cost of a second Chromium.
 */

export const TABLE_ID = 'bug-table';
export const NORMAL_ID = 'bug-normal';
export const SECOND_ID = 'bug-second';
export const THIRD_ID = 'bug-third';

/** The table's authored height; deliberately not the laid-out height. */
export const FIXTURE_TABLE_H = 400;

export const TABLE_HTML =
  '<table><colgroup>'
  + '<col style="width: 66.666%;"><col style="width: 33.333%;"></colgroup>'
  + '<tbody>'
  + '<tr><td>Alpha</td><td>Bravo</td></tr>'
  + '<tr><td>Charlie</td><td>Delta</td></tr>'
  + '<tr><td>Echo</td><td>Foxtrot</td></tr>'
  + '</tbody></table>';

export const ON_CANVAS = (id: string) => `#canvas [data-element-id="${id}"]`;
export const CONTENT = (id: string) => `${ON_CANVAS(id)} .text-content`;
export const TABLE_CELL = (row: number, column: number) =>
  `${CONTENT(TABLE_ID)} tbody tr:nth-child(${row + 1}) td:nth-child(${column + 1})`;

/** CDP modifier mask: Meta on macOS, Control elsewhere. */
export const MOD = process.platform === 'darwin' ? 4 : 2;

/** Typing runs seal after 600 ms of idle; wait comfortably past that. */
export const SEAL_MS = 900;

const TYPING_SENTINEL = '⁠';

export function plainTextOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll(' ', ' ')
    .replaceAll(TYPING_SENTINEL, '');
}

export function fixtureElements(): SlideElement[] {
  const text = (id: string, x: number, y: number, html: string): SlideElement => ({
    id, type: 'text', x, y, w: 700, h: 130, rot: 0, z: 1, opacity: 1,
    class: ['role-body'], style: { 'font-family': 'Arial' }, html,
    align: 'left', valign: 'top',
  } as SlideElement);
  const table = {
    ...text(TABLE_ID, 80, 120, TABLE_HTML),
    h: FIXTURE_TABLE_H,
    table: { columnWidths: [2, 1], autoHeight: true },
  } as SlideElement;
  return [
    table,
    text(NORMAL_ID, 900, 120, '<p>Normal fixture text</p>'),
    text(SECOND_ID, 900, 360, '<p>Second fixture text</p>'),
    text(THIRD_ID, 900, 600, '<p>Third fixture text</p>'),
  ];
}

export interface TableSession {
  cdp: Cdp;
  port: number;
  deckId: string;
  deck(): Promise<Deck>;
  element(id: string): Promise<SlideElement>;
  elementHtml(id: string): Promise<string>;
  /** Poll until two consecutive persisted decks agree, then return the deck. */
  settle(label: string): Promise<Deck>;
  /** The collab bridge's local undo stack labels, oldest first. */
  undoLabels(): Promise<string[]>;
  editing(selector: string): Promise<boolean>;
  enterEditing(id: string): Promise<void>;
  undo(): Promise<void>;
}

export async function startTableSession(deckId: string, name: string): Promise<{
  session: TableSession;
  close: () => Promise<void>;
}> {
  const workDir = await mkdtemp(join(tmpdir(), 'table-transient-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, deckId);
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const deck = emptyDeck('Table transient bugs');
  deck.themePreset = 'basic';
  const basicTheme = themeById('basic');
  if (basicTheme) deck.themeStyle = themeStyleOf(basicTheme);
  deck.slides[0].elements.push(...fixtureElements());
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 36px/1.3 sans-serif; }',
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
  await eventually(async () => cdp!.evaluate<boolean>(`(
    document.documentElement.dataset.collabReady === 'true'
    && Boolean(document.querySelector('${CONTENT(TABLE_ID)} table'))
    && Boolean(document.querySelector('${CONTENT(NORMAL_ID)}'))
  )`), 'the table fixture never finished connecting');
  // Record uncaught renderer errors so tests can assert the UI never crashed.
  await cdp.evaluate(`(() => {
    window.__testErrors = window.__testErrors ?? [];
    window.addEventListener('error', (event) => window.__testErrors.push(String(event.message)));
    window.addEventListener('unhandledrejection',
      (event) => window.__testErrors.push(String(event.reason)));
    return true;
  })()`);

  const port = server.port;
  const session: TableSession = {
    cdp,
    port,
    deckId,
    async deck() {
      const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${deckId}`);
      if (!response.ok) throw new Error(`deck request failed (${response.status})`);
      return response.json() as Promise<Deck>;
    },
    async element(id) {
      const live = await session.deck();
      const found = live.slides[0].elements.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`missing ${id}`);
      return found;
    },
    async elementHtml(id) {
      const found = await session.element(id);
      return found.type === 'text' || found.type === 'html' ? found.html : '';
    },
    async settle(label) {
      const deadline = Date.now() + 12_000;
      let previous = JSON.stringify(await session.deck());
      while (Date.now() < deadline) {
        await wait(400);
        const current = JSON.stringify(await session.deck());
        if (current === previous) return JSON.parse(current) as Deck;
        previous = current;
      }
      throw new Error(`${label}: the persisted deck never settled`);
    },
    undoLabels() {
      return cdp!.evaluate<string[]>(
        `window.bridge['undoStack'].map((entry) => entry.label)`);
    },
    editing(selector) {
      return cdp!.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(selector)})?.isContentEditable === true`);
    },
    async enterEditing(id) {
      if (await session.editing(CONTENT(id))) return;
      await cdp!.doubleClickText(CONTENT(id), `${id} text`);
      await eventually(async () => session.editing(CONTENT(id)),
        `${id} did not enter text editing`);
    },
    async undo() {
      await cdp!.chord('z', 'KeyZ', 90, MOD);
      await wait(250);
    },
  };

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

/**
 * A collaborator on the real wire protocol. It performs the same handshake a
 * browser client does and can submit transactions the server broadcasts to
 * every other participant as remote edits.
 */
export class FakePeer {
  private socket: WebSocket;
  private seq = 0;
  deck: Deck | null = null;
  private welcomed: Promise<void>;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.welcomed = new Promise((resolve, reject) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as {
          kind: string; seq?: number; deck?: Deck;
        };
        if (message.kind === 'welcome') {
          this.seq = message.seq ?? 0;
          this.deck = message.deck ?? null;
          resolve();
        } else if (message.kind === 'txn' && typeof message.seq === 'number') {
          this.seq = message.seq;
        }
      });
      socket.on('error', reject);
    });
  }

  static async connect(port: number, deckId: string, name: string): Promise<FakePeer> {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(deckId)}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ kind: 'hello', version: 1, name }));
    const peer = new FakePeer(socket);
    await peer.welcomed;
    return peer;
  }

  sendTxn(label: string, ops: AgentOperation[]): void {
    this.socket.send(JSON.stringify({
      kind: 'txn',
      txnId: `fake-${Math.random().toString(36).slice(2)}`,
      baseSeq: this.seq,
      label,
      ops,
    }));
  }

  close(): void {
    this.socket.close();
  }
}
