import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveDeck, serializeDeck } from '../src/main/deckStore.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  collectProcessOutput,
  electronBinary,
  eventually,
  findTarget,
  freePort,
  stopBrowser,
  wait,
} from './support/browserSession.js';

/**
 * Which deck does Present actually present?
 *
 * Every route that changes the open document -- New, Open, Save As, Import --
 * hands the main process a new session, and the presentation windows read that
 * session rather than anything the editor holds. Nothing checked that the two
 * agree, and two writes belonging to the deck being replaced could land in the
 * session that replaced it, putting the *previous* deck on the projector: an
 * autosave still in flight across the switch, and a file-watcher reload whose
 * debounce had already been scheduled when the watcher was closed.
 *
 * These tests drive the real toolbar in the real app and read what the real
 * audience window renders, so a mismatch between the editor and the projector
 * cannot pass. Only the two things a test cannot supply are scripted: the
 * native file panels (see src/main/dialogs.ts) and Apple's format decoder,
 * which is replaced by a sidecar stub speaking the same protocol. Everything
 * from the IPC handler inwards is the shipping code.
 */

const requiredBuildOutputs = [
  'out/main/index.js',
  'out/preload/index.mjs',
  'out/renderer/editor/index.html',
  'out/renderer/present/index.html',
];
const runnable = Boolean(electronBinary)
  && process.platform !== 'win32'
  && requiredBuildOutputs.every((path) => existsSync(join(process.cwd(), path)));

const MARKER_ID = 'deck-marker';

/** A deck whose only content is a marker the audience window can be read for. */
function markerDeck(title: string, marker: string): Deck {
  const deck = emptyDeck(title);
  deck.slides[0].elements.push({
    id: MARKER_ID,
    type: 'text',
    x: 160,
    y: 400,
    w: 1600,
    h: 240,
    rot: 0,
    z: 1,
    opacity: 1,
    class: [],
    style: {},
    html: marker,
    align: 'center',
    valign: 'middle',
  });
  return deck;
}

const THEME = [
  '.slide { background: #ffffff; color: #111111; }',
  '.element-text { font: 700 72px/1.1 Arial, sans-serif; }',
  '',
].join('\n');

async function writeMarkerDeck(dir: string, title: string, marker: string): Promise<Deck> {
  const deck = markerDeck(title, marker);
  await mkdir(dir, { recursive: true });
  await saveDeck(dir, deck);
  await writeFile(join(dir, 'theme.css'), THEME, 'utf8');
  return deck;
}

let workDir = '';
let appProcess: ChildProcess | null = null;
let appLog: () => string = () => '';
let editor: Cdp | null = null;
let debugPort = 0;
let dialogQueue = '';
let alphaDir = '';
let bravoDir = '';
let charlieDir = '';
let deltaDir = '';
let keyFile = '';

/** Pre-answer the next native file panels, in the order the app will open them. */
async function scriptDialogs(...answers: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(dialogQueue, JSON.stringify(answers), 'utf8');
}

/**
 * Click Present, read what the audience window renders, then close it.
 *
 * The deck folder is read back through the same bridge the window itself used,
 * so a window showing the right slides from the wrong deck cannot pass either.
 */
async function present(): Promise<{ marker: string | null; dir: string | null }> {
  await editor!.clickByText('button', 'Present', 'Present');
  const target = await findTarget(
    debugPort,
    (candidate) => candidate.url.includes('/present/index.html'),
    appLog,
  );
  const audience = await Cdp.connect(target.webSocketDebuggerUrl!);
  try {
    // Wait for a rendered slide rather than for the expected content: a
    // window that comes up with the wrong deck must fail the assertion below,
    // not be waited out until it happens to be right.
    const rendered = await eventually(
      async () => audience.evaluate<{ marker: string | null; dir: string | null; slide: boolean }>(`
        window.api.getDeck().then((session) => ({
          marker: document.querySelector('[data-element-id="${MARKER_ID}"]')?.textContent ?? null,
          dir: session?.dir ?? null,
          slide: Boolean(document.querySelector('.slide')),
        }))
      `),
      'the audience window never rendered a slide',
      (value) => value.slide && Boolean(value.dir),
    );
    return { marker: rendered.marker, dir: rendered.dir };
  } finally {
    await audience.evaluate('window.close()').catch(() => {});
    audience.close();
    // The next Present must open a window rather than focus this one.
    await eventually(
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as
          Array<{ url: string }>;
        return !list.some((candidate) => candidate.url.includes('/present/index.html'));
      },
      'the audience window did not close',
    );
  }
}

/** What the editor itself has open, for comparison against the projector. */
function editorState(): Promise<{ marker: string | null; dir: string | null }> {
  return editor!.evaluate<{ marker: string | null; dir: string | null }>(`
    window.api.getDeck().then((session) => ({
      marker: document.querySelector('#canvas [data-element-id="${MARKER_ID}"]')?.textContent ?? null,
      dir: session?.dir ?? null,
    }))
  `);
}

async function editorShows(marker: string, message: string): Promise<void> {
  await eventually(
    async () => editor!.evaluate<string | null>(
      `document.querySelector('#canvas [data-element-id="${MARKER_ID}"]')?.textContent ?? null`,
    ),
    message,
    (value) => value === marker,
    20_000,
  );
}

/**
 * A stand-in for the Keynote sidecar: it speaks the importer's protocol (a
 * progress line on stderr, the deck as JSON on stdout, the converted folder on
 * disk) without needing Apple's format decoder or a Python environment.
 */
async function installImporterStub(appDir: string, outDir: string, deck: Deck): Promise<void> {
  const payload = join(appDir, 'imported-payload.json');
  await writeFile(payload, JSON.stringify({
    dir: outDir,
    deck,
    report: { slides: deck.slides.length, elements: 1, unsupported: {}, warnings: [] },
  }), 'utf8');
  await mkdir(join(appDir, 'importers', 'keynote'), { recursive: true });
  // Only its existence is checked; the interpreter below never reads it.
  await writeFile(join(appDir, 'importers', 'keynote', 'import_keynote.py'), '', 'utf8');
  await mkdir(join(appDir, '.venv-import', 'bin'), { recursive: true });
  const stub = join(appDir, '.venv-import', 'bin', 'python');
  await writeFile(stub, [
    '#!/bin/sh',
    '# argv: <script> <keyPath> --out <outDir>',
    'set -e',
    'out="$4"',
    'mkdir -p "$out"',
    `cp ${JSON.stringify(join(appDir, 'imported-deck.json'))} "$out/deck.json"`,
    `cp ${JSON.stringify(join(appDir, 'imported-theme.css'))} "$out/theme.css"`,
    'printf "@progress 0.5 Converting slides\\n" >&2',
    `cat ${JSON.stringify(payload)}`,
    '',
  ].join('\n'), 'utf8');
  await chmod(stub, 0o755);
  await writeFile(join(appDir, 'imported-deck.json'), serializeDeck(deck), 'utf8');
  await writeFile(join(appDir, 'imported-theme.css'), THEME, 'utf8');
}

describe.skipIf(!runnable)('presenting after switching decks', () => {
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deck-switch-present-'));
    const appDir = join(workDir, 'app');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    // The app runs from the checkout's build, but out of its own working
    // directory, which is where the importer stub is found.
    await symlink(join(process.cwd(), 'out'), join(appDir, 'out'), 'dir');
    await symlink(join(process.cwd(), 'node_modules'), join(appDir, 'node_modules'), 'dir');
    await writeFile(join(appDir, 'package.json'), JSON.stringify({
      name: 'deckwerk-deck-switch-test',
      private: true,
      type: 'module',
      main: 'out/main/index.js',
    }), 'utf8');

    alphaDir = join(workDir, 'alpha');
    bravoDir = join(workDir, 'bravo');
    charlieDir = join(workDir, 'charlie');
    deltaDir = join(workDir, 'delta');
    keyFile = join(workDir, 'charlie.key');
    await writeMarkerDeck(alphaDir, 'Alpha', 'ALPHA DECK');
    await writeMarkerDeck(bravoDir, 'Bravo', 'BRAVO DECK');
    await writeFile(keyFile, 'not a real Keynote archive', 'utf8');
    await installImporterStub(appDir, charlieDir, markerDeck('Charlie', 'CHARLIE IMPORT'));

    dialogQueue = join(workDir, 'dialogs.json');
    await scriptDialogs();

    debugPort = await freePort();
    appProcess = spawn(electronBinary, [
      appDir,
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      alphaDir,
    ], {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        DECKWERK_TEST_DIALOGS: dialogQueue,
      },
    });
    appLog = collectProcessOutput(appProcess);
    const target = await findTarget(
      debugPort,
      (candidate) => candidate.url.includes('/editor/index.html'),
      appLog,
      30_000,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await editorShows('ALPHA DECK', 'the editor did not open the first deck');
  }, 90_000);

  afterAll(async () => {
    editor?.close();
    editor = null;
    await stopBrowser(appProcess);
    appProcess = null;
    if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
    workDir = '';
  }, 30_000);

  it('presents the deck the app was opened with', async () => {
    expect(await present()).toEqual({ marker: 'ALPHA DECK', dir: alphaDir });
  }, 60_000);

  it('presents the newly opened deck, not the one it replaced', async () => {
    await scriptDialogs({ canceled: false, filePaths: [bravoDir] });
    await editor!.clickByText('button', 'Open', 'Open');
    await editorShows('BRAVO DECK', 'the editor did not open the second deck');

    expect(await present()).toEqual({ marker: 'BRAVO DECK', dir: bravoDir });
  }, 60_000);

  it('presents an imported deck, not the one that was open before the import', async () => {
    await scriptDialogs(
      { canceled: false, filePaths: [keyFile] },
      { canceled: false, filePath: charlieDir },
    );
    await editor!.clickByText('.shape-menu-trigger', 'Import…', 'Import…');
    await editor!.clickByText('.shape-menu-item', 'Keynote…', 'Keynote…');
    await editorShows('CHARLIE IMPORT', 'the editor did not open the imported deck');

    expect(await present()).toEqual({ marker: 'CHARLIE IMPORT', dir: charlieDir });
  }, 60_000);

  it('keeps presenting the imported deck once the deck it replaced settles', async () => {
    // The route into the original bug: the replaced deck's own watcher fired
    // after the switch. Give every debounce and reload belonging to it time to
    // land, then check that the projector still gets the imported deck.
    await wait(1500);
    expect(await editorState()).toEqual({ marker: 'CHARLIE IMPORT', dir: charlieDir });
    expect(await present()).toEqual({ marker: 'CHARLIE IMPORT', dir: charlieDir });
  }, 60_000);

  it('never presents a reload belonging to the deck that was replaced', async () => {
    const previous = await editor!.evaluate<string>(
      'window.api.getDeck().then((session) => session.dir)',
    );
    // An outside writer -- an agent, a git checkout -- keeps changing the open
    // deck while the author opens a different one. Closing a file watcher does
    // not cancel the reload it already scheduled, so one belonging to the deck
    // being replaced is in flight exactly across the switch.
    const stale = serializeDeck(markerDeck('Stale', 'STALE EXTERNAL'));
    let churning = true;
    const churn = (async () => {
      while (churning) {
        await writeFile(join(previous, 'deck.json'), stale, 'utf8');
        await wait(25);
      }
    })();

    await scriptDialogs({ canceled: false, filePaths: [alphaDir] });
    await editor!.clickByText('button', 'Open', 'Open');
    await editorShows('ALPHA DECK', 'the editor did not open the deck that was asked for');
    churning = false;
    await churn;
    // Longer than the watcher's debounce: any reload still owed fires by now.
    await wait(1000);

    expect(await editorState()).toEqual({ marker: 'ALPHA DECK', dir: alphaDir });
    expect(await present()).toEqual({ marker: 'ALPHA DECK', dir: alphaDir });
  }, 60_000);

  it('never presents the deck a save in flight belonged to', async () => {
    await scriptDialogs({ canceled: false, filePaths: [bravoDir] });
    await editor!.clickByText('button', 'Open', 'Open');
    await editorShows('BRAVO DECK', 'the editor did not open the second deck');

    // An autosave issued for the previous deck, landing after the switch. It
    // must be refused: writing it would put those slides in the new deck's
    // folder and, because Present reads this session, on the projector.
    const stale = markerDeck('Alpha', 'ALPHA STALE');
    const refused = await editor!.evaluate<string | null>(`
      window.api.saveDeck(${JSON.stringify(alphaDir)}, ${JSON.stringify(stale)})
        .then(() => null, (error) => String(error.message ?? error))
    `);
    expect(refused).toMatch(/no longer open/);

    expect(await present()).toEqual({ marker: 'BRAVO DECK', dir: bravoDir });
  }, 60_000);

  it('re-points an audience window left open across a deck switch', async () => {
    // Present, then switch decks without closing the projector. Present again
    // focuses the window that is already up rather than opening a second one,
    // so that window has to be showing the deck the author now has open.
    await editor!.clickByText('button', 'Present', 'Present');
    const target = await findTarget(
      debugPort,
      (candidate) => candidate.url.includes('/present/index.html'),
      appLog,
    );
    const audience = await Cdp.connect(target.webSocketDebuggerUrl!);
    try {
      await eventually(
        async () => audience.evaluate<boolean>("Boolean(document.querySelector('.slide'))"),
        'the audience window never rendered a slide',
      );
      await scriptDialogs({ canceled: false, filePaths: [bravoDir] });
      await editor!.clickByText('button', 'Open', 'Open');
      await editorShows('BRAVO DECK', 'the editor did not open the second deck');
      await editor!.clickByText('button', 'Present', 'Present');

      const shown = await eventually(
        async () => audience.evaluate<{ marker: string | null; dir: string | null }>(`
          window.api.getDeck().then((session) => ({
            marker: document.querySelector('[data-element-id="${MARKER_ID}"]')?.textContent ?? null,
            dir: session?.dir ?? null,
          }))
        `),
        'the open audience window never followed the deck switch',
        (value) => value.marker !== null,
        5_000,
      ).catch((error: Error) => error.message);
      expect(shown).toEqual({ marker: 'BRAVO DECK', dir: bravoDir });
    } finally {
      await audience.evaluate('window.close()').catch(() => {});
      audience.close();
      await eventually(
        async () => {
          const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as
            Array<{ url: string }>;
          return !list.some((candidate) => candidate.url.includes('/present/index.html'));
        },
        'the audience window did not close',
      );
    }
  }, 60_000);

  it('presents a deck created after an import', async () => {
    await scriptDialogs({ canceled: false, filePath: deltaDir });
    await editor!.clickByText('button', 'New', 'New');
    await eventually(
      async () => editor!.evaluate<string | null>(
        'window.api.getDeck().then((session) => session?.dir ?? null)',
      ),
      'the editor did not create a new deck',
      (value) => value === deltaDir,
      20_000,
    );

    const presented = await present();
    expect(presented.dir).toBe(deltaDir);
    expect(presented.marker).toBe(null);
  }, 60_000);
});

describe.skipIf(runnable)('presenting after switching decks (skipped)', () => {
  it('needs a built Electron app', () => {
    expect(runnable).toBe(false);
  });
});
