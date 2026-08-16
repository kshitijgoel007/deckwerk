import { type FSWatcher, existsSync, watch } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import type { Deck } from '@shared/deck.js';
import { IPC } from '@shared/ipc.js';
import type {
  AgentContextDraft,
  AgentResponse,
  DeckSession,
  ImportedAsset,
  KeynoteImportResult,
  PresentationCommand,
  PresentationState,
  TrimRequest,
  TrimResult,
} from '@shared/ipc.js';
import { AgentRuntime } from './agentRuntime.js';
import { installAssetProtocol, registerAssetScheme, setDeckDir } from './assetProtocol.js';
import {
  createDeck,
  derivedAssetPath,
  ensureAgentGuide,
  importAsset,
  loadDeck,
  loadTheme,
  resolveAsset,
  saveDeck,
  saveTheme,
} from './deckStore.js';
import { exportDeck } from './exportDeck.js';
import { probeMedia, runTrim } from './ffmpeg.js';
import { importKeynote } from './keynoteImport.js';
import {
  createEditorWindow, createPresentWindow, createPresenterWindow, createTrimWindow,
} from './windows.js';

/**
 * Main process: owns the filesystem, ffmpeg and the windows. The renderer never
 * touches Node directly — everything crosses through the typed IPC in
 * `@shared/ipc`.
 */

// Must happen before `ready`.
registerAssetScheme();

/** The one deck the app has open. Present and trim windows share it. */
let session: DeckSession | null = null;
let editorWindow: BrowserWindow | null = null;
let presentWindow: BrowserWindow | null = null;
let presenterWindow: BrowserWindow | null = null;
let presentationState: PresentationState | null = null;
let trimWindow: BrowserWindow | null = null;
const agentRuntime = new AgentRuntime(() => editorWindow);

function requireSession(): DeckSession {
  if (!session) throw new Error('No deck is open');
  return session;
}

let watchers: FSWatcher[] = [];
/** Exactly what we last wrote, so the watcher can tell an echo from an edit. */
let lastSavedDeckJson: string | null = null;

function setSession(dir: string, deck: Deck): DeckSession {
  session = { dir, deck };
  setDeckDir(dir);
  watchDeck(dir, deck.theme);
  void agentRuntime.open(dir);
  // New deck, opened deck, imported deck: whichever way a deck arrives, an
  // agent asked to work on it should find instructions sitting next to it.
  void ensureAgentGuide(dir).catch((err) => console.error('Could not write AGENTS.md:', err));
  return session;
}

/**
 * Watch mode: reload when deck.json or theme.css change on disk, so an agent
 * (or a git checkout, or hand editing) shows up in the running app. Our own
 * saves also fire these events; the renderer compares content and ignores
 * echoes, which is simpler and more robust than timestamp bookkeeping.
 */
function watchDeck(dir: string, themeFile: string): void {
  for (const w of watchers) w.close();
  watchers = [];
  let deckTimer: NodeJS.Timeout | null = null;
  let themeTimer: NodeJS.Timeout | null = null;
  try {
    watchers.push(
      watch(join(dir, 'deck.json'), () => {
        // Debounced: editors and agents often write in bursts.
        if (deckTimer) clearTimeout(deckTimer);
        deckTimer = setTimeout(async () => {
          try {
            const { readFile } = await import('node:fs/promises');
            const raw = await readFile(join(dir, 'deck.json'), 'utf8');
            // Our own autosave fires this watcher too. Byte-comparing against
            // what we wrote is the only reliable echo test: comparing decks
            // fails on key order, and that false mismatch caused a full reload
            // that yanked the editor back to slide 1 a second after any edit.
            if (raw === lastSavedDeckJson) return;
            const deck = await loadDeck(dir);
            if (!session) return;
            session.deck = deck;
            broadcastDeck();
          } catch {
            // Half-written JSON mid-save; the next event will retry.
          }
        }, 200);
      }),
      watch(join(dir, themeFile), () => {
        if (themeTimer) clearTimeout(themeTimer);
        themeTimer = setTimeout(async () => {
          if (!session) return;
          const css = await loadTheme(session.dir, session.deck.theme);
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send(IPC.themeCss, css);
          }
        }, 200);
      }),
    );
  } catch {
    // A brand-new deck may not have both files yet; watching resumes on the
    // next setSession.
  }
}

/** Push deck changes to every open window so they never show stale content. */
function broadcastDeck(except?: BrowserWindow | null): void {
  if (!session) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === except || win.isDestroyed()) continue;
    win.webContents.send(IPC.deckState, session);
  }
}

/**
 * A deck folder named on the command line, if any. Used by `npm run dev -- <dir>`
 * and by opening a deck from the shell.
 */
function deckDirFromArgv(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (existsSync(join(arg, 'deck.json'))) return resolve(arg);
  }
  return null;
}

app.whenReady().then(async () => {
  installAssetProtocol();
  registerHandlers();

  const initial = deckDirFromArgv();
  if (initial) {
    try {
      setSession(initial, await loadDeck(initial));
    } catch (err) {
      console.error(`Could not open ${initial}:`, err);
    }
  }

  editorWindow = createEditorWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) editorWindow = createEditorWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void agentRuntime.close();
});

function registerHandlers(): void {
  ipcMain.handle(IPC.deckNew, async (): Promise<DeckSession | null> => {
    const res = await dialog.showSaveDialog({
      title: 'New deck',
      buttonLabel: 'Create',
      // A deck is a folder, so the dialog names a directory to create.
      properties: ['createDirectory'],
      defaultPath: 'Untitled deck',
    });
    if (res.canceled || !res.filePath) return null;
    const deck = await createDeck(res.filePath, basename(res.filePath));
    return setSession(res.filePath, deck);
  });

  ipcMain.handle(IPC.deckOpen, async (): Promise<DeckSession | null> => {
    const res = await dialog.showOpenDialog({
      title: 'Open deck',
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    return setSession(dir, await loadDeck(dir));
  });

  // Pull rather than push: a window that opens mid-session asks for the current
  // deck itself, so it can't miss a broadcast that fired before it loaded.
  ipcMain.handle(IPC.deckGet, (): DeckSession | null => session);

  ipcMain.handle(IPC.agentContextPublish, async (_event, context: AgentContextDraft) => {
    await agentRuntime.publish(context);
  });
  ipcMain.on(IPC.agentResponse, (_event, response: AgentResponse) => {
    void agentRuntime.respond(response);
  });

  ipcMain.handle(
    IPC.deckOpenPath,
    async (_e, dir: string): Promise<DeckSession> =>
      setSession(dir, await loadDeck(dir)),
  );

  ipcMain.handle(IPC.deckSave, async (event, deck: Deck): Promise<void> => {
    const s = requireSession();
    lastSavedDeckJson = await saveDeck(s.dir, deck);
    s.deck = deck;
    broadcastDeck(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.handle(IPC.deckLoadTheme, async (): Promise<string> => {
    const s = requireSession();
    return loadTheme(s.dir, s.deck.theme);
  });

  ipcMain.handle(IPC.deckSaveTheme, async (_e, css: string): Promise<void> => {
    const s = requireSession();
    await saveTheme(s.dir, s.deck.theme, css);
  });

  ipcMain.handle(
    IPC.assetImport,
    async (_e, paths: string[]): Promise<ImportedAsset[]> => {
      const s = requireSession();
      const out: ImportedAsset[] = [];
      for (const p of paths) {
        // One bad file in a multi-file drop shouldn't lose the rest.
        try {
          out.push(await importAsset(s.dir, p));
        } catch (err) {
          console.error(`Skipped ${p}:`, err);
        }
      }
      return out;
    },
  );

  ipcMain.handle(IPC.assetProbe, async (_e, src: string) => {
    const s = requireSession();
    return probeMedia(resolveAsset(s.dir, src));
  });

  ipcMain.handle(IPC.presentOpen, (_e, slideIndex: number) => {
    if (presentWindow && !presentWindow.isDestroyed()) {
      presenterWindow?.focus();
      return;
    }
    presentationState = null;
    presentWindow = createPresentWindow(slideIndex);
    presenterWindow = createPresenterWindow();
    presentWindow.on('closed', () => {
      presentWindow = null;
      if (presenterWindow && !presenterWindow.isDestroyed()) presenterWindow.close();
    });
    presenterWindow.webContents.once('did-finish-load', () => {
      if (presentationState && presenterWindow && !presenterWindow.isDestroyed()) {
        presenterWindow.webContents.send(IPC.presentState, presentationState);
      }
    });
    presenterWindow.on('closed', () => {
      presenterWindow = null;
      if (presentWindow && !presentWindow.isDestroyed()) presentWindow.close();
    });
  });
  ipcMain.on(IPC.presentCommand, (_event, command: PresentationCommand) => {
    if (command.type === 'exit') {
      presentWindow?.close();
      presenterWindow?.close();
      return;
    }
    presentWindow?.webContents.send(IPC.presentCommand, command);
  });
  ipcMain.on(IPC.presentState, (_event, state: PresentationState) => {
    presentationState = state;
    presenterWindow?.webContents.send(IPC.presentState, state);
  });

  ipcMain.handle(IPC.trimOpen, (_e, payload: { src: string; elementId: string }) => {
    if (trimWindow && !trimWindow.isDestroyed()) trimWindow.close();
    trimWindow = createTrimWindow();
    const win = trimWindow;
    win.on('closed', () => (trimWindow = null));
    // Wait for the renderer before sending, or the payload lands nowhere.
    win.webContents.once('did-finish-load', () => {
      win.webContents.send(IPC.trimOpen, payload);
    });
  });

  ipcMain.handle(
    IPC.keynoteImport,
    async (): Promise<KeynoteImportResult | null> => {
      const picked = await dialog.showOpenDialog({
        title: 'Import a Keynote presentation',
        properties: ['openFile'],
        filters: [{ extensions: ['key'], name: 'Keynote' }],
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      const keyPath = picked.filePaths[0];

      const target = await dialog.showSaveDialog({
        title: 'Save the imported deck as',
        buttonLabel: 'Import',
        defaultPath: basename(keyPath, '.key'),
        properties: ['createDirectory'],
      });
      if (target.canceled || !target.filePath) return null;

      const result = await importKeynote(keyPath, target.filePath);
      setSession(result.dir, result.deck);
      broadcastDeck();
      return result;
    },
  );

  ipcMain.handle(IPC.exportBundle, async (): Promise<string | null> => {
    const s = requireSession();
    const target = await dialog.showSaveDialog({
      title: 'Export as a standalone web page',
      buttonLabel: 'Export',
      defaultPath: `${basename(s.dir)}-web`,
      properties: ['createDirectory'],
    });
    if (target.canceled || !target.filePath) return null;
    await exportDeck(s.dir, s.deck, target.filePath);
    return target.filePath;
  });

  ipcMain.handle(IPC.trimRun, async (event, req: TrimRequest): Promise<TrimResult> => {
    const s = requireSession();
    const input = resolveAsset(s.dir, req.src);
    const { absolute, relative } = await derivedAssetPath(s.dir, req.src, 'trim');

    await runTrim(req, input, absolute, (fraction, message) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.trimProgress, { fraction, message });
      }
    });

    const info = await probeMedia(absolute);
    const result: TrimResult = { src: relative, ...info };
    // The editor is what relinks the element; the trim window only reports.
    editorWindow?.webContents.send(IPC.trimDone, result);
    return result;
  });
}
