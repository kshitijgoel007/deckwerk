import type { Deck } from './deck.js';

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
  deckLoadTheme: 'deck:loadTheme',
  deckSaveTheme: 'deck:saveTheme',
  deckState: 'deck:state',
  themeCss: 'deck:themeCss',
  assetImport: 'asset:import',
  assetProbe: 'asset:probe',
  presentOpen: 'present:open',
  presentCursor: 'present:cursor',
  trimOpen: 'trim:open',
  trimRun: 'trim:run',
  trimProgress: 'trim:progress',
  trimDone: 'trim:done',
  keynoteImport: 'keynote:import',
  exportBundle: 'export:bundle',
} as const;

/** An open deck: its folder on disk plus the parsed document. */
export interface DeckSession {
  /** Absolute path to the deck folder containing deck.json. */
  dir: string;
  deck: Deck;
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
