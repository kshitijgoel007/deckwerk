import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'electron-vite';
import { build as buildVite } from 'vite';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  collectProcessOutput,
  electronBinary,
  eventually,
  findTarget,
  freePort,
  stopBrowser,
} from './support/browserSession.js';

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
let collaboration: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  collaboration?.close();
  editor = null;
  collaboration = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('desktop collaboration handoff', () => {
  it('switches from an embedded Agent session when Collaborate is clicked', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-collaboration-handoff-'));
    const checkout = process.cwd();
    const appDir = join(workDir, 'app');
    const outDir = join(appDir, 'out');
    const deckDir = join(workDir, 'handoff-deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(appDir, 'dist'), { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await build({
      root: checkout,
      configFile: join(checkout, 'electron.vite.config.ts'),
      logLevel: 'silent',
      build: { outDir },
    });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({
      name: 'deckwerk-collaboration-handoff-test',
      private: true,
      type: 'module',
      main: 'out/main/index.js',
    }), 'utf8');
    await symlink(join(checkout, 'node_modules'), join(appDir, 'node_modules'), 'dir');
    await buildVite({
      configFile: join(checkout, 'vite.collab.config.ts'),
      logLevel: 'silent',
      build: { outDir: join(appDir, 'dist', 'collab') },
    });

    const deck = emptyDeck('Collaboration handoff');
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

    const debugPort = await freePort();
    appProcess = spawn(electronBinary, [
      appDir,
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      deckDir,
    ], {
      cwd: checkout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    const appLog = collectProcessOutput(appProcess);
    const editorTarget = await findTarget(
      debugPort,
      (candidate) => candidate.url.includes('/editor/index.html'),
      appLog,
      20_000,
    );
    editor = await Cdp.connect(editorTarget.webSocketDebuggerUrl!);
    await eventually(
      async () => editor!.evaluate<boolean>(`window.api.getDeck().then((session) => {
        const trigger = document.querySelector('#collaborate-trigger');
        const rect = trigger?.getBoundingClientRect();
        return session?.dir === ${JSON.stringify(deckDir)}
          && Boolean(rect && rect.width > 0 && rect.height > 0);
      })`),
      'desktop editor did not expose the Collaborate control',
    );

    // Reproduce the broken state without requiring a signed-in Codex account:
    // the IPC call establishes the same hidden authoritative server used by
    // the Agent panel.
    await editor.evaluate(`window.api.startAgentSession({
      agent: true,
      activeSlideId: ${JSON.stringify(deck.slides[0]!.id)},
      selectedSlideIds: [],
      selectedElementIds: []
    }).then((session) => session.active)`);
    await editor.click('#collaborate-trigger', 'Collaborate');

    const collaborationTarget = await findTarget(
      debugPort,
      (candidate) => candidate.url.startsWith('http://127.0.0.1:')
        && candidate.url.includes('deck=handoff-deck'),
      appLog,
      20_000,
    );
    collaboration = await Cdp.connect(collaborationTarget.webSocketDebuggerUrl!);
    const title = await eventually(
      async () => collaboration!.evaluate<string>('window.store?.get?.().deck.title ?? ""'),
      'Collaborate did not hand off to the hosted browser editor',
    );
    expect(title).toBe('Collaboration handoff');
    expect(await collaboration.evaluate<boolean>(
      'Boolean(document.querySelector("#end-collaboration-trigger"))',
    )).toBe(true);
    expect(await collaboration.evaluate<string>(
      `[...document.querySelectorAll('#toolbar button')]
        .find((button) => button.textContent === 'Agent…')?.textContent ?? ''`,
    )).toBe('Agent…');
    expect(await collaboration.evaluate<Record<string, unknown>>(
      'fetch("/api/config").then((response) => response.json()).then((config) => config.sharedAgent)',
    )).toMatchObject({ enabled: true, name: 'Agent', personal: true, canManageAccount: true });
    await collaboration.click('#agent-chat-trigger', 'Agent');
    expect(await collaboration.evaluate<boolean>(
      'document.querySelector("#agent-chat-panel")?.hidden === false',
    )).toBe(true);
  }, 30_000);
});

describe.skipIf(electronBinary)('desktop collaboration handoff (skipped)', () => {
  it('needs the Electron binary', () => expect(electronBinary).toBe(''));
});
