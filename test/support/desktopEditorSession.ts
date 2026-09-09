import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDeck } from '../../src/main/deckStore.js';
import { emptyDeck } from '../../src/shared/deck.js';
import {
  Cdp,
  eventually,
  findTarget,
  stopBrowser,
} from './browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './desktopApp.js';

/**
 * Launch the REAL desktop app (main process, preload, autosave — no collab
 * live-sync) against a temporary deck, the same way
 * test/desktopTextFormattingBrowser.test.ts does. The desktop shell is the
 * one where `liveTextSync` is off, so the only routes typed text has into the
 * store are sealTextChunk and commitTextEdit — the durability surface under
 * test in the mode/focus bug hunt.
 */

export interface DesktopEditor {
  cdp: Cdp;
  deckDir: string;
  close: () => Promise<void>;
}

export async function launchDesktopEditor(
  textId: string,
  textHtml: string,
): Promise<DesktopEditor> {
  const workDir = await mkdtemp(join(tmpdir(), 'mode-focus-desktop-'));
  const appDir = join(workDir, 'app');
  const deckDir = join(workDir, 'deck');
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(appDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  await materializeDesktopApp(appDir, 'deckwerk-mode-focus-test');

  const deck = emptyDeck('Mode focus durability');
  deck.slides[0].elements.push({
    id: textId,
    type: 'text',
    x: 140,
    y: 150,
    w: 1640,
    h: 500,
    rot: 0,
    z: 1,
    opacity: 1,
    class: ['role-body'],
    style: {},
    html: textHtml,
    align: 'left',
    valign: 'top',
  } as never);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 42px/1.35 Arial, sans-serif; }',
    '',
  ].join('\n'), 'utf8');

  const app = await launchDesktopApp(appDir, [deckDir], { profileDir });
  const appProcess: ChildProcess = app.process;
  const debugPort = app.debugPort;
  const appLog = app.log;
  const target = await findTarget(
    debugPort,
    isEditorTarget,
    appLog,
    20_000,
  );
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  const content = `#canvas [data-element-id="${textId}"] .text-content`;
  await eventually(async () => cdp.evaluate<boolean>(`window.api.getDeck().then(
    (session) => session?.dir === ${JSON.stringify(deckDir)}
      && Boolean(document.querySelector(${JSON.stringify(content)}))
  )`), 'the desktop editor did not open the durability fixture');
  await cdp.call('Page.bringToFront');
  await cdp.evaluate('window.focus()');

  return {
    cdp,
    deckDir,
    close: async () => {
      cdp.close();
      await stopBrowser(appProcess);
      await rm(workDir, { recursive: true, force: true });
    },
  };
}
