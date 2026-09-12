import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDeck } from '../../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import type { Deck } from '../../src/shared/deck.js';
import {
  Cdp,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type DevToolsTarget,
  type RunningBrowser,
} from './browserSession.js';
import { collabClientDir } from './collabClient.js';

/**
 * The web-client twin of `desktopEditorSession.ts`.
 *
 * Launches the REAL headless collaboration server hosting the production
 * browser client, seeds it with the decks a suite needs, and opens a hidden
 * Electron browser on one of them. Where a desktop suite reads `deck.json`
 * off disk to prove durability, a web suite reads the deck the server holds
 * (`fetchDeck`), which is what every peer, Present, and download would see.
 *
 * Nothing here pokes the editor: the only privileged access a suite gets is
 * the DevTools connection, and every gesture it sends is real input.
 */

export interface WebDeckFixture {
  /** Folder name under the server root and the `?deck=` id. */
  id: string;
  deck: Deck;
  /** Contents of theme.css; a plain white slide when omitted. */
  themeCss?: string;
  /** Extra files to place under the deck folder, e.g. `{ 'assets/clip.mp4': bytes }`. */
  files?: Record<string, Buffer | string>;
}

export interface WebEditorSession {
  cdp: Cdp;
  server: RunningCollabServer;
  browser: RunningBrowser;
  port: number;
  deckId: string;
  userName: string;
  decksRoot: string;
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** URL that opens `deckId` (or another deck) in the editor for `userName`. */
  editorUrl: (deckId?: string) => string;
  /** The deck as the server currently holds it. */
  fetchDeck: (deckId?: string) => Promise<Deck>;
  /** theme.css as the server currently holds it. */
  fetchTheme: (deckId?: string) => Promise<string>;
  /** Connect to another editor window/tab of this browser, e.g. one opened with `window.open`. */
  connectTarget: (match: (target: DevToolsTarget) => boolean, message?: string) => Promise<Cdp>;
  close: () => Promise<void>;
}

export const DEFAULT_THEME_CSS = [
  '.slide { background: #ffffff; color: #111827; }',
  '.role-title { font: 700 72px/1.1 sans-serif; }',
  '.role-body { font: 400 40px/1.3 sans-serif; }',
  '',
].join('\n');

/**
 * Start a server with `fixtures` and open the editor on `fixtures[0]` (or on
 * `options.open`). Resolves once the status bar says the user is connected
 * and `options.readyWhen` (default: the canvas has painted a slide) holds.
 */
export async function launchWebEditor(
  fixtures: WebDeckFixture[],
  options: {
    userName?: string;
    open?: string;
    /** Page-side expression that must be truthy before the session is handed over. */
    readyWhen?: string;
    tmpPrefix?: string;
  } = {},
): Promise<WebEditorSession> {
  if (fixtures.length === 0) throw new Error('launchWebEditor needs at least one deck');
  const userName = options.userName ?? 'Web Editor';
  const workDir = await mkdtemp(join(tmpdir(), options.tmpPrefix ?? 'web-editor-session-'));
  let server: RunningCollabServer | null = null;
  let browser: RunningBrowser | null = null;
  let cdp: Cdp | null = null;
  const connections: Cdp[] = [];
  try {
    const decksRoot = join(workDir, 'decks');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    for (const fixture of fixtures) await writeDeckFixture(decksRoot, fixture);

    const clientDir = await collabClientDir();
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    const deckId = options.open ?? fixtures[0].id;
    const editorUrl = (id = deckId) =>
      `${origin}/?deck=${encodeURIComponent(id)}&name=${encodeURIComponent(userName)}`;

    browser = await launchBrowser(editorUrl(), profileDir);
    const target = await findTarget(
      browser.debugPort,
      (t) => t.url.includes(`deck=${encodeURIComponent(deckId)}`) && !t.url.includes('present.html'),
      browser.log,
    );
    cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    connections.push(cdp);
    const ready = options.readyWhen ?? `Boolean(document.querySelector('#canvas .slide'))`;
    await eventually(async () => cdp!.evaluate<boolean>(`(() => (
      document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${userName}`)}) === true
      && Boolean(${ready})
    ))()`), 'the web editor did not finish connecting');
    // Keyboard chords and clipboard writes both want a focused document.
    await cdp.call('Page.bringToFront');
    await cdp.evaluate('window.focus()');

    const fetchDeck = async (id = deckId): Promise<Deck> => {
      const response = await fetch(`${origin}/api/deck?deck=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`deck request failed (${response.status})`);
      return response.json() as Promise<Deck>;
    };
    const fetchTheme = async (id = deckId): Promise<string> => {
      const response = await fetch(`${origin}/api/theme?deck=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`theme request failed (${response.status})`);
      return response.text();
    };
    const runningBrowser = browser;
    const connectTarget = async (match: (t: DevToolsTarget) => boolean, message = 'window'): Promise<Cdp> => {
      const found = await findTarget(runningBrowser.debugPort, match, runningBrowser.log);
      const connection = await Cdp.connect(found.webSocketDebuggerUrl!);
      connections.push(connection);
      void message;
      return connection;
    };

    return {
      cdp,
      server,
      browser,
      port: server.port,
      deckId,
      userName,
      decksRoot,
      origin,
      editorUrl,
      fetchDeck,
      fetchTheme,
      connectTarget,
      close: async () => {
        for (const connection of connections) connection.close();
        connections.length = 0;
        await stopBrowser(runningBrowser.process);
        await server?.close();
        await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
      },
    };
  } catch (error) {
    for (const connection of connections) connection.close();
    cdp?.close();
    await stopBrowser(browser?.process ?? null);
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

/** Write one deck folder the way the server expects to find it. */
export async function writeDeckFixture(decksRoot: string, fixture: WebDeckFixture): Promise<string> {
  const deckDir = join(decksRoot, fixture.id);
  await mkdir(deckDir, { recursive: true });
  await saveDeck(deckDir, fixture.deck);
  await writeFile(join(deckDir, 'theme.css'), fixture.themeCss ?? DEFAULT_THEME_CSS, 'utf8');
  for (const [relative, bytes] of Object.entries(fixture.files ?? {})) {
    const path = join(deckDir, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
  }
  return deckDir;
}
