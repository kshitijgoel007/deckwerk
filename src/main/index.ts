import { type FSWatcher, existsSync, mkdirSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { BrowserWindow, app, clipboard, dialog, ipcMain, screen, shell } from 'electron';
import type { Display, IpcMainInvokeEvent } from 'electron';
import { parseDeck, type Deck } from '@shared/deck.js';
import type { DeckHistoryDocument } from '@shared/deckHistory.js';
import {
  CLIPBOARD_FORMAT,
  type ClipboardReadResult,
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
  AgentChatSelectRequest,
  AgentChatSetModelRequest,
  AgentChatSetReasoningEffortRequest,
  AgentChatSetFastModeRequest,
  AgentChatState,
  AgentChatTranscript,
  AgentSessionConnection,
  AgentSessionState,
  AgentResponse,
  CollabStartRequest,
  DeckSession,
  DeckSessionSnapshot,
  DeckHistorySession,
  ImportedAsset,
  KeynoteImportResult,
  OperationProgress,
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
import { startWorkflow } from './workflow.js';
import { AgentRuntime } from './agentRuntime.js';
import { AgentChatController } from './agentChat.js';
import { AgentVisualPolicy } from './agentVisualPolicy.js';
import { DesktopSharedAgent } from './desktopSharedAgent.js';
import { callPresentationApi } from './agentPresentationApi.js';
import type { DynamicToolCall, DynamicToolResult } from './codexAppServer.js';
import { installAssetProtocol, registerAssetScheme, setDeckDir } from './assetProtocol.js';
import {
  createDeck,
  deckFolderPath,
  copyDeck,
  derivedAssetPath,
  importAsset,
  importImageBuffer,
  loadDeck,
  loadTheme,
  resolveAsset,
  saveDeck,
  saveTheme,
} from './deckStore.js';
import { exportDeck } from './exportDeck.js';
import { probeMedia, runTrim } from './ffmpeg.js';
import { importKeynote } from './keynoteImport.js';
import { loadDeckHistory, saveDeckHistory } from './deckHistoryStore.js';
import { HTML_EDIT_DIR, writeHtmlScope } from './htmlAuthoring.js';
import {
  createEditorWindow,
  createPdfWindow,
  createPresentWindow,
  createPresenterWindow,
  createRasterWindow,
  createTrimWindow,
  showSpeakerWindowAboveFullscreen,
} from './windows.js';
import {
  defaultClientDir, startCollabServer, type HtmlDraftPreview, type NativeDraftPreview,
  type RunningCollabServer,
} from '../server/collabServer.js';
import { agentClipboardPrompt, collaborationInviteUrl } from '../server/agentBrief.js';
import {
  chooseAudienceDisplay,
  chooseDisplayById,
  shouldOpenSpeakerView,
  shouldShowAudienceWindow,
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
/** Latest renderer-owned theme while an Agent collaboration session owns disk writes. */
let sessionThemeCss: string | null = null;
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
let collabMode: 'window' | 'agent-background' | 'collaboration-background' | null = null;
let agentSessionReturn: Promise<void> | null = null;
let quitting = false;
const agentRuntime = new AgentRuntime(() => editorWindow);
const agentChatStateListeners = new Set<(
  state: AgentChatState,
  conversationKey: string,
) => void>();
const agentChat = new AgentChatController({
  // DeckWerk owns its embedded agent login. Switching it must not sign the
  // user's other Codex clients in or out.
  codexHome: join(app.getPath('userData'), 'agent-codex'),
  openExternal: async (url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Refusing to open unsupported sign-in URL: ${parsed.protocol}`);
    }
    await shell.openExternal(url);
  },
  onState: (state, conversationKey) => {
    if (conversationKey === '' && editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.webContents.send(IPC.agentChatState, state);
    }
    for (const listener of agentChatStateListeners) listener(state, conversationKey);
  },
  onDynamicToolCall: handleAgentDynamicTool,
});
const desktopSharedAgent = new DesktopSharedAgent({
  controller: agentChat,
  subscribe: (listener) => {
    agentChatStateListeners.add(listener);
    return () => agentChatStateListeners.delete(listener);
  },
});
const agentVisualPolicy = new AgentVisualPolicy();

async function handleAgentDynamicTool(call: DynamicToolCall): Promise<DynamicToolResult> {
  if (call.tool === 'presentation_api') {
    if (!collabServer || !session) throw new Error('The deck-scoped slide server is not running');
    return callPresentationApi(call, { port: collabServer.port, deckPath: session.dir });
  }
  if (call.tool !== 'browser_open') throw new Error(`Unknown DeckWerk tool: ${call.tool}`);
  const args = call.arguments && typeof call.arguments === 'object'
    ? call.arguments as Record<string, unknown>
    : {};
  if (typeof args.url !== 'string') throw new Error('browser_open requires an absolute URL');
  const requestedUrl = new URL(args.url);
  const collaborationOrigin = collabServer ? `http://127.0.0.1:${collabServer.port}` : undefined;
  const visual = agentVisualPolicy.decide(call.turnId, requestedUrl, collaborationOrigin);
  const url = visual.url;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`browser_open only supports HTTP(S), not ${url.protocol}`);
  }
  const numberInRange = (value: unknown, fallback: number, min: number, max: number) => {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, number));
  };
  const width = numberInRange(args.width, 1440, 320, 2560);
  const height = numberInRange(args.height, 900, 240, 1600);
  const waitMs = numberInRange(args.waitMs, 250, 0, 5000);
  if (visual.duplicate) {
    return {
      success: true,
      contentItems: [{
        type: 'inputText',
        text: JSON.stringify({
          url: url.href,
          screenshot: 'duplicate-suppressed',
          instruction: 'Reuse the visual already returned in this turn. Do not add another capture to model context.',
        }),
      }],
    };
  }
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await Promise.race([
      win.loadURL(url.href),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error(`Timed out opening ${url.href}`)),
        30_000,
      )),
    ]);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await win.webContents.executeJavaScript(
      'Promise.all([...document.images].map((image) => image.decode().catch(() => null))).then(() => true)',
    );
    if (waitMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
    const metadata = await win.webContents.executeJavaScript(`(() => ({
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || '').slice(0, 12000),
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    }))()`) as Record<string, unknown>;
    if (visual.canonicalized) metadata.canonicalizedFrom = requestedUrl.href;
    const screenshot = (await win.webContents.capturePage()).toDataURL();
    return {
      success: true,
      contentItems: [
        { type: 'inputText', text: JSON.stringify(metadata) },
        { type: 'inputImage', imageUrl: screenshot },
      ],
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function moveFullscreenWindowToDisplay(
  win: BrowserWindow | null,
  display: Display,
): Promise<void> {
  if (!win || win.isDestroyed()) return Promise.resolve();
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

function moveSpeakerWindowToDisplay(display: Display): Promise<void> {
  return moveFullscreenWindowToDisplay(presenterWindow, display);
}

function moveAudienceWindowToDisplay(display: Display): Promise<void> {
  return moveFullscreenWindowToDisplay(presentWindow, display);
}

function openSpeakerWindow(displayId: number, visibleAboveFullscreen: boolean): BrowserWindow {
  const win = createPresenterWindow(displayId, visibleAboveFullscreen);
  presenterWindow = win;
  win.webContents.once('did-finish-load', () => {
    if (presentationState && !win.isDestroyed()) {
      win.webContents.send(IPC.presentState, presentationState);
    }
  });
  win.on('closed', () => {
    if (presenterWindow === win) presenterWindow = null;
    presentationDisplays = null;
    if (presentWindow && !presentWindow.isDestroyed()) presentWindow.close();
  });
  return win;
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
    await Promise.all([
      moveSpeakerWindowToDisplay(presenterTarget),
      moveAudienceWindowToDisplay(audienceTarget),
    ]);
    if (presenterWindow && !presenterWindow.isDestroyed()) presenterWindow.focus();
  } finally {
    swappingPresentationDisplays = false;
  }
}

function requireSession(): DeckSession {
  if (!session) throw new Error('No deck is open');
  return session;
}

/** Push a detailed phase back only to the renderer that started the work. */
function reportOperation(
  event: IpcMainInvokeEvent,
  id: unknown,
  message: string,
  ratio: number | null = null,
): void {
  if (typeof id !== 'string' || id.length === 0 || event.sender.isDestroyed()) return;
  const progress: OperationProgress = { id, message, ratio };
  event.sender.send(IPC.operationProgress, progress);
}

function sendAgentSessionState(state: AgentSessionState): void {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.webContents.send(IPC.agentSessionState, state);
  }
}

/**
 * End the hidden authoritative session while leaving the native editor in
 * place. The server flushes first; disk watching resumes only after its final
 * deck is reloaded, so there is never a second writer racing it.
 */
function endBackgroundAgentSession(): Promise<void> {
  if (agentSessionReturn) return agentSessionReturn;
  if (collabMode !== 'agent-background' && collabMode !== 'collaboration-background') {
    return Promise.resolve();
  }

  agentSessionReturn = (async () => {
    const closing = collabServer;
    collabServer = null;
    collabMode = null;
    try {
      if (session) await agentChat.suspend(session.dir);
      closing?.notifyEnded();
      // Let WebSocket queue the terminal frame before close() terminates peers.
      if (closing) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      await closing?.close();
    } catch (error) {
      console.error('Could not close background collaboration session cleanly:', error);
    }
    if (quitting || !session) return;
    try {
      session.deck = await loadDeck(session.dir);
    } catch (error) {
      console.error('Could not reload the deck after collaboration:', error);
    }
    watchDeck(session.dir, session.deck.theme);
    broadcastDeck();
    sendAgentSessionState({ active: false });
  })().finally(() => {
    agentSessionReturn = null;
  });
  return agentSessionReturn;
}

let watchers: FSWatcher[] = [];
/** Exactly what we last wrote, so the watcher can tell an echo from an edit. */
let lastSavedDeckJson: string | null = null;
/** HTML the editor itself just exported; its watcher event is an echo, not an edit. */
const lastWrittenHtml = new Map<string, string>();

function setSession(dir: string, deck: Deck): DeckSession {
  session = { dir, deck };
  sessionThemeCss = null;
  setDeckDir(dir);
  watchDeck(dir, deck.theme);
  void agentRuntime.open(dir);
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
          sessionThemeCss = css;
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
        const path = resolve(editDir, String(filename));
        // `.scratchpad/` holds persistent Agent preview evidence. Only direct
        // children of edit/ are authored documents whose saves update slides.
        if (dirname(path) !== editDir) return;
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
    void Promise.all([
      moveSpeakerWindowToDisplay(primary),
      moveAudienceWindowToDisplay(primary),
    ]).then(() => {
      if (presenterWindow && !presenterWindow.isDestroyed()) {
        showSpeakerWindowAboveFullscreen(presenterWindow);
      }
    });
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
  void collabServer?.close();
});

function registerHandlers(): void {
  ipcMain.handle(IPC.deckNew, async (event, operationId?: string): Promise<DeckSession | null> => {
    const res = await dialog.showSaveDialog({
      title: 'New deck',
      buttonLabel: 'Create',
      // A deck is a folder, so the dialog names a directory to create.
      properties: ['createDirectory'],
      defaultPath: 'Untitled deck',
    });
    if (res.canceled || !res.filePath) return null;
    // The panel hands back whatever is in its name field, so a stray `.key`
    // from the surrounding folder must not become the folder name or title.
    const dir = deckFolderPath(res.filePath);
    reportOperation(event, operationId, `Creating ${basename(dir)}/deck.json`);
    const deck = await createDeck(dir, basename(dir));
    reportOperation(event, operationId, 'Preparing the new presentation', 1);
    return setSession(dir, deck);
  });

  ipcMain.handle(IPC.deckOpen, async (event, operationId?: string): Promise<DeckSession | null> => {
    const res = await dialog.showOpenDialog({
      title: 'Open deck',
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    reportOperation(event, operationId, `Reading ${basename(dir)}/deck.json`);
    const deck = await loadDeck(dir);
    reportOperation(event, operationId, 'Preparing deck files', 0.4);
    return setSession(dir, deck);
  });

  // Pull rather than push: a window that opens mid-session asks for the current
  // deck itself, so it can't miss a broadcast that fired before it loaded.
  ipcMain.handle(IPC.deckGet, (): DeckSession | null => session);
  ipcMain.handle(IPC.deckHistoryLoad, async (_event, dir: string): Promise<DeckHistorySession> => {
    const s = requireSession();
    if (dir !== s.dir) throw new Error('The requested deck is no longer open');
    return { dir: s.dir, history: await loadDeckHistory(s.dir) };
  });
  ipcMain.handle(
    IPC.deckHistorySave,
    async (_event, dir: string, history: DeckHistoryDocument): Promise<void> => {
      const s = requireSession();
      if (dir !== s.dir) throw new Error('Refusing to save history to a deck that is no longer open');
      await saveDeckHistory(s.dir, history);
    },
  );

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
  ipcMain.handle(
    IPC.agentChatGetTranscript,
    async (_event, request: AgentChatSelectRequest): Promise<AgentChatTranscript | null> => {
      const s = requireSession();
      if (!request || typeof request.chatId !== 'string') throw new Error('A chat id is required');
      return agentChat.getTranscript(s.dir, request.chatId);
    },
  );
  ipcMain.handle(
    IPC.agentChatSelect,
    async (_event, request: AgentChatSelectRequest): Promise<AgentChatState> => {
      const s = requireSession();
      if (!request || typeof request.chatId !== 'string') throw new Error('A chat id is required');
      return agentChat.select(s.dir, request.chatId);
    },
  );
  ipcMain.handle(IPC.agentChatLogin, async (): Promise<AgentChatState> => {
    const s = requireSession();
    return agentChat.login(s.dir);
  });
  ipcMain.handle(IPC.agentChatSwitchAccount, async (): Promise<AgentChatState> => {
    const s = requireSession();
    return agentChat.switchAccount(s.dir);
  });
  ipcMain.handle(
    IPC.agentChatSetModel,
    async (_event, request: AgentChatSetModelRequest): Promise<AgentChatState> => {
      const s = requireSession();
      if (!request || typeof request.model !== 'string') throw new Error('A model is required');
      return agentChat.setModel(s.dir, request.model);
    },
  );
  ipcMain.handle(
    IPC.agentChatSetReasoningEffort,
    async (_event, request: AgentChatSetReasoningEffortRequest): Promise<AgentChatState> => {
      const s = requireSession();
      if (!request || typeof request.effort !== 'string') {
        throw new Error('A reasoning effort is required');
      }
      return agentChat.setReasoningEffort(s.dir, request.effort);
    },
  );
  ipcMain.handle(
    IPC.agentChatSetFastMode,
    async (_event, request: AgentChatSetFastModeRequest): Promise<AgentChatState> => {
      const s = requireSession();
      if (!request || typeof request.enabled !== 'boolean') {
        throw new Error('A fast mode setting is required');
      }
      return agentChat.setFastMode(s.dir, request.enabled);
    },
  );
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

  ipcMain.handle(
    IPC.deckSyncSnapshot,
    (event, snapshot: DeckSessionSnapshot): void => {
      const s = requireSession();
      // During an embedded Agent session the collaboration server is the only
      // deck.json writer. Present/PDF/web export still live in the main process,
      // so mirror the authoritative renderer state in memory without racing the
      // server's debounced persistence.
      s.deck = parseDeck(snapshot.deck);
      sessionThemeCss = snapshot.themeCss;
      broadcastDeck(BrowserWindow.fromWebContents(event.sender));
    },
  );

  ipcMain.handle(IPC.deckSaveAs, async (event, operationId?: string): Promise<DeckSession | null> => {
    const s = requireSession();
    const target = await dialog.showSaveDialog({
      title: 'Save deck as',
      buttonLabel: 'Save As',
      defaultPath: basename(s.dir),
      properties: ['createDirectory'],
    });
    if (target.canceled || !target.filePath) return null;
    const dir = deckFolderPath(target.filePath);

    reportOperation(event, operationId, `Copying deck to ${basename(dir)}`);
    const deck = await copyDeck(s.dir, dir);
    reportOperation(event, operationId, 'Opening the saved copy', 0.8);
    const saved = setSession(dir, deck);
    broadcastDeck(BrowserWindow.fromWebContents(event.sender));
    return saved;
  });

  ipcMain.handle(IPC.deckLoadTheme, async (): Promise<string> => {
    const s = requireSession();
    return sessionThemeCss ?? loadTheme(s.dir, s.deck.theme);
  });

  ipcMain.handle(IPC.deckSaveTheme, async (_e, css: string): Promise<void> => {
    const s = requireSession();
    sessionThemeCss = css;
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
  ipcMain.handle(IPC.clipboardRead, async (): Promise<ClipboardReadResult | null> => {
    const buf = clipboard.readBuffer(CLIPBOARD_FORMAT);
    if (!buf || buf.length === 0) {
      const html = clipboard.readHTML();
      const text = clipboard.readText();
      if (/<table\b/i.test(html) || text.includes('\t')) {
        return { kind: 'external-html', html, text };
      }
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        // Preserve the sharpest representation on Retina displays. NativeImage
        // otherwise defaults PNG encoding to the 1x representation.
        const scaleFactor = Math.max(1, ...image.getScaleFactors());
        const asset = await importImageBuffer(
          requireSession().dir,
          image.toPNG({ scaleFactor }),
          'Screenshot.png',
          image.getSize(scaleFactor),
        );
        return { kind: 'external-image', asset };
      }
      return null;
    }
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
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    if (presentWindow && !presentWindow.isDestroyed()) {
      if (options.speakerView && (!presenterWindow || presenterWindow.isDestroyed())) {
        const audienceDisplay = chooseDisplayById(
          displays,
          presentationDisplays?.audienceDisplayId,
          chooseAudienceDisplay(displays, primary),
        );
        const presenterDisplay = chooseDisplayById(
          displays,
          options.presenterDisplayId,
          primary,
        );
        presentationDisplays = {
          audienceDisplayId: audienceDisplay.id,
          presenterDisplayId: presenterDisplay.id,
        };
        openSpeakerWindow(
          presenterDisplay.id,
          audienceDisplay.id === presenterDisplay.id,
        );
      }
      (presenterWindow ?? presentWindow).focus();
      return;
    }
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
    const showAudienceWindow = shouldShowAudienceWindow(
      audienceDisplay,
      presenterDisplay,
      openSpeakerView,
    );

    presentationState = null;
    presentationDisplays = {
      audienceDisplayId: audienceDisplay.id,
      presenterDisplayId: presenterDisplay.id,
    };
    presentWindow = createPresentWindow(
      slideIndex,
      audienceDisplay.id,
      options.endSlideIndex,
      showAudienceWindow,
    );
    presenterWindow = openSpeakerView
      ? openSpeakerWindow(presenterDisplay.id, false)
      : null;
    presentWindow.on('closed', () => {
      presentWindow = null;
      presentationDisplays = null;
      if (presenterWindow && !presenterWindow.isDestroyed()) presenterWindow.close();
    });
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
    async (event, operationId?: string): Promise<KeynoteImportResult | null> => {
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

      // The sidecar reports 0..1 across its own work, and the renderer's
      // `adopt` then reports the rest of the way. Compress the conversion into
      // the first half so the operation's completion only ever moves forward.
      const conversionShare = 0.5;
      const result = await importKeynote(keyPath, deckFolderPath(target.filePath), (message, ratio) => {
        reportOperation(event, operationId, message, ratio === null ? null : ratio * conversionShare);
      });
      reportOperation(event, operationId, 'Opening the imported presentation', conversionShare);
      setSession(result.dir, result.deck);
      broadcastDeck(BrowserWindow.fromWebContents(event.sender));
      return result;
    },
  );

  ipcMain.handle(IPC.exportBundle, async (event, operationId?: string): Promise<string | null> => {
    const s = requireSession();
    const target = await dialog.showSaveDialog({
      title: 'Export as a standalone web page',
      buttonLabel: 'Export',
      defaultPath: `${basename(s.dir)}-web`,
      properties: ['createDirectory'],
    });
    if (target.canceled || !target.filePath) return null;
    const dir = deckFolderPath(target.filePath);
    await exportDeck(s.dir, s.deck, dir, (message, ratio) => {
      reportOperation(event, operationId, message, ratio);
    });
    return dir;
  });

  ipcMain.handle(IPC.exportPdf, async (
    event,
    request: PdfExportRequest = {},
    operationId?: string,
  ): Promise<string | null> => {
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

    reportOperation(event, operationId, 'Rendering slide pages', null);
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
      reportOperation(event, operationId, 'Checking rendered pages', 0.6);
      const renderError = await printWindow.webContents.executeJavaScript(
        'document.documentElement.dataset.error || ""',
      ) as string;
      if (renderError) throw new Error(renderError);
      reportOperation(event, operationId, 'Generating PDF data', 0.75);
      const pdf = await printWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
      });
      reportOperation(event, operationId, `Writing ${basename(target.filePath)}`, 0.95);
      await writeFile(target.filePath, pdf);
      reportOperation(event, operationId, 'PDF export complete', 1);
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

  const stopDeckWatchers = (): void => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const startHostedServer = async (
    s: DeckSession,
    agentMode: boolean,
    onSessionEnd: () => void,
  ): Promise<RunningCollabServer> => {
    const clientDir = defaultClientDir(app.getAppPath());
    if (!clientDir) {
      throw new Error('The browser client is not built — run: npm run build:collab');
    }
    const base = {
      rootDir: dirname(s.dir),
      hostedDeckId: basename(s.dir),
      agentMode,
      clientDir,
      onSessionEnd,
      sharedAgent: agentMode ? undefined : desktopSharedAgent,
      sharedAgentAccess: agentMode ? undefined : 'loopback' as const,
      onHtmlDraft: agentMode ? (draft: HtmlDraftPreview) => {
        agentChat.setScratchpad(s.dir, {
          draftId: draft.draftId,
          slideCount: draft.slideCount,
          sourceUrl: draft.sourceUrl,
          importedUrl: draft.importedUrl,
          comparisonUrl: draft.comparisonUrl,
          sourceContactSheetUrl: draft.sourceContactSheetUrl,
          importedContactSheetUrl: draft.importedContactSheetUrl,
        });
      } : undefined,
      onNativeDraft: agentMode ? (draft: NativeDraftPreview) => {
        agentChat.setScratchpad(s.dir, {
          draftId: draft.draftId,
          slideCount: draft.slideCount,
          sourceUrl: draft.beforeUrl,
          importedUrl: draft.afterUrl,
          comparisonUrl: draft.comparisonUrl,
          sourceContactSheetUrl: draft.beforeUrl,
          importedContactSheetUrl: draft.afterUrl,
          sourceLabel: 'Before',
          importedLabel: 'After',
        });
      } : undefined,
      getAgentChatId: agentMode ? () => agentChat.chatId(s.dir) : undefined,
    };
    try {
      return await startCollabServer(base);
    } catch (error) {
      // 5800 taken (another session or app); any free port still shares fine.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      return startCollabServer({ ...base, port: 0 });
    }
  };

  /**
   * Start an authoritative HTTP session while keeping the native editor in
   * place as an ordinary WebSocket peer. Both embedded Agent mode and normal
   * user collaboration use this path; only the invite and shared-Agent policy
   * differ.
   */
  const startBackgroundSession = async (
    mode: 'agent' | 'collaboration',
  ): Promise<AgentSessionConnection> => {
    const s = requireSession();
    if (collabMode === 'window') throw new Error('End the current collaboration first');
    const deckId = basename(s.dir);
    const name = userInfo().username || 'Host';
    const wantedMode = mode === 'agent' ? 'agent-background' : 'collaboration-background';

    if (collabServer && collabMode !== wantedMode) {
      await endBackgroundAgentSession();
    }
    if (!collabServer) {
      collabServer = await startHostedServer(
        s,
        mode === 'agent',
        () => setImmediate(() => void endBackgroundAgentSession()),
      );
      collabMode = wantedMode;
      // The server is now the deck's sole writer. Native edits will reach it
      // through the WebSocket bridge returned below.
      stopDeckWatchers();
    }
    if (collabMode !== wantedMode) {
      throw new Error('A different collaboration session is already running');
    }

    copyJoinLink(collabServer.urls, deckId, mode === 'agent');
    const connection: AgentSessionConnection = {
      active: true,
      deckId,
      name,
      mode,
      wsUrl: `ws://127.0.0.1:${collabServer.port}/ws?deck=${encodeURIComponent(deckId)}`,
    };
    sendAgentSessionState(connection);
    return connection;
  };

  ipcMain.handle(
    IPC.agentSessionStart,
    async (): Promise<AgentSessionConnection> => startBackgroundSession('agent'),
  );
  ipcMain.handle(IPC.agentSessionEnd, async (): Promise<void> => {
    await endBackgroundAgentSession();
  });

  // Keep the native editor in place. Replacing it with a second BrowserWindow
  // made Collaborate slow and visually disruptive, and—more importantly—meant
  // tests never exercised native cursor publishing.
  ipcMain.handle(IPC.collabStart, async (
    _e,
    opts?: CollabStartRequest,
  ): Promise<AgentSessionConnection> => {
    if (opts?.agent) {
      return startBackgroundSession('agent');
    }
    return startBackgroundSession('collaboration');
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
