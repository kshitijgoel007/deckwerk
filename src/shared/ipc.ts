import type { Deck } from './deck.js';
import type { DeckHistoryDocument } from './deckHistory.js';
import type { AgentContextDraft, AgentRequest, AgentResponse } from './agent.js';
import type { EditorViewSnapshot } from './editorView.js';

/**
 * The contract between the renderer and the main process. Both sides import
 * these types, so a channel can't drift out of sync with its payload.
 */

export const IPC = {
  deckOpen: 'deck:open',
  deckOpenPath: 'deck:openPath',
  deckGet: 'deck:get',
  deckNew: 'deck:new',
  deckSave: 'deck:save',
  deckSyncSnapshot: 'deck:syncSnapshot',
  deckSaveAs: 'deck:saveAs',
  deckHistoryLoad: 'deckHistory:load',
  deckHistorySave: 'deckHistory:save',
  deckLoadTheme: 'deck:loadTheme',
  deckSaveTheme: 'deck:saveTheme',
  deckState: 'deck:state',
  themeCss: 'deck:themeCss',
  assetImport: 'asset:import',
  assetImportProgress: 'asset:importProgress',
  clipboardWrite: 'clipboard:write',
  clipboardRead: 'clipboard:read',
  assetProbe: 'asset:probe',
  presentOpen: 'present:open',
  displayList: 'display:list',
  presentCursor: 'present:cursor',
  presentCommand: 'present:command',
  presentState: 'present:state',
  trimOpen: 'trim:open',
  trimRun: 'trim:run',
  trimProgress: 'trim:progress',
  trimDone: 'trim:done',
  rasterOpen: 'raster:open',
  rasterSave: 'raster:save',
  rasterDone: 'raster:done',
  keynoteImport: 'keynote:import',
  exportBundle: 'export:bundle',
  exportPdf: 'export:pdf',
  exportPdfReady: 'export:pdfReady',
  operationProgress: 'operation:progress',
  htmlExport: 'html:export',
  htmlEdit: 'html:edit',
  htmlAdopt: 'html:adopt',
  agentContextPublish: 'agent:contextPublish',
  agentRequest: 'agent:request',
  agentResponse: 'agent:response',
  agentChatGetState: 'agentChat:getState',
  agentChatGetTranscript: 'agentChat:getTranscript',
  agentChatSelect: 'agentChat:select',
  agentChatSend: 'agentChat:send',
  agentChatLogin: 'agentChat:login',
  agentChatSwitchAccount: 'agentChat:switchAccount',
  agentChatSetModel: 'agentChat:setModel',
  agentChatSetReasoningEffort: 'agentChat:setReasoningEffort',
  agentChatSetFastMode: 'agentChat:setFastMode',
  agentChatInterrupt: 'agentChat:interrupt',
  agentChatReset: 'agentChat:reset',
  agentChatState: 'agentChat:state',
  workflowStart: 'workflow:start',
  collabStart: 'collab:start',
  agentSessionStart: 'agentSession:start',
  agentSessionEnd: 'agentSession:end',
  agentSessionState: 'agentSession:state',
} as const;

export type AgentChatConnection = 'connecting' | 'ready' | 'unavailable';
export type AgentChatAuth = 'unknown' | 'signedOut' | 'signedIn';

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  error?: boolean;
}

export interface AgentChatConversationSummary {
  chatId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  active: boolean;
}

export interface AgentChatTranscript {
  chatId: string;
  accountLabel: string | null;
  updatedAt: string;
  messages: AgentChatMessage[];
}

export interface AgentChatModel {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  reasoningEfforts: Array<{ effort: string; description: string }>;
  defaultReasoningEffort: string | null;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
}

export interface AgentChatScratchpad {
  draftId: string;
  slideCount: number;
  sourceUrl: string;
  importedUrl: string;
  sourceContactSheetUrl: string;
  importedContactSheetUrl: string;
}

/** Complete renderer snapshot for one open deck's embedded agent conversation. */
export interface AgentChatState {
  deckPath: string;
  /** Stable Codex thread id used to link Agent-authored history entries. */
  chatId: string | null;
  /** Current and archived conversations saved with this deck. */
  conversations: AgentChatConversationSummary[];
  connection: AgentChatConnection;
  auth: AgentChatAuth;
  accountLabel: string | null;
  models: AgentChatModel[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  fastMode: boolean;
  scratchpad: AgentChatScratchpad | null;
  busy: boolean;
  activity: string | null;
  messages: AgentChatMessage[];
  error: string | null;
}

export interface AgentChatSendRequest {
  text: string;
}

export interface AgentChatSelectRequest {
  chatId: string;
}

export interface AgentChatSetModelRequest {
  model: string;
}

export interface AgentChatSetReasoningEffortRequest {
  effort: string;
}

export interface AgentChatSetFastModeRequest {
  enabled: boolean;
}

/** The workflow templates a UI action can instantiate (see workflows/). */
export type WorkflowKind = 'rework-selected-slides' | 'beautify-deck' | 'draft-new-slides';

/** A UI request to hand part of the deck to an agent, with instructions. */
export interface WorkflowStartRequest {
  kind: WorkflowKind;
  /** The user's typed instructions, verbatim (may be empty). */
  instructions: string;
  /** Selection at the moment of the click; scope for rework workflows. */
  selectedSlideIds: string[];
  /** Active slide id — the insertion anchor for draft workflows. */
  activeSlideId: string | null;
}

export interface WorkflowStartResult {
  /** Where the assembled prompt was written, inside the deck folder. */
  promptPath: string;
  /** Directory of pre-rendered PNGs handed to the agent. */
  renderDir: string;
  /** True when a terminal running the agent was opened. */
  launched: boolean;
  /** How to start the agent by hand when it was not launched. */
  command: string;
}

export interface CollabStartRequest extends EditorViewSnapshot {
  agent?: boolean;
}

/** Native editor connection to the authoritative deck-scoped agent session. */
export interface AgentSessionConnection {
  active: true;
  deckId: string;
  wsUrl: string;
  name: string;
}

export type AgentSessionState = AgentSessionConnection | { active: false };

export type { AgentContextDraft, AgentRequest, AgentResponse };

export type PresentationCommand =
  | { type: 'next' | 'prev' | 'toggleBlank' | 'swapDisplays' | 'exit' }
  | { type: 'goTo'; slide: number };

export interface PresentationState {
  cursor: { slide: number; step: number };
  steps: number;
  startedAt: number;
  /** Reset whenever the presentation moves to a different slide, not for builds. */
  slideStartedAt: number;
  /** Inclusive bounds when presenting a multi-slide rail selection. */
  range?: { start: number; end: number };
}

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  width: number;
  height: number;
}

export interface PresentOptions {
  audienceDisplayId?: number;
  presenterDisplayId?: number;
  /** Open Speaker View even when audience and presenter resolve to one display. */
  speakerView?: boolean;
  /** Inclusive last slide when presenting a multi-slide rail selection. */
  endSlideIndex?: number;
}

export type PdfBuildMode = 'initial' | 'final' | 'every';
export interface PdfExportRequest {
  mode?: PdfBuildMode;
  includeHidden?: boolean;
}

/**
 * A saved file from the deck's `edit/` folder, on its way to being compiled.
 *
 * The main process watches; the editor's renderer is what lays the markup out,
 * so the contents travel rather than the reader.
 */
export interface AuthoredHtmlFile {
  /** Absolute path, used to name the resulting change. */
  path: string;
  contents: string;
}

/** An open deck: its folder on disk plus the parsed document. */
export interface DeckSession {
  /** Absolute path to the deck folder containing deck.json. */
  dir: string;
  deck: Deck;
}

/**
 * Authoritative renderer state while the collaboration server owns disk writes.
 * Main-process consumers (Present/PDF/web export) read this without becoming a
 * competing deck.json writer.
 */
export interface DeckSessionSnapshot {
  deck: Deck;
  themeCss: string;
}

/** History is returned with its owner so an overlapping deck switch is safe. */
export interface DeckHistorySession {
  dir: string;
  history: DeckHistoryDocument;
}

/** Result of copying a media file into the deck's assets/ folder. */
export interface ImportedAsset {
  /** Deck-relative path, e.g. "assets/demo.mp4". */
  src: string;
  kind: 'image' | 'video';
  /** Natural dimensions in px; null when they could not be determined. */
  width: number | null;
  height: number | null;
  /** Seconds, for video only. */
  duration: number | null;
}

/**
 * Progress of one in-flight asset import, keyed by the caller's token (which
 * is also the element's `pending:<token>` src, so the canvas can find the
 * placeholder to update).
 */
export interface AssetImportProgress {
  token: string;
  /** 'upload' is browser-only; the desktop app skips straight to processing. */
  phase: 'upload' | 'processing';
  /** 0..1, or null when the phase has no measurable progress. */
  ratio: number | null;
}

/** A phase update for a renderer-initiated operation that may take a while. */
export interface OperationProgress {
  /** Opaque renderer-generated id, so overlapping operations cannot cross-talk. */
  id: string;
  /** Human-readable current work, ideally naming the file being handled. */
  message: string;
  /** 0..1 when the operation can measure progress; null for an indeterminate phase. */
  ratio: number | null;
}

/** Probe results for a media file already inside the deck. */
export interface MediaInfo {
  width: number | null;
  height: number | null;
  duration: number | null;
}

/** A trim/crop job handed to ffmpeg. Crop is in source pixels. */
export interface TrimRequest {
  deckDir: string;
  /** Deck-relative source, e.g. "assets/demo.mp4". */
  src: string;
  start: number;
  end: number;
  crop: { x: number; y: number; w: number; h: number } | null;
  /** Stream-copy when no crop is requested. Fast and lossless, keyframe-aligned. */
  copyWhenPossible: boolean;
}

export interface TrimResult {
  /** Deck-relative path of the new file. The source is never modified. */
  src: string;
  width: number | null;
  height: number | null;
  duration: number | null;
}

export interface TrimProgress {
  /** 0..1, derived from ffmpeg's reported output time. */
  fraction: number;
  message: string;
}

/** The image element handed to the standalone raster paint window. */
export interface RasterTarget {
  src: string;
  elementId: string;
}

/** A PNG rendered by the raster editor, ready to become a derived deck asset. */
export interface RasterSaveRequest extends RasterTarget {
  width: number;
  height: number;
  png: Uint8Array;
}

export interface RasterResult extends RasterTarget {
  /** Deck-relative path of the new PNG. The source is never modified. */
  src: string;
  width: number;
  height: number;
}

/** Per-deck summary of what the Keynote importer could and could not map. */
export interface ImportReport {
  slides: number;
  elements: number;
  /** Archive type name -> how many instances were left as placeholders. */
  unsupported: Record<string, number>;
  warnings: string[];
}

export interface KeynoteImportResult {
  dir: string;
  deck: Deck;
  report: ImportReport;
}
