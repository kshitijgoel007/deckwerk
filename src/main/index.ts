import { type FSWatcher, existsSync, mkdirSync, watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { BrowserWindow, app, clipboard, dialog, ipcMain, screen, shell } from 'electron';
import type { Deck } from '@shared/deck.js';
import {
  CLIPBOARD_FORMAT,
  type ClipboardPayload,
  type ClipboardWriteRequest,
  collectAssetSrcs,
  parseClipboardPayload,
  rewriteAssetSrcs,
} from '@shared/clipboard.js';
import { IPC } from '@shared/ipc.js';
import type {
  AgentContextDraft,
  AgentResponse,
  DeckSession,
  ImportedAsset,
  KeynoteImportResult,
  PresentationCommand,
  PresentationState,
  PdfExportRequest,
  PresentOptions,
  TrimRequest,
  TrimResult,
  WorkflowStartRequest,
  WorkflowStartResult,
} from '@shared/ipc.js';
import { startWorkflow } from './workflow.js';
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
import { HTML_EDIT_DIR, writeHtmlScope } from './htmlAuthoring.js';
import {
  createCollabHostWindow, createEditorWindow, createPdfWindow, createPresentWindow, createPresenterWindow, createTrimWindow,
} from './windows.js';
import {
  defaultClientDir, startCollabServer, type RunningCollabServer,
} from '../server/collabServer.js';

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
/** Live while the open deck is being shared for co-editing. */
let collabServer: RunningCollabServer | null = null;
let collabWindow: BrowserWindow | null = null;
let quitting = false;
const agentRuntime = new AgentRuntime(() => editorWindow);

function requireSession(): DeckSession {
  if (!session) throw new Error('No deck is open');
  return session;
}

let watchers: FSWatcher[] = [];
/** Exactly what we last wrote, so the watcher can tell an echo from an edit. */
let lastSavedDeckJson: string | null = null;
/** HTML the editor itself just exported; its watcher event is an echo, not an edit. */
const lastWrittenHtml = new Map<string, string>();

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
  const htmlTimers = new Map<string, NodeJS.Timeout>();
  try {
    const editDir = join(dir, HTML_EDIT_DIR);
    mkdirSync(editDir, { recursive: true });
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
      // Saving an authoring file is the everyday way slides change, so it must
      // be cheap: the contents go straight to the editor's renderer, which is
      // already a browser and lays them out in an offscreen iframe. Nothing is
      // spawned, and the compile is measured by the engine that will draw it.
      watch(editDir, (_event, filename) => {
        if (!filename || !String(filename).endsWith('.html')) return;
        const path = join(editDir, String(filename));
        const previous = htmlTimers.get(path);
        if (previous) clearTimeout(previous);
        htmlTimers.set(path, setTimeout(async () => {
          htmlTimers.delete(path);
          try {
            const { readFile } = await import('node:fs/promises');
            const first = await readFile(path, 'utf8');
            // A save is not necessarily atomic: reading during a large write
            // hands back a truncated document, which once compiled into an
            // empty slide. Read twice with a pause — a file still growing
            // differs between the reads — and skip a document that is visibly
            // cut off; the write's own final event will retry it complete.
            await new Promise((settle) => setTimeout(settle, 150));
            const contents = await readFile(path, 'utf8');
            if (contents !== first) return;
            if (/<html[\s>]/i.test(contents) && !/<\/html>/i.test(contents)) return;
            // The editor's own export lands here too; that event is an echo.
            if (lastWrittenHtml.get(path) === contents) {
              lastWrittenHtml.delete(path);
              return;
            }
            if (!session || session.dir !== dir || !editorWindow || editorWindow.isDestroyed()) return;
            editorWindow.webContents.send(IPC.htmlEdit, { path, contents });
          } catch (error) {
            console.error(`Could not read HTML edit ${path}:`, error);
          }
        }, 200));
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

  screen.on('display-removed', () => {
    if (!presentWindow || presentWindow.isDestroyed()) return;
    const primary = screen.getPrimaryDisplay();
    presentWindow.setFullScreen(false);
    presentWindow.setBounds(primary.bounds);
    presentWindow.setFullScreen(true);
    if (presenterWindow && !presenterWindow.isDestroyed()) {
      const area = primary.workArea;
      presenterWindow.setBounds({
        x: area.x + 40,
        y: area.y + 40,
        width: Math.max(900, Math.min(1200, area.width - 80)),
        height: Math.max(620, Math.min(820, area.height - 80)),
      });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) editorWindow = createEditorWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  void agentRuntime.close();
  void collabServer?.close();
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

  ipcMain.handle(IPC.htmlExport, async (_e, slideIds: string[]): Promise<string> => {
    const s = requireSession();
    const written = await writeHtmlScope(s.dir, s.deck, slideIds);
    lastWrittenHtml.set(written.path, written.contents);
    const openError = await shell.openPath(written.path);
    if (openError) {
      throw new Error(`HTML was written to ${written.path}, but could not be opened: ${openError}`);
    }
    return written.path;
  });

  ipcMain.handle(IPC.htmlAdopt, async (
    _e, path: string, contents: string, expected: string,
  ): Promise<void> => {
    const s = requireSession();
    const editDir = join(s.dir, HTML_EDIT_DIR);
    const target = resolve(String(path));
    // Only files inside this deck's edit/ folder; the renderer holds no other
    // write access to the filesystem and must not gain one through this.
    if (target !== editDir && !target.startsWith(editDir + sep)) {
      throw new Error(`Refusing to write outside ${editDir}: ${target}`);
    }
    const { readFile, writeFile } = await import('node:fs/promises');
    // The author may have saved again while the compile ran; stamping ids onto
    // *those* contents is the next compile's job, not a reason to lose them.
    const current = await readFile(target, 'utf8').catch(() => null);
    if (current !== expected) return;
    // Our own write; the watcher event it fires is an echo, not an edit.
    lastWrittenHtml.set(target, contents);
    await writeFile(target, contents, 'utf8');
  });

  ipcMain.handle(
    IPC.assetImport,
    async (event, paths: string[], token?: string): Promise<ImportedAsset[]> => {
      const s = requireSession();
      const out: ImportedAsset[] = [];
      for (const p of paths) {
        // One bad file in a multi-file drop shouldn't lose the rest.
        try {
          out.push(
            await importAsset(s.dir, p, (ratio) => {
              if (token && !event.sender.isDestroyed()) {
                event.sender.send(IPC.assetImportProgress, {
                  token,
                  phase: 'processing',
                  ratio,
                });
              }
            }),
          );
        } catch (err) {
          console.error(`Skipped ${p}:`, err);
        }
      }
      return out;
    },
  );

  // Copy: serialise the fragment onto the OS pasteboard under a private
  // format, with absolute asset paths attached, so any instance of this app —
  // including a different process with a different deck open — can paste it.
  ipcMain.handle(IPC.clipboardWrite, (_e, request: ClipboardWriteRequest): void => {
    const assets: ClipboardPayload['assets'] = [];
    if (session) {
      for (const src of collectAssetSrcs(request)) {
        try {
          const absPath = resolveAsset(session.dir, src);
          if (existsSync(absPath)) assets.push({ src, absPath });
        } catch {
          // A src that escapes the deck folder simply doesn't travel.
        }
      }
    }
    const payload = { format: CLIPBOARD_FORMAT, version: 1, ...request, assets };
    clipboard.writeBuffer(CLIPBOARD_FORMAT, Buffer.from(JSON.stringify(payload), 'utf8'));
  });

  // Paste: validate whatever is on the pasteboard, then re-import each
  // referenced asset into *this* deck. Import names files by content hash, so
  // pasting back into the source deck (or pasting twice) copies nothing.
  ipcMain.handle(IPC.clipboardRead, async (): Promise<ClipboardPayload | null> => {
    const buf = clipboard.readBuffer(CLIPBOARD_FORMAT);
    if (!buf || buf.length === 0) return null;
    let payload: ClipboardPayload | null = null;
    try {
      payload = parseClipboardPayload(JSON.parse(buf.toString('utf8')));
    } catch {
      return null;
    }
    if (!payload) return null;

    const s = requireSession();
    const map = new Map<string, string>();
    for (const asset of payload.assets) {
      try {
        // Fast path: the src already resolves in this deck (same-deck paste).
        if (existsSync(resolveAsset(s.dir, asset.src))) {
          map.set(asset.src, asset.src);
          continue;
        }
      } catch {
        // Foreign-shaped src; fall through to import.
      }
      try {
        const imported = await importAsset(s.dir, asset.absPath);
        map.set(asset.src, imported.src);
      } catch (err) {
        // Source deck gone since the copy. The element still pastes; its
        // media renders broken rather than vanishing.
        console.error(`Could not import pasted asset ${asset.absPath}:`, err);
      }
    }
    rewriteAssetSrcs(payload, map);
    return payload;
  });

  ipcMain.handle(IPC.assetProbe, async (_e, src: string) => {
    const s = requireSession();
    return probeMedia(resolveAsset(s.dir, src));
  });

  ipcMain.handle(IPC.displayList, () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      label: display.label || `Display ${index + 1}`,
      primary: display.id === primaryId,
      width: display.bounds.width,
      height: display.bounds.height,
    }));
  });
  ipcMain.handle(IPC.presentOpen, async (_e, slideIndex: number, options: PresentOptions = {}) => {
    if (presentWindow && !presentWindow.isDestroyed()) {
      presenterWindow?.focus();
      return;
    }
    const prefsPath = join(app.getPath('userData'), 'presentation-displays.json');
    let chosen = options;
    if (options.audienceDisplayId === undefined && options.presenterDisplayId === undefined) {
      try { chosen = JSON.parse(await readFile(prefsPath, 'utf8')) as PresentOptions; } catch { /* defaults below */ }
    }
    if (options.remember) {
      await writeFile(prefsPath, JSON.stringify({
        audienceDisplayId: options.audienceDisplayId,
        presenterDisplayId: options.presenterDisplayId,
      }));
    }
    presentationState = null;
    presentWindow = createPresentWindow(slideIndex, chosen.audienceDisplayId);
    presenterWindow = createPresenterWindow(chosen.presenterDisplayId);
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

  ipcMain.handle(IPC.exportPdf, async (_event, request: PdfExportRequest = {}): Promise<string | null> => {
    const s = requireSession();
    const mode = request.mode ?? 'final';
    const includeHidden = request.includeHidden ?? false;
    const target = await dialog.showSaveDialog({
      title: 'Export PDF',
      buttonLabel: 'Export',
      defaultPath: `${basename(s.dir)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (target.canceled || !target.filePath) return null;

    const jobId = randomUUID();
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => {
        ipcMain.off(IPC.exportPdfReady, listener);
        reject(new Error('PDF renderer timed out'));
      }, 30_000);
      const listener = (_readyEvent: Electron.IpcMainEvent, readyJobId: string) => {
        if (readyJobId !== jobId) return;
        clearTimeout(timer);
        ipcMain.off(IPC.exportPdfReady, listener);
        resolveReady();
      };
      ipcMain.on(IPC.exportPdfReady, listener);
    });
    const query = `?job=${encodeURIComponent(jobId)}&mode=${mode}&includeHidden=${includeHidden ? '1' : '0'}`;
    const printWindow = createPdfWindow(query);
    try {
      await ready;
      const renderError = await printWindow.webContents.executeJavaScript(
        'document.documentElement.dataset.error || ""',
      ) as string;
      if (renderError) throw new Error(renderError);
      const pdf = await printWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
      });
      await writeFile(target.filePath, pdf);
      return target.filePath;
    } finally {
      if (!printWindow.isDestroyed()) printWindow.destroy();
    }
  });

  /**
   * "Collaborate": share the open deck for live co-editing.
   *
   * The collab server becomes the deck's only writer — the desktop watcher
   * closes and the editor window is swapped for the same browser client the
   * joiners load (over localhost), so the host is simply another peer. The
   * server is pinned to this one deck: joiners can't list, create, or import
   * anything else. Closing the window ends the session and brings the
   * ordinary editor back.
   */
  // Joiners need a URL reachable from their machine, so prefer a LAN
  // address over the loopback one the host window itself uses.
  const copyJoinLink = (urls: string[], deckId: string, agent = false): void => {
    const base = urls.find((u) => !u.includes('127.0.0.1')) ?? urls[0];
    if (base) clipboard.writeText(`${base}?deck=${encodeURIComponent(deckId)}${agent ? '&agent=1' : ''}`);
  };

  // "Agent…" runs the same session unpinned: the server hosts the deck's
  // whole parent directory and refuses nothing, so an agent joining by URL
  // can list, create, and import decks exactly like a human peer. The host
  // hands the printed invite URL to the agent of their choice.
  ipcMain.handle(IPC.collabStart, async (_e, opts?: { agent?: boolean }): Promise<string[]> => {
    const s = requireSession();
    if (collabServer) {
      copyJoinLink(collabServer.urls, basename(s.dir), Boolean(opts?.agent));
      return collabServer.urls;
    }

    const clientDir = defaultClientDir(app.getAppPath());
    if (!clientDir) {
      throw new Error('The browser client is not built — run: npm run build:collab');
    }

    const deckId = basename(s.dir);
    const base = {
      rootDir: dirname(s.dir),
      // Agent sessions are scoped to the same open deck as human sessions.
      // An invite never exposes sibling folders.
      hostedDeckId: deckId,
      agentMode: Boolean(opts?.agent),
      clientDir,
      // "End collaboration" in the host window: closing the window is the
      // existing teardown path (stops the server, restores the editor).
      onSessionEnd: () => setImmediate(() => collabWindow?.close()),
    };
    let server: RunningCollabServer;
    try {
      server = await startCollabServer(base);
    } catch {
      // 5800 taken (another session or app); any free port still shares fine.
      server = await startCollabServer({ ...base, port: 0 });
    }
    collabServer = server;
    copyJoinLink(server.urls, deckId, Boolean(opts?.agent));

    // Two debounced whole-file writers on one deck.json silently last-write-
    // wins each other; from here the server owns persistence.
    for (const w of watchers) w.close();
    watchers = [];

    const hostName = userInfo().username || 'Host';
    collabWindow = createCollabHostWindow(
      `http://127.0.0.1:${server.port}/?deck=${encodeURIComponent(deckId)}&name=${encodeURIComponent(hostName)}`,
    );
    collabWindow.on('closed', () => {
      collabWindow = null;
      const closing = collabServer;
      collabServer = null;
      // Recreate the editor synchronously: with no window at all,
      // window-all-closed would quit the app on non-macOS.
      if (!quitting && session) editorWindow = createEditorWindow();
      void (async () => {
        await closing?.close();
        if (quitting || !session) return;
        // The server may have flushed edits after our watchers closed; reload
        // so the returning editor shows what everyone last saw.
        session.deck = await loadDeck(session.dir);
        watchDeck(session.dir, session.deck.theme);
        broadcastDeck();
      })();
    });
    editorWindow?.close();
    editorWindow = null;
    return server.urls;
  });

  ipcMain.handle(
    IPC.workflowStart,
    async (_e, request: WorkflowStartRequest): Promise<WorkflowStartResult> => {
      const s = requireSession();
      return startWorkflow(s.dir, s.deck, request);
    },
  );

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
