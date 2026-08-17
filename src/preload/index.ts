import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Deck } from '@shared/deck.js';
import { IPC } from '@shared/ipc.js';
import type {
  AgentContextDraft,
  AgentRequest,
  AgentResponse,
  AuthoredHtmlFile,
  DeckSession,
  ImportedAsset,
  KeynoteImportResult,
  MediaInfo,
  PresentationCommand,
  PresentationState,
  TrimProgress,
  TrimRequest,
  TrimResult,
} from '@shared/ipc.js';

/**
 * The renderer's entire view of the outside world. Context isolation is on and
 * nodeIntegration is off, so this surface is deliberately small and explicit.
 */
const api = {
  newDeck: (): Promise<DeckSession | null> => ipcRenderer.invoke(IPC.deckNew),
  openDeck: (): Promise<DeckSession | null> => ipcRenderer.invoke(IPC.deckOpen),
  getDeck: (): Promise<DeckSession | null> => ipcRenderer.invoke(IPC.deckGet),
  openDeckPath: (dir: string): Promise<DeckSession> =>
    ipcRenderer.invoke(IPC.deckOpenPath, dir),
  saveDeck: (deck: Deck): Promise<void> => ipcRenderer.invoke(IPC.deckSave, deck),

  loadTheme: (): Promise<string> => ipcRenderer.invoke(IPC.deckLoadTheme),
  saveTheme: (css: string): Promise<void> => ipcRenderer.invoke(IPC.deckSaveTheme, css),

  importAssets: (paths: string[]): Promise<ImportedAsset[]> =>
    ipcRenderer.invoke(IPC.assetImport, paths),
  probeAsset: (src: string): Promise<MediaInfo> =>
    ipcRenderer.invoke(IPC.assetProbe, src),

  /**
   * A dropped File carries no usable path once context isolation is on;
   * `webUtils.getPathForFile` is the supported way to recover it, and it must
   * be called here in the preload where the Electron module exists.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  importKeynote: (): Promise<KeynoteImportResult | null> =>
    ipcRenderer.invoke(IPC.keynoteImport),
  exportBundle: (): Promise<string | null> => ipcRenderer.invoke(IPC.exportBundle),
  exportHtml: (slideIds: string[]): Promise<string> => ipcRenderer.invoke(IPC.htmlExport, slideIds),
  publishAgentContext: (context: AgentContextDraft): Promise<void> =>
    ipcRenderer.invoke(IPC.agentContextPublish, context),
  respondAgentRequest: (response: AgentResponse): void =>
    ipcRenderer.send(IPC.agentResponse, response),

  present: (slideIndex: number): Promise<void> =>
    ipcRenderer.invoke(IPC.presentOpen, slideIndex),
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

  /** Deck-relative asset path -> a URL this window can load. */
  assetUrl: (src: string): string =>
    `deck://asset/${src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`,

  onDeckState: (fn: (s: DeckSession) => void): (() => void) =>
    on(IPC.deckState, fn),
  onThemeCss: (fn: (css: string) => void): (() => void) => on(IPC.themeCss, fn),
  onAgentRequest: (fn: (request: AgentRequest) => void): (() => void) =>
    on(IPC.agentRequest, fn),
  /** A file under the deck's `edit/` folder was saved and wants compiling. */
  onHtmlEdit: (fn: (file: AuthoredHtmlFile) => void): (() => void) =>
    on(IPC.htmlEdit, fn),
  onTrimTarget: (fn: (p: { src: string; elementId: string }) => void): (() => void) =>
    on(IPC.trimOpen, fn),
  onTrimProgress: (fn: (p: TrimProgress) => void): (() => void) =>
    on(IPC.trimProgress, fn),
  onTrimDone: (fn: (r: TrimResult) => void): (() => void) => on(IPC.trimDone, fn),
};

/** Subscribe to a main-process push, returning an unsubscribe function. */
function on<T>(channel: string, fn: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
