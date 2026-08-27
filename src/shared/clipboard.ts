import { z } from 'zod';
import {
  ElementSchema,
  SlideSchema,
  TimelineEntrySchema,
  type Slide,
  type SlideElement,
  type TimelineEntry,
} from './deck.js';
import { makeId } from './geometry.js';
import type { ImportedAsset } from './ipc.js';

/**
 * Cross-instance clipboard payloads.
 *
 * Each app instance is a separate process with its own main process, so the
 * only channel between them is the OS clipboard. Copy serialises the selection
 * (elements + the timeline entries that drive them, or whole slides) into a
 * versioned JSON envelope stored under a private clipboard format; paste
 * validates it with the same Zod schemas the deck file uses, re-imports any
 * referenced assets into the destination deck, and mints fresh ids.
 *
 * Assets travel as absolute paths rather than embedded bytes: both instances
 * run on the same machine, and a 200 MB video has no business being base64'd
 * through the pasteboard. Import-by-content-hash makes re-import idempotent.
 */

/** Private pasteboard format name. Other apps never see or parse this. */
export const CLIPBOARD_FORMAT = 'com.slide-editor.deck-fragment';

const AssetRefSchema = z.object({
  /** Deck-relative path as referenced by the copied content. */
  src: z.string(),
  /** Absolute path in the source deck, for re-import at paste time. */
  absPath: z.string(),
});

const envelopeBase = {
  format: z.literal(CLIPBOARD_FORMAT),
  version: z.literal(1),
  assets: z.array(AssetRefSchema).default([]),
};

export const ClipboardPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    ...envelopeBase,
    kind: z.literal('elements'),
    elements: z.array(ElementSchema).min(1),
    /** Timeline entries whose action targets a copied element. */
    timeline: z.array(TimelineEntrySchema).default([]),
  }),
  z.object({
    ...envelopeBase,
    kind: z.literal('slides'),
    slides: z.array(SlideSchema).min(1),
  }),
]);

export type ClipboardPayload = z.infer<typeof ClipboardPayloadSchema>;
/** Standard clipboard data supplied by another app. Spreadsheet copies
 *  normally include HTML, with tab-separated text as a portable fallback. */
export type ExternalHtmlClipboard = { kind: 'external-html'; html: string; text?: string };
/** A bitmap supplied by another app (notably a macOS screenshot). The main
 *  process imports it into the open deck before handing it to the renderer. */
export type ExternalImageClipboard = { kind: 'external-image'; asset: ImportedAsset };
export type ClipboardReadResult = ClipboardPayload | ExternalHtmlClipboard | ExternalImageClipboard;
export type AssetRef = z.infer<typeof AssetRefSchema>;

/** What the renderer hands to the main process; assets are attached there. */
export type ClipboardWriteRequest =
  | { kind: 'elements'; elements: SlideElement[]; timeline: TimelineEntry[] }
  | { kind: 'slides'; slides: Slide[] };

/** Parse untrusted clipboard bytes. Null rather than a throw: foreign or stale
 *  content on the pasteboard is normal, not an error. */
export function parseClipboardPayload(raw: unknown): ClipboardPayload | null {
  const result = ClipboardPayloadSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Every deck-relative asset path the payload references, deduplicated. */
export function collectAssetSrcs(request: ClipboardWriteRequest): string[] {
  const srcs = new Set<string>();
  const fromElements = (elements: SlideElement[]) => {
    for (const el of elements) {
      if (el.type === 'image') srcs.add(el.src);
      if (el.type === 'video') {
        srcs.add(el.src);
        if (el.poster) srcs.add(el.poster);
      }
    }
  };
  if (request.kind === 'elements') fromElements(request.elements);
  else {
    for (const slide of request.slides) {
      if (slide.background.image) srcs.add(slide.background.image);
      fromElements(slide.elements);
    }
  }
  return [...srcs];
}

/**
 * Point the payload at the destination deck's copies of each asset.
 * Unmapped srcs are left alone: a dangling reference renders as a broken
 * image, which is visible and fixable, unlike a silently dropped element.
 */
export function rewriteAssetSrcs(
  payload: ClipboardPayload,
  map: Map<string, string>,
): void {
  const rewriteElements = (elements: SlideElement[]) => {
    for (const el of elements) {
      if (el.type === 'image') el.src = map.get(el.src) ?? el.src;
      if (el.type === 'video') {
        el.src = map.get(el.src) ?? el.src;
        if (el.poster) el.poster = map.get(el.poster) ?? el.poster;
      }
    }
  };
  if (payload.kind === 'elements') rewriteElements(payload.elements);
  else {
    for (const slide of payload.slides) {
      if (slide.background.image) {
        slide.background.image = map.get(slide.background.image) ?? slide.background.image;
      }
      rewriteElements(slide.elements);
    }
  }
}

/**
 * Fresh ids for pasted elements and their timeline entries, so a paste can
 * never cross-wire with the originals (which may live in the same deck).
 * Mutates its arguments; callers pass clones.
 */
export function remapElementIds(
  elements: SlideElement[],
  timeline: TimelineEntry[],
): void {
  const remap = new Map<string, string>();
  for (const el of elements) {
    // Ancestry survives the copy so Magic Move auto-pair can still recognise
    // the element; the explicit pairing itself does not.
    el.lineageId = el.lineageId ?? el.id;
    const id = makeId(el.type);
    remap.set(el.id, id);
    el.id = id;
    el.magicMoveId = null;
  }
  for (const entry of timeline) {
    entry.id = makeId('t');
    entry.action.target = remap.get(entry.action.target) ?? entry.action.target;
    if (entry.trigger.ref) {
      // A ref pointing outside the copied set would dangle in the destination.
      entry.trigger.ref = remap.get(entry.trigger.ref) ?? null;
    }
  }
}

/** Fresh ids for a pasted slide and everything in it. Mutates its argument. */
export function remapSlideIds(slide: Slide): void {
  slide.id = makeId('slide');
  slide.magicMoveFromPrevious = false;
  remapElementIds(slide.elements, slide.timeline);
}
