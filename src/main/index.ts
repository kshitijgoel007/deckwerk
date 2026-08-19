import { type FSWatcher, existsSync, mkdirSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { BrowserWindow, app, clipboard, dialog, ipcMain, screen, shell } from 'electron';
import type { Display, Rectangle } from 'electron';
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
  AgentChatSendRequest,
  AgentChatState,
  AgentResponse,
  CollabStartRequest,
  DeckSession,
  ImportedAsset,
  KeynoteImportResult,
  PresentationCommand,
  PresentationState,
  PdfExportRequest,
  PresentOptions,
  RasterSaveRequest,
  RasterResult,
  RasterTarget,
  TrimRequest,
  TrimResult,
  WorkflowStartRequest,
  WorkflowStartResult,
} from '@shared/ipc.js';
import { encodeEditorView, type EditorViewSnapshot } from '@shared/editorView.js';
import { startWorkflow } from './workflow.js';
import { handoffWhenReady } from './windowHandoff.js';
import { AgentRuntime } from './agentRuntime.js';
import { AgentChatController } from './agentChat.js';
import { installAssetProtocol, registerAssetScheme, setDeckDir } from './assetProtocol.js';
import {
  createDeck,
  copyDeck,
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
  captureWindowContinuity, createAgentChatWindow, createCollabHostWindow, createEditorWindow, createPdfWindow, createPresentWindow, createPresenterWindow, createRasterWindow, createTrimWindow,
} from './windows.js';
import {
  defaultClientDir, startCollabServer, type RunningCollabServer,
} from '../server/collabServer.js';
import { agentClipboardPrompt, collaborationInviteUrl } from '../server/agentBrief.js';
import {
  chooseAudienceDisplay,
  chooseDisplayById,
  shouldOpenSpeakerView,
  swappedPresentationDisplays,
} from './presentationDisplays.js';

/**
 * Main process: owns the filesystem, ffmpeg and the windows. The renderer never
 * touches Node directly — everything crosses through the typed IPC in
 * `@shared/ipc`.
 */

// Must happen before `ready`.
app.setName('DeckWerk');
registerAssetScheme();

/** The one deck the app has open. Present and trim windows share it. */
let session: DeckSession | null = null;
let editorWindow: BrowserWindow | null = null;
let presentWindow: BrowserWindow | null = null;
let presenterWindow: BrowserWindow | null = null;
let presentationState: PresentationState | null = null;
let presentationDisplays: { audienceDisplayId: number; presenterDisplayId: number } | null = null;
let swappingPresentationDisplays = false;
let trimWindow: BrowserWindow | null = null;
let rasterWindow: BrowserWindow | null = null;
/** Live while the open deck is being shared for co-editing. */
let collabServer: RunningCollabServer | null = null;
let collabWindow: BrowserWindow | null = null;
let agentChatWindow: BrowserWindow | null = null;
let collabReturn: Promise<void> | null = null;
let quitting = false;
const agentRuntime = new AgentRuntime(() => editorWindow);
const agentChat = new AgentChatController({
  openExternal: async (url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Refusing to open unsupported sign-in URL: ${parsed.protocol}`);
    }
    await shell.openExternal(url);
  },
  onState: (state) => {
    for (const win of [editorWindow, agentChatWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.agentChatState, state);
    }
  },
});

function speakerWindowBounds(display: Display): Rectangle {
  const area = display.workArea;
  return {
    x: area.x + 40,
    y: area.y + 40,
    width: Math.max(900, Math.min(1200, area.width - 80)),
    height: Math.max(620, Math.min(820, area.height - 80)),
  };
}

function moveSpeakerWindowToDisplay(display: Display): void {
  if (!presenterWindow || presenterWindow.isDestroyed()) return;
  presenterWindow.setBounds(speakerWindowBounds(display));
}

function moveAudienceWindowToDisplay(display: Display): Promise<void> {
  if (!presentWindow || presentWindow.isDestroyed()) return Promise.resolve();
  const win = presentWindow;
  const enterFullscreen = (): void => {
    if (win.isDestroyed()) return;
    win.setBounds(display.bounds);
    win.setFullScreen(true);
  };
  if (!win.isFullScreen()) {
    enterFullscreen();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    win.once('leave-full-screen', () => {
      enterFullscreen();
      resolve();
    });
    win.setFullScreen(false);
  });
}

async function swapPresentationDisplayRoles(): Promise<void> {
  if (swappingPresentationDisplays || !presentationDisplays || !presenterWindow) return;
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const swapped = swappedPresentationDisplays(displays, presentationDisplays, primary);
  if (!swapped) return;
  const { audience: audienceTarget, presenter: presenterTarget } = swapped;

  swappingPresentationDisplays = true;
  presentationDisplays = {
    audienceDisplayId: audienceTarget.id,
    presenterDisplayId: presenterTarget.id,
  };
  try {
    moveSpeakerWindowToDisplay(presenterTarget);
    await moveAudienceWindowToDisplay(audienceTarget);
    if (presenterWindow && !presenterWindow.isDestroyed()) presenterWindow.focus();
  } finally {
    swappingPresentationDisplays = false;
  }
}

function requireSession(): DeckSession {
  if (!session) throw new Error('No deck is open');
  return session;
}

async function readCollabView(win: BrowserWindow): Promise<EditorViewSnapshot | null> {
  try {
    return await win.webContents.executeJavaScript(`(() => {
      const state = window.store?.get?.();
      if (!state) return null;
      return {
        activeSlideId: state.deck.slides[state.slideIndex]?.id ?? null,
        selectedSlideIds: Array.from(state.slideSelection ?? []),
        selectedElementIds: Array.from(state.selection ?? []),
      };
    })()`) as EditorViewSnapshot | null;
  } catch {
    return null;
  }
}

/**
 * Hand the collaboration shell back to the native editor without ever leaving
 * the desktop with no visible app window. The server is flushed while the old
 * shell remains on screen; only a ready replacement is allowed to close it.
 */
function returnFromCollaboration(): Promise<void> {
  if (collabReturn) return collabReturn;
  const host = collabWindow;
  if (!host || host.isDestroyed() || quitting) return Promise.resolve();

  collabReturn = (async () => {
    const chat = agentChatWindow;
    agentChatWindow = null;
    if (chat && !chat.isDestroyed()) chat.destroy();
    const continuity = captureWindowContinuity(host);
    const view = await readCollabView(host);
    const closing = collabServer;
    collabServer = null;
    try {
      if (session) await agentChat.reset(session.dir);
      await closing?.close();
    } catch (error) {
      console.error('Could not close collaboration server cleanly:', error);
    }
    if (quitting || !session) return;

    // Closing the server flushes its authoritative in-memory deck to disk.
    // If a final reload fails, still restore the editor with the last known
    // session instead of stranding the user in a disconnected collab shell.
    try {
      session.deck = await loadDeck(session.dir);
    } catch (error) {
      console.error('Could not reload the deck after collaboration:', error);
    }
    watchDeck(session.dir, session.deck.theme);

    const query = view ? `?view=${encodeURIComponent(encodeEditorView(view))}` : '';
    const replacement = createEditorWindow(query, continuity);
    editorWindow = replacement;
    broadcastDeck(replacement);

    await handoffWhenReady(replacement, host);
  })().finally(() => {
    collabReturn = null;
  });
  return collabReturn;
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
  // Packaged macOS builds get this from the bundle's .icns. During local
  // development Electron would otherwise keep its own icon in the Dock and
  // app switcher, so set the matching high-resolution artwork explicitly.
  if (process.platform === 'darwin' && !app.isPackaged) {
    const developmentIcon = join(process.cwd(), 'resources', 'deckwerk-icon.png');
    if (existsSync(developmentIcon)) app.dock.setIcon(developmentIcon);
  }

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
    presentationDisplays = {
      audienceDisplayId: primary.id,
      presenterDisplayId: primary.id,
    };
    moveSpeakerWindowToDisplay(primary);
    void moveAudienceWindowToDisplay(primary);
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
  agentChat.close();
  agentChatWindow?.destroy();
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
  ipcMain.handle(IPC.agentChatGetState, async (): Promise<AgentChatState> => {
    const s = requireSession();
    return agentChat.getState(s.dir);
  });
  ipcMain.handle(IPC.agentChatLogin, async (): Promise<AgentChatState> => {
    const s = requireSession();
    return agentChat.login(s.dir);
  });
  ipcMain.handle(
    IPC.agentChatSend,
    async (_event, request: AgentChatSendRequest): Promise<AgentChatState> => {
      const s = requireSession();
      if (!request || typeof request.text !== 'string') throw new Error('A message is required');
      return agentChat.send(s.dir, request, async () => {
        if (!collabServer) throw new Error('The deck-scoped agent session is not running');
        const deckId = basename(s.dir);
        const joinUrl = collaborationInviteUrl(collabServer.urls, deckId, true);
        if (!joinUrl) throw new Error('The agent session has no reachable URL');
        return agentClipboardPrompt(joinUrl, deckId);
      });
    },
  );
  ipcMain.handle(IPC.agentChatInterrupt, async (): Promise<AgentChatState> => {
    const s = requireSession();
    return agentChat.interrupt(s.dir);
  });
  ipcMain.handle(IPC.agentChatReset, async (): Promise<AgentChatState> => {
    const s = requireSession();
    return agentChat.reset(s.dir);
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

  ipcMain.handle(IPC.deckSaveAs, async (): Promise<DeckSession | null> => {
    const s = requireSession();
    const target = await dialog.showSaveDialog({
      title: 'Save deck as',
      buttonLabel: 'Save As',
      defaultPath: basename(s.dir),
      properties: ['createDirectory'],
    });
    if (target.canceled || !target.filePath) return null;

    const deck = await copyDeck(s.dir, target.filePath);
    const saved = setSession(target.filePath, deck);
    broadcastDeck();
    return saved;
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
      (presenterWindow ?? presentWindow).focus();
      return;
    }
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const audienceDisplay = chooseDisplayById(
      displays,
      options.audienceDisplayId,
      chooseAudienceDisplay(displays, primary),
    );
    const presenterDisplay = chooseDisplayById(
      displays,
      options.presenterDisplayId,
      primary,
    );
    const openSpeakerView = shouldOpenSpeakerView(
      audienceDisplay,
      presenterDisplay,
      options.speakerView,
    );

    presentationState = null;
    presentationDisplays = {
      audienceDisplayId: audienceDisplay.id,
      presenterDisplayId: presenterDisplay.id,
    };
    presentWindow = createPresentWindow(slideIndex, audienceDisplay.id, options.endSlideIndex);
    presenterWindow = openSpeakerView ? createPresenterWindow(presenterDisplay.id) : null;
    presentWindow.on('closed', () => {
      presentWindow = null;
      presentationDisplays = null;
      if (presenterWindow && !presenterWindow.isDestroyed()) presenterWindow.close();
    });
    if (presenterWindow) {
      presenterWindow.webContents.once('did-finish-load', () => {
        if (presentationState && presenterWindow && !presenterWindow.isDestroyed()) {
          presenterWindow.webContents.send(IPC.presentState, presentationState);
        }
      });
      presenterWindow.on('closed', () => {
        presenterWindow = null;
        presentationDisplays = null;
        if (presentWindow && !presentWindow.isDestroyed()) presentWindow.close();
      });
    }
  });
  ipcMain.on(IPC.presentCommand, (_event, command: PresentationCommand) => {
    if (command.type === 'exit') {
      presentWindow?.close();
      presenterWindow?.close();
      return;
    }
    if (command.type === 'swapDisplays') {
      void swapPresentationDisplayRoles();
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

  ipcMain.handle(IPC.rasterOpen, (_e, payload: RasterTarget) => {
    if (rasterWindow && !rasterWindow.isDestroyed()) rasterWindow.close();
    rasterWindow = createRasterWindow();
    const win = rasterWindow;
    win.on('closed', () => (rasterWindow = null));
    // Wait for the paint renderer to subscribe before delivering its target.
    win.webContents.once('did-finish-load', () => {
      win.webContents.send(IPC.rasterOpen, payload);
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
   * closes and the editor window hands off to the same browser client the
   * joiners load (over localhost), so the host is simply another peer. The
   * server is pinned to this one deck: joiners can't list, create, or import
   * anything else. Closing the window ends the session and brings the
   * ordinary editor back.
   */
  // Joiners need a URL reachable from their machine, so prefer a LAN
  // address. A desktop agent runs on this machine and should prefer loopback:
  // browser sandboxes commonly block private-LAN navigation while allowing
  // localhost, which is exactly the surface the editor has launched for it.
  const copyJoinLink = (urls: string[], deckId: string, agent = false): void => {
    const joinUrl = collaborationInviteUrl(urls, deckId, agent);
    if (!joinUrl) return;
    clipboard.writeText(agent ? agentClipboardPrompt(joinUrl, deckId) : joinUrl);
  };

  // "Agent…" runs the same deck-scoped session and copies a complete,
  // task-neutral API brief for the user to paste into an agent chat.
  ipcMain.handle(IPC.collabStart, async (_e, opts?: CollabStartRequest): Promise<string[]> => {
    const s = requireSession();
    const requestedView: EditorViewSnapshot = opts ?? {
      activeSlideId: null,
      selectedSlideIds: [],
      selectedElementIds: [],
    };
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
      // Keep the collaboration shell visible until the restored native editor
      // has loaded, so ending a session is a continuous window handoff too.
      onSessionEnd: () => setImmediate(() => void returnFromCollaboration()),
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
    const hostUrl = new URL(`http://127.0.0.1:${server.port}/`);
    hostUrl.searchParams.set('deck', deckId);
    hostUrl.searchParams.set('name', hostName);
    hostUrl.searchParams.set('view', encodeEditorView(requestedView));

    const previousEditor = editorWindow;
    const continuity = previousEditor && !previousEditor.isDestroyed()
      ? captureWindowContinuity(previousEditor)
      : undefined;
    const host = createCollabHostWindow(hostUrl.toString(), continuity);
    collabWindow = host;

    if (opts?.agent) {
      const chat = createAgentChatWindow(host);
      agentChatWindow = chat;
      chat.on('closed', () => {
        if (agentChatWindow === chat) agentChatWindow = null;
        if (!quitting && !collabReturn) void returnFromCollaboration();
      });
    }

    // Native close controls mean "end collaboration". Intercept the close so
    // the current window remains visible until its replacement is ready.
    host.on('close', (event) => {
      if (quitting || collabReturn) return;
      event.preventDefault();
      void returnFromCollaboration();
    });
    host.on('closed', () => {
      if (collabWindow === host) collabWindow = null;
    });

    // Starting a session uses the same atomic handoff in the other direction:
    // the editor stays visible while localhost loads, then the ready collab
    // shell appears at the exact same bounds before the old window closes.
    void handoffWhenReady(host, previousEditor, () => {
      if (editorWindow === previousEditor) editorWindow = null;
    });
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

  ipcMain.handle(
    IPC.rasterSave,
    async (_event, req: RasterSaveRequest): Promise<RasterResult> => {
      const s = requireSession();
      // Resolving the input is a cheap containment/existence check. Raster
      // output always becomes a sibling derived asset; the original stays put.
      const input = resolveAsset(s.dir, req.src);
      if (!existsSync(input)) throw new Error(`Image asset does not exist: ${req.src}`);
      const bytes = Buffer.from(req.png);
      const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
        throw new Error('Raster editor produced an invalid PNG');
      }
      if (!Number.isInteger(req.width) || !Number.isInteger(req.height)
        || req.width < 1 || req.height < 1) {
        throw new Error('Raster editor produced invalid image dimensions');
      }
      const { absolute, relative } = await derivedAssetPath(s.dir, req.src, 'paint', '.png');
      await writeFile(absolute, bytes);
      const result: RasterResult = {
        src: relative,
        elementId: req.elementId,
        width: req.width,
        height: req.height,
      };
      editorWindow?.webContents.send(IPC.rasterDone, result);
      return result;
    },
  );
}
