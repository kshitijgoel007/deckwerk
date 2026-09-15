import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
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
 * The complete browser-facing Keynote workflow. The checked-in .key archive
 * is uploaded through Chromium; a deterministic adapter keeps this UI suite
 * independent of a developer's Python environment. The real importer has its
 * own sidecar suite, while this one pins down both places a person can start
 * the upload and the sharing handoff that follows it.
 */

const FIXTURE = join(process.cwd(), 'example-keynote-decks', 'empty_deck.key');
const ADMIN = 'admin@example.com';

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

async function chooseFile(cdp: Cdp, path: string): Promise<void> {
  const document = await cdp.call('DOM.getDocument');
  const { nodeId } = await cdp.call('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!nodeId) throw new Error('the import action did not create a file input');
  await cdp.call('DOM.setFileInputFiles', { nodeId, files: [path] });
}

describe.skipIf(!electronBinary)('Keynote import in the headless-server Web UI', () => {
  it('imports from the initial picker and from an already-open deck, with progress and sharing', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-keynote-import-'));
    const decksRoot = join(workDir, 'decks');
    const profileDir = join(workDir, 'electron-profile');
    const secondFixture = join(workDir, 'second-empty.key');
    await mkdir(decksRoot, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await copyFile(FIXTURE, secondFixture);
    const fixtureBytes = await readFile(FIXTURE);
    const importedSources: string[] = [];

    server = await startCollabServer({
      rootDir: decksRoot,
      clientDir: await collabClientDir(),
      host: '127.0.0.1',
      port: 0,
      accessControl: { admin: ADMIN },
      keynoteImporter: async (sourceFile, outDir) => {
        expect(await readFile(sourceFile)).toEqual(fixtureBytes);
        importedSources.push(basename(sourceFile));
        // Make the long-operation chrome observable on every machine rather
        // than depending on Python process startup or CI load.
        await new Promise<void>((resolve) => setTimeout(resolve, 800));
        await saveDeck(outDir, emptyDeck(basename(sourceFile, '.key')));
        await writeFile(join(outDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
        return { warnings: [] };
      },
    });

    const origin = `http://127.0.0.1:${server.port}`;
    browser = await launchBrowser(`${origin}/`, profileDir);
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url === `${origin}/`,
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);

    await eventually(
      async () => editor!.evaluate<boolean>(
        `document.querySelector('.deck-picker')?.textContent?.includes('Import Keynote') === true`,
      ),
      'the initial deck picker did not open',
    );
    await editor.clickByText('.deck-picker button', 'Import Keynote…', 'initial Import Keynote');
    await chooseFile(editor, FIXTURE);
    const initialProgress = await eventually(
      async () => editor!.evaluate<string>(
        `document.querySelector('.import-progress-status')?.textContent ?? ''`,
      ),
      'the initial import never showed progress',
      (text) => text.includes('empty_deck.key'),
    );
    expect(initialProgress).toContain('Converting “empty_deck.key”');

    const initialSharing = await eventually(
      async () => editor!.evaluate<{ title: string; visibility: string }>(`(() => ({
        title: document.querySelector('.share-dialog h2')?.textContent ?? '',
        visibility: document.querySelector('.share-dialog-visibility select')?.value ?? ''
      }))()`),
      'the initial import never asked about sharing',
      (state) => state.visibility === 'private',
      30_000,
    );
    expect(initialSharing.title).toContain('empty_deck');
    await editor.clickByText('.share-dialog button', 'Close', 'close initial sharing');
    await eventually(
      async () => editor!.evaluate<string>('location.search'),
      'closing sharing did not open the initial import',
      (search) => new URLSearchParams(search).get('deck') === 'empty_deck',
    );
    await eventually(
      async () => editor!.evaluate<boolean>(`(
        Boolean(document.querySelector('#canvas .slide'))
        && document.getElementById('status')?.textContent?.includes('connected as ${ADMIN}') === true
        && Boolean(document.querySelector('#toolbar .shape-menu-trigger'))
      )`),
      'the imported empty deck and its toolbar did not render',
    );

    const compactFileMenu = await editor.evaluate<boolean>(`(() => {
      const control = document.querySelector('.toolbar-compact-file-action');
      return Boolean(control && getComputedStyle(control).display !== 'none');
    })()`);
    await editor.clickByText(
      compactFileMenu ? '.toolbar-compact-file-action > button' : '.toolbar-expanded-file-actions button',
      compactFileMenu ? 'File' : 'Import…',
      'toolbar Import',
    );
    await editor.clickByText('.shape-menu-item', 'Keynote…', 'toolbar Keynote');
    await chooseFile(editor, secondFixture);
    const openDeckProgress = await eventually(
      async () => editor!.evaluate<string>(
        `document.querySelector('.import-progress-status')?.textContent ?? ''`,
      ),
      'the open-deck import never showed progress',
      (text) => text.includes('second-empty.key'),
    );
    expect(openDeckProgress).toContain('Converting “second-empty.key”');

    await eventually(
      async () => editor!.evaluate<boolean>(
        `document.querySelector('.share-dialog h2')?.textContent?.includes('second-empty') === true`,
      ),
      'the open-deck import never asked about sharing',
      Boolean,
      30_000,
    );
    await editor.choose('.share-dialog-visibility select', 'public', 'import visibility');
    await editor.clickByText('.share-dialog button', 'Save', 'save imported sharing');
    await eventually(
      async () => editor!.evaluate<string>('location.search'),
      'saving sharing did not open the second import',
      (search) => new URLSearchParams(search).get('deck') === 'second-empty',
    );

    expect(importedSources).toEqual(['empty_deck.key', 'second-empty.key']);
    const access = await fetch(`${origin}/api/access?deck=second-empty`).then((response) => response.json()) as {
      visibility: string;
    };
    expect(access.visibility).toBe('public');
  }, 120_000);
});
