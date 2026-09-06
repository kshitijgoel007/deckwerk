import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Deck } from '@shared/deck.js';
import type { DeckHistoryDocument } from '@shared/deckHistory.js';
import type { ClipboardReadResult, ClipboardWriteRequest } from '@shared/clipboard.js';
import type { ClipboardImageSource } from '@shared/clipboardImages.js';
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
  AgentRequest,
  AssetImportProgress,
  AgentResponse,
  AuthoredHtmlFile,
  CollabStartRequest,
  DeckSession,
  DeckSessionSnapshot,
  DeckHistorySession,
  ImportedAsset,
  KeynoteImportResult,
  MediaInfo,
  OperationProgress,
  PdfExportRequest,
  PresentationCommand,
  PresentationState,
  PresentOptions,
  RasterResult,
  RasterSaveRequest,
  RasterTarget,
  DisplayInfo,
  TrimProgress,
  TrimRequest,
  TrimResult,
  WorkflowStartRequest,
  WorkflowStartResult,
} from '@shared/ipc.js';

/**
 * The renderer's entire view of the outside world. Context isolation is on and
 * nodeIntegration is off, so this surface is deliberately small and explicit.
 */
const api = {
  newDeck: (operationId?: string): Promise<DeckSession | null> =>
    ipcRenderer.invoke(IPC.deckNew, operationId),
  openDeck: (operationId?: string): Promise<DeckSession | null> =>
    ipcRenderer.invoke(IPC.deckOpen, operationId),
  getDeck: (): Promise<DeckSession | null> => ipcRenderer.invoke(IPC.deckGet),
  openDeckPath: (dir: string): Promise<DeckSession> =>
    ipcRenderer.invoke(IPC.deckOpenPath, dir),
  saveDeck: (dir: string, deck: Deck): Promise<void> =>
    ipcRenderer.invoke(IPC.deckSave, dir, deck),
  syncDeckSnapshot: (snapshot: DeckSessionSnapshot): Promise<void> =>
    ipcRenderer.invoke(IPC.deckSyncSnapshot, snapshot),
  saveDeckAs: (operationId?: string): Promise<DeckSession | null> =>
    ipcRenderer.invoke(IPC.deckSaveAs, operationId),
  loadDeckHistory: (dir: string): Promise<DeckHistorySession> =>
    ipcRenderer.invoke(IPC.deckHistoryLoad, dir),
  saveDeckHistory: (dir: string, history: DeckHistoryDocument): Promise<void> =>
    ipcRenderer.invoke(IPC.deckHistorySave, dir, history),

  loadTheme: (): Promise<string> => ipcRenderer.invoke(IPC.deckLoadTheme),
  saveTheme: (css: string): Promise<void> => ipcRenderer.invoke(IPC.deckSaveTheme, css),

  /**
   * The element/slide clipboard rides the OS pasteboard under a private
   * format, which is what lets copy/paste cross into another running instance
   * of this app. Write attaches asset paths; read re-imports them.
   */
  writeClipboard: (request: ClipboardWriteRequest): Promise<void> =>
    ipcRenderer.invoke(IPC.clipboardWrite, request),
  readClipboard: (): Promise<ClipboardReadResult | null> =>
    ipcRenderer.invoke(IPC.clipboardRead),

  importAssets: (paths: string[], progressToken?: string): Promise<ImportedAsset[]> =>
    ipcRenderer.invoke(IPC.assetImport, paths, progressToken),
  /**
   * Import dropped Files. Electron resolves them to filesystem paths; the
   * browser collab client replaces this whole api object with one that
   * uploads the bytes instead — the drop handler prefers this method so both
   * environments share one code path. `progressToken` keys the progress
   * events pushed back over onAssetImportProgress.
   */
  importAssetFiles: (files: File[], progressToken?: string): Promise<ImportedAsset[]> =>
    ipcRenderer.invoke(
      IPC.assetImport,
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
      progressToken,
    ),
  /**
   * Import an image that a drag or a paste only pointed at — a remote URL or
   * an inline `data:` payload. The renderer cannot fetch cross-origin bytes
   * itself, so the main process goes and gets them.
   */
  importImageUrl: (source: ClipboardImageSource): Promise<ImportedAsset | null> =>
    ipcRenderer.invoke(IPC.assetImportUrl, source),
  onAssetImportProgress: (fn: (p: AssetImportProgress) => void): (() => void) =>
    on(IPC.assetImportProgress, fn),
  probeAsset: (src: string): Promise<MediaInfo> =>
    ipcRenderer.invoke(IPC.assetProbe, src),

  /**
   * A dropped File carries no usable path once context isolation is on;
   * `webUtils.getPathForFile` is the supported way to recover it, and it must
   * be called here in the preload where the Electron module exists.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  importKeynote: (operationId?: string): Promise<KeynoteImportResult | null> =>
    ipcRenderer.invoke(IPC.keynoteImport, operationId),
  exportBundle: (operationId?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportBundle, operationId),
  exportPdf: (request: PdfExportRequest = {}, operationId?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportPdf, request, operationId),
  onOperationProgress: (fn: (p: OperationProgress) => void): (() => void) =>
    on(IPC.operationProgress, fn),
  pdfReady: (jobId: string): void => ipcRenderer.send(IPC.exportPdfReady, jobId),
  exportHtml: (slideIds: string[]): Promise<string> => ipcRenderer.invoke(IPC.htmlExport, slideIds),
  startWorkflow: (request: WorkflowStartRequest): Promise<WorkflowStartResult> =>
    ipcRenderer.invoke(IPC.workflowStart, request),
  publishAgentContext: (context: AgentContextDraft): Promise<void> =>
    ipcRenderer.invoke(IPC.agentContextPublish, context),
  respondAgentRequest: (response: AgentResponse): void =>
    ipcRenderer.send(IPC.agentResponse, response),
  getAgentChatState: (): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatGetState),
  getAgentChatTranscript: (request: AgentChatSelectRequest): Promise<AgentChatTranscript | null> =>
    ipcRenderer.invoke(IPC.agentChatGetTranscript, request),
  selectAgentChat: (request: AgentChatSelectRequest): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatSelect, request),
  sendAgentChatMessage: (request: AgentChatSendRequest): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatSend, request),
  loginAgentChat: (): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatLogin),
  switchAgentChatAccount: (): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatSwitchAccount),
  setAgentChatModel: (request: AgentChatSetModelRequest): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatSetModel, request),
  setAgentChatReasoningEffort: (request: AgentChatSetReasoningEffortRequest): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatSetReasoningEffort, request),
  setAgentChatFastMode: (request: AgentChatSetFastModeRequest): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatSetFastMode, request),
  interruptAgentChat: (): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatInterrupt),
  resetAgentChat: (): Promise<AgentChatState> =>
    ipcRenderer.invoke(IPC.agentChatReset),

  /** Start sharing while keeping this native editor connected as the host. */
  startCollab: (opts: CollabStartRequest): Promise<AgentSessionConnection> =>
    ipcRenderer.invoke(IPC.collabStart, opts),
  /** Keep this native editor visible while it joins the agent's live session. */
  startAgentSession: (view: CollabStartRequest): Promise<AgentSessionConnection> =>
    ipcRenderer.invoke(IPC.agentSessionStart, view),
  endAgentSession: (): Promise<void> => ipcRenderer.invoke(IPC.agentSessionEnd),
  onAgentSessionState: (fn: (state: AgentSessionState) => void): (() => void) =>
    on(IPC.agentSessionState, fn),

  listDisplays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke(IPC.displayList),
  present: (slideIndex: number, options?: PresentOptions): Promise<void> =>
    ipcRenderer.invoke(IPC.presentOpen, slideIndex, options),
  sendPresentCommand: (command: PresentationCommand): void =>
    ipcRenderer.send(IPC.presentCommand, command),
  publishPresentState: (state: PresentationState): void =>
    ipcRenderer.send(IPC.presentState, state),
  onPresentCommand: (fn: (command: PresentationCommand) => void): (() => void) =>
    on(IPC.presentCommand, fn),
  onPresentState: (fn: (state: PresentationState) => void): (() => void) =>
    on(IPC.presentState, fn),

  openTrim: (payload: { src: string; elementId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC.trimOpen, payload),
  runTrim: (req: TrimRequest): Promise<TrimResult> =>
    ipcRenderer.invoke(IPC.trimRun, req),
  openRaster: (payload: RasterTarget): Promise<void> =>
    ipcRenderer.invoke(IPC.rasterOpen, payload),
  saveRaster: (req: RasterSaveRequest): Promise<RasterResult> =>
    ipcRenderer.invoke(IPC.rasterSave, req),

  /** Deck-relative asset path -> a URL this window can load. */
  assetUrl: (src: string): string =>
    `deck://asset/${src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`,

  onDeckState: (fn: (s: DeckSession) => void): (() => void) =>
    on(IPC.deckState, fn),
  onThemeCss: (fn: (css: string) => void): (() => void) => on(IPC.themeCss, fn),
  onAgentRequest: (fn: (request: AgentRequest) => void): (() => void) =>
    on(IPC.agentRequest, fn),
  onAgentChatState: (fn: (state: AgentChatState) => void): (() => void) =>
    on(IPC.agentChatState, fn),
  /** A file under the deck's `edit/` folder was saved and wants compiling. */
  onHtmlEdit: (fn: (file: AuthoredHtmlFile) => void): (() => void) =>
    on(IPC.htmlEdit, fn),
  /**
   * Write compile-assigned slide ids back into an authoring file — but only
   * if the file still holds `expected`, so a save that raced the compile is
   * never overwritten with a stamped copy of older contents.
   */
  htmlAdopt: (path: string, contents: string, expected: string): Promise<void> =>
    ipcRenderer.invoke(IPC.htmlAdopt, path, contents, expected),
  onTrimTarget: (fn: (p: { src: string; elementId: string }) => void): (() => void) =>
    on(IPC.trimOpen, fn),
  onTrimProgress: (fn: (p: TrimProgress) => void): (() => void) =>
    on(IPC.trimProgress, fn),
  onTrimDone: (fn: (r: TrimResult) => void): (() => void) => on(IPC.trimDone, fn),
  onRasterTarget: (fn: (target: RasterTarget) => void): (() => void) =>
    on(IPC.rasterOpen, fn),
  onRasterDone: (fn: (result: RasterResult) => void): (() => void) =>
    on(IPC.rasterDone, fn),
};

/** Subscribe to a main-process push, returning an unsubscribe function. */
function on<T>(channel: string, fn: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
