import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { type Rect, fitScale, makeId } from '@shared/geometry.js';
import {
  applyElementBoxStyles,
  applyMediaFitStyles,
  applySlideRootStyles,
  applyVideoPlaybackState,
  applyTextRenderState,
  syncShapeBody,
  fitAutoText,
  renderElement,
  renderSlide,
  scheduleAutoFit,
  syncMediaFrame,
} from '../player/render.js';
import { openSlideLinkInNewTab, slideLinkFromEvent } from '../player/links.js';
import { expandTimeline } from '@shared/timeline.js';
import { classifyMediaName, makePendingSrc, pendingToken } from '@shared/media.js';
import {
  normalizeParagraphHtml,
  paragraphUnits,
  paragraphsToList,
  paragraphsToOrderedList,
  applyTableColumnWidths,
  pastedTableData,
  LIST_MARKER_COLOR_ATTRIBUTE,
  LIST_MARKER_COLOR_PROPERTY,
  type ListMarkerColorState,
} from '@shared/paragraphs.js';
import {
  applyPendingHud,
  clearPending,
  markPendingFailed,
  probeLocalFile,
  setPendingPreview,
  setPendingProgress,
} from './pendingUploads.js';
import { newComment, openCommentsPopover, openCount } from './comments.js';
import { reportRenderDivergences } from './renderInvariants.js';
import { HANDLES, type SnapLine, snapMove, snapResize } from './snapping.js';
import type { EditorStore } from './store.js';

export type TableSelection = {
  elementId: string;
  mode: 'cell' | 'row' | 'column' | 'range';
  /** Anchor cell where the pointer drag began. */
  row: number;
  column: number;
  /** Focus cell currently under the pointer. Together these form a rectangle. */
  rowEnd: number;
  columnEnd: number;
  rows: number;
  columns: number;
};

type TableBorderEdge = 'top' | 'right' | 'bottom' | 'left';
export type TableBorderPreset = 'none' | 'vertical' | 'horizontal';
export type TableBorderSettings = { color: string; width: number; drawing: boolean };

/**
 * The editing surface: the slide rendered by the player, with an interaction
 * layer of selection outlines, resize handles and snap guides drawn on top.
 *
 * The rendered slide is deliberately the *same* DOM the player produces, so
 * what you drag things onto is what the projector shows. The overlay is a
 * sibling layer, never mixed into the slide itself.
 */

const SNAP_SCREEN_PX = 6;
/** Forgiving screen-space target around a visible line or arrow. */
const LINE_HIT_SCREEN_PX = 8;
/** Screen-pixel movement before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;

/** Replace a freshly typed ASCII arrow with the typographic glyph in place. */
function convertTypedArrow(body: HTMLElement, selection: Selection | null): boolean {
  if (!selection?.isCollapsed || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (!body.contains(node) || node.nodeType !== Node.TEXT_NODE || range.startOffset < 2) {
    return false;
  }
  const text = node.textContent ?? '';
  const start = range.startOffset - 2;
  if (text.slice(start, range.startOffset) !== '->') return false;

  node.textContent = `${text.slice(0, start)}→${text.slice(range.startOffset)}`;
  const caret = document.createRange();
  caret.setStart(node, start + 1);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return true;
}

/** Turn a Keynote-style marker paragraph into a real continuing HTML list. */
function convertTypedListMarker(body: HTMLElement, selection: Selection | null): boolean {
  if (!selection?.isCollapsed || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer)) return false;
  const parent = range.startContainer instanceof Element
    ? range.startContainer
    : range.startContainer.parentElement;
  if (parent?.closest('li')) return false; // the browser already continues real lists
  const block = parent?.closest('p, div') as HTMLElement | null;
  const source = block && body.contains(block) ? block : body;
  const text = (source.textContent ?? '').replace(/\u00a0/g, ' ');
  const beforeCaret = range.cloneRange();
  beforeCaret.selectNodeContents(source);
  beforeCaret.setEnd(range.startContainer, range.startOffset);
  if (beforeCaret.toString().replace(/\u00a0/g, ' ').length !== text.length) return false;
  const bullet = /^\s*[*-]\s+(.+)$/.exec(text);
  const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(text);
  if (!bullet && !numbered) return false;

  const list = document.createElement(numbered ? 'ol' : 'ul');
  if (numbered && numbered[1] !== '1') list.setAttribute('start', numbered[1]);
  const first = document.createElement('li');
  first.textContent = (bullet?.[1] ?? numbered?.[2] ?? '').trim();
  const next = document.createElement('li');
  next.appendChild(document.createElement('br'));
  list.append(first, next);
  if (source === body) body.replaceChildren(list);
  else source.replaceWith(list);

  const caret = document.createRange();
  caret.selectNodeContents(next);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return true;
}

/** Serialize authored text without editor-only table selection chrome. */
function authoredTextHtml(body: HTMLElement): string {
  const clone = body.cloneNode(true) as HTMLElement;
  // A collapsed-caret formatting command creates an editor-only typing run.
  // If the user typed into it, retain the authored style and text; if they
  // merely toggled a format and moved away, discard the empty run entirely.
  clone.querySelectorAll<HTMLElement>('[data-editor-typing-style]').forEach((marker) => {
    for (const text of [...marker.childNodes].filter((node): node is Text => node instanceof Text)) {
      text.data = text.data.replaceAll(TYPING_STYLE_SENTINEL, '');
    }
    marker.removeAttribute('data-editor-typing-style');
    if (!(marker.textContent ?? '')) marker.remove();
  });
  clone.querySelectorAll('.editor-table-selected, [class*="editor-table-border-preview-"]').forEach((cell) => {
    cell.classList.remove(
      'editor-table-selected',
      'editor-table-border-preview-top',
      'editor-table-border-preview-right',
      'editor-table-border-preview-bottom',
      'editor-table-border-preview-left',
    );
    (cell as HTMLElement).style.removeProperty('--table-border-preview-color');
    (cell as HTMLElement).style.removeProperty('--table-border-preview-width');
    if (cell.getAttribute('style') === '') cell.removeAttribute('style');
    if (cell.getAttribute('class') === '') cell.removeAttribute('class');
  });
  return normalizeParagraphHtml(clone.innerHTML);
}

/** Invisible text that gives a collapsed caret a stable styled DOM home. */
const TYPING_STYLE_SENTINEL = '\u2060';

/** True for the anonymous inline wrappers created by character formatting. */
function isStyleOnlySpan(node: Element): node is HTMLSpanElement {
  return node.tagName === 'SPAN'
    && [...node.attributes].every((attribute) => attribute.name === 'style');
}

/**
 * Collapse recursively wrapped formatting spans into one styled run per text
 * node, then merge adjacent equal runs. Repeated overlapping edits otherwise
 * grow a deep span tree, making selection lookup, serialization, collaboration
 * commits, and browser layout progressively slower.
 */
function normalizeInlineStyleSpans(root: HTMLElement): void {
  const authoredStyles = new Map<Text, Array<[string, string, string]>>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    if (!text.data) continue;
    const ancestors: HTMLSpanElement[] = [];
    for (let parent = text.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (isStyleOnlySpan(parent)) ancestors.push(parent);
    }
    if (ancestors.length === 0) continue;
    const properties = new Map<string, [string, string]>();
    for (const span of ancestors.reverse()) {
      for (let index = 0; index < span.style.length; index += 1) {
        const property = span.style.item(index);
        properties.set(property, [
          span.style.getPropertyValue(property),
          span.style.getPropertyPriority(property),
        ]);
      }
    }
    authoredStyles.set(text, [...properties.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([property, [value, priority]]) => [property, value, priority]));
  }

  // Moving children out preserves the Text node identities stored above.
  for (const span of [...root.querySelectorAll('span')].filter(isStyleOnlySpan)) {
    span.replaceWith(...span.childNodes);
  }
  for (const [text, properties] of authoredStyles) {
    if (!text.isConnected || properties.length === 0) continue;
    const span = document.createElement('span');
    for (const [property, value, priority] of properties) {
      span.style.setProperty(property, value, priority);
    }
    text.replaceWith(span);
    span.appendChild(text);
  }

  const parents = [root, ...root.querySelectorAll<HTMLElement>('*')];
  for (const parent of parents) {
    for (let current = parent.firstChild; current;) {
      const next = current.nextSibling;
      if (
        current instanceof HTMLSpanElement
        && next instanceof HTMLSpanElement
        && isStyleOnlySpan(current)
        && isStyleOnlySpan(next)
        && current.getAttribute('style') === next.getAttribute('style')
      ) {
        current.append(...next.childNodes);
        next.remove();
        continue;
      }
      current = next;
    }
    parent.normalize();
  }
}
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;
const HANDLE_NAMES = Object.keys(HANDLES);
type MoveOrigin = Rect & { control?: { x: number; y: number } };
type ResizeOrigin = Rect & {
  rot: number;
  sourceBox?: Rect | null;
  control?: { x: number; y: number } | null;
};

type DragMode =
  | { kind: 'none' }
  | { kind: 'move'; startCanvas: { x: number; y: number }; origin: Map<string, MoveOrigin> }
  | {
      kind: 'resize';
      handle: string;
      startCanvas: { x: number; y: number };
      origin: Rect;
      origins: Map<string, ResizeOrigin>;
      elementId: string;
      aspect: number;
    }
  | {
      kind: 'table-column-resize';
      elementId: string;
      column: number;
      startCanvas: { x: number; y: number };
      originWidths: number[];
    }
  | {
      kind: 'rotate';
      elementId: string;
      startCanvas: { x: number; y: number };
      center: { x: number; y: number };
      originRotation: number;
      lastAngle: number;
      accumulatedAngle: number;
    }
  | { kind: 'marquee'; startCanvas: { x: number; y: number } }
  | { kind: 'endpoint'; which: 'start' | 'end'; elementId: string }
  | { kind: 'curve-control'; elementId: string };

export class EditorCanvas {
  private store: EditorStore;
  private host: HTMLElement;
  private stage: HTMLElement;
  private slideLayer: HTMLElement;
  private overlay: HTMLElement;
  private zoomInput: HTMLInputElement;
  private tableHeightSyncPending = false;

  /** Final canvas-pixel to screen-pixel scale (fit scale × user zoom). */
  private scale = 1;
  /** User zoom relative to the editor's normal fitted view. */
  private zoom = 1;
  /** Screen-pixel displacement from the centred stage position. */
  private pan = { x: 0, y: 0 };
  private drag: DragMode = { kind: 'none' };
  /**
   * Whether the pointer has moved far enough to count as a drag.
   *
   * Below the threshold nothing is committed, so a click — including each half
   * of a double-click — never mutates the deck and never triggers a redraw.
   * That keeps the DOM stable long enough for the browser to deliver `click`
   * and `dblclick`, and stops a stray pixel of hand movement from nudging an
   * element every time you select it.
   */
  private dragStarted = false;

  /**
   * Decoded `<video>` elements rescued from slide rebuilds, keyed by resolved
   * source URL. A freshly created `<video>` paints black until the network
   * round-trips and a frame is decoded — seconds on a remote collab session —
   * so when a rebuild (most visibly: switching slides) would recreate a video
   * whose media this canvas has already decoded, the old element is adopted
   * into the new DOM instead. See docs/media-loading.md, "DOM churn".
   */
  private videoPool = new Map<string, HTMLVideoElement[]>();
  /** The slide object currently drawn, used to skip needless rebuilds. */
  private renderedSlide: Slide | null = null;
  private guides: SnapLine[] = [];
  private marquee: Rect | null = null;

  /** Called to open the trim window for a video. */
  onTrimRequest?: (el: Extract<SlideElement, { type: 'video' }>) => void;

  /**
   * Stream text edits to the store while typing (throttled), instead of only
   * on blur. Enabled by the collab shell so peers watch each other type; off
   * in the desktop app, where it would only churn the undo stack and autosave.
   */
  liveTextSync = false;

  /** Id of the text element currently being edited in place, if any. */
  private editingId: string | null = null;
  /** Distinguishes editing sessions, so undo coalescing never spans two. */
  private textEditSession = 0;
  /** Coalesce key for the session's stream of live commits + the final one. */
  private textEditCoalesceKey: string | null = null;
  /** The element's html when the editing session began (live sync mutates it). */
  private textEditOriginalHtml: string | null = null;
  /** Last non-collapsed browser selection inside the active text element. */
  private textSelectionRange: Range | null = null;
  /** Rectangular cell range currently targeted in the live table editor. */
  private tableSelection: TableSelection | null = null;
  /** Shared paint used by table border presets and the explicit edge tool. */
  private tableBorderSettingsValue: TableBorderSettings = {
    color: '#000000', width: 1, drawing: false,
  };
  private tableBorderPreview: { cell: HTMLTableCellElement; edge: TableBorderEdge } | null = null;
  /** A click (not a drag) on an already-selected text box enters editing here. */
  private pendingTextEdit: {
    elementId: string;
    clientX: number;
    clientY: number;
  } | null = null;

  /**
   * Id of the element whose crop is being edited, if any.
   *
   * In mask mode the handles resize the *window* rather than the element, and
   * the media behind stays put — which is exactly what cropping means. The
   * whole frame is shown at reduced opacity outside the window so you can see
   * what you are cutting away.
   */
  private maskingId: string | null = null;
  private buildBadgesVisible = false;
  /** The crop as it was when the current mask drag began. */
  private maskOrigin: { x: number; y: number; w: number; h: number } | null = null;

  /** Notified when mask mode turns on or off, so the inspector can relabel. */
  onMaskModeChange?: (elementId: string | null) => void;
  /** Notified when inline text editing starts or ends. */
  onTextEditModeChange?: (elementId: string | null) => void;
  /** Notified when the active caret's pending character style changes. */
  onTextFormatStateChange?: () => void;
  /** Notified when a pasted table or its active cell changes. */
  onTableSelectionChange?: () => void;
  onTableBorderPaintModeChange?: () => void;
  /** Routes undo/redo through the active shell while editing text in place. */
  onUndoRequest?: (redo: boolean) => void;
  /** Pointer position in slide space on every move, null on leave. For presence. */
  onPointerSample?: (point: { x: number; y: number } | null) => void;
  /** Fired after the stage scale/placement recomputes. For presence overlays. */
  onViewportChange?: () => void;

  /**
   * Context-menu actions, supplied by the shell so the menu can reach
   * clipboard, trim and z-order without the canvas owning any of them.
   */
  contextActions?: (el: SlideElement | null) => Array<
    { label: string; action: () => void } | 'separator'
  >;

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.store = store;

    this.host.classList.add('canvas-host');
    this.stage = document.createElement('div');
    this.stage.className = 'stage';
    this.slideLayer = document.createElement('div');
    this.slideLayer.className = 'slide-layer';
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay-layer';
    this.stage.append(this.slideLayer, this.overlay);
    const zoomControls = this.createZoomControls();
    this.zoomInput = zoomControls.querySelector<HTMLInputElement>('.zoom-value')!;
    this.host.replaceChildren(this.stage, zoomControls);

    new ResizeObserver(() => this.rescale()).observe(this.host);
    this.bindPointer();
    // Text edit mode restores raw authored markup, so its anchors may not carry
    // the renderer-injected target yet. Intercept activation at the canvas edge
    // and open it explicitly; this also keeps the authored HTML unmodified.
    this.host.addEventListener('click', (event) => openSlideLinkInNewTab(event));
    this.bindViewportGestures();
    this.bindDrop();
    document.addEventListener('selectionchange', () => this.captureTextSelection());

    store.subscribe(() => this.render());
    this.render();
  }

  /**
   * Redraw.
   *
   * The slide layer is rebuilt only when the slide's content actually changed;
   * a selection change redraws the overlay alone. Two reasons this matters
   * beyond speed: rebuilding replaces `<video>` elements, which would reload
   * and restart every clip each time you clicked something, and it detaches the
   * node under the pointer, which stops the browser delivering `click` and
   * `dblclick`.
   *
   * The store deep-clones on every mutation, so object identity is an exact
   * test for "did the content change".
   */
  render(): void {
    const { deck, slideIndex, selection } = this.store.get();
    const slide = deck.slides[slideIndex];
    if (!slide) {
      this.slideLayer.replaceChildren();
      this.overlay.replaceChildren();
      this.renderedSlide = null;
      return;
    }

    if (slide === this.renderedSlide) {
      this.rescale();
      this.drawOverlay(deck, slide.elements, selection);
      this.scheduleTableHeightSync();
      return;
    }

    // Geometry-only changes — which is every frame of a drag or resize — are
    // applied to the existing nodes instead of rebuilding them. Rebuilding
    // recreates each <video>, which reloads the media and makes clips flicker
    // continuously while you drag anything on the slide.
    //
    // Html-only changes take the same path, with the changed elements rebuilt
    // individually. That is what lets a collaborator's typing stream in
    // without destroying the contenteditable node (and caret) of a text box
    // being edited on this machine.
    if (this.renderedSlide && sameStructure(this.renderedSlide, slide, true)) {
      const previous = this.renderedSlide;
      this.renderedSlide = slide;
      this.patchChangedHtml(slide, previous);
      this.applyGeometry(slide, previous);
      this.rescale();
      this.drawOverlay(deck, slide.elements, selection);
      // In development, verify that patching left the DOM where a full render
      // would have. A property handled by `renderElement` and not by the patch
      // path updates the deck without changing the pixels, and the only symptom
      // is that the change appears once something forces a rebuild. The element
      // being edited is excluded: its live DOM is deliberately the raw authored
      // source while the caret is in it.
      reportRenderDivergences(
        this.slideLayer,
        slide,
        (src) => window.api.assetUrl(src),
        {
          context: 'an in-place patch',
          skipElementIds: this.editingId ? [this.editingId] : [],
        },
      );
      this.scheduleTableHeightSync();
      return;
    }

    this.renderedSlide = slide;

    // Re-rendering under an active text edit would destroy the node the caret
    // lives in, so the edit is committed first.
    if (this.editingId) {
      this.commitTextEdit();
      // Committing re-enters the store, which notifies this canvas and runs a
      // nested render that has already painted the post-commit slide. Carrying
      // on here would paint the slide as it was *before* that commit, throwing
      // away the text just typed -- the way a collaborator's structural edit
      // used to swallow a word mid-sentence. The nested pass has done the work.
      const settled = this.store.get();
      if (settled.deck.slides[settled.slideIndex] !== slide) return;
    }

    // Which videos were playing before the redraw, so playback survives an
    // unrelated edit elsewhere on the slide.
    const playing = new Set<string>();
    for (const node of this.slideLayer.querySelectorAll<HTMLElement>('[data-element-id]')) {
      const video = node.querySelector('video');
      if (video && !video.paused) playing.add(node.dataset.elementId!);
    }

    this.harvestVideos();
    this.slideLayer.replaceChildren(
      renderSlide(slide, { resolveSrc: (src) => window.api.assetUrl(src), mediaPreload: 'metadata' }),
    );
    this.adoptVideos(slide);

    // Videos hold on their first frame while editing: a wall of looping clips
    // makes the canvas unreadable and burns CPU. Playback is opt-in per video,
    // while native controls remain visible when the element requests them.
    for (const node of this.slideLayer.querySelectorAll<HTMLElement>('[data-element-id]')) {
      const video = node.querySelector('video');
      if (!video) continue;
      const badge = document.createElement('span');
      badge.className = 'video-editor-badge';
      badge.textContent = '▶';
      badge.title = 'Video';
      badge.setAttribute('aria-label', 'Video');
      node.appendChild(badge);
      video.removeAttribute('autoplay');
      if (playing.has(node.dataset.elementId!)) void video.play().catch(() => {});
      else video.pause();
    }

    // A rebuild replaces placeholder nodes, wiping their progress rings and
    // preview frames; restore them from the client-local upload state.
    applyPendingHud(this.slideLayer);

    this.rescale();
    this.drawOverlay(deck, slide.elements, selection);
    this.scheduleTableHeightSync();
  }

  /** Keep native table frames tight around their laid-out rows. */
  private scheduleTableHeightSync(): void {
    if (this.tableHeightSyncPending) return;
    this.tableHeightSyncPending = true;
    requestAnimationFrame(() => {
      this.tableHeightSyncPending = false;
      if (this.editingId) return;
      const slide = this.store.slide;
      if (!slide) return;
      const heights = new Map<string, number>();
      for (const element of slide.elements) {
        if (element.type !== 'text' || !element.table?.autoHeight || element.autoFit) continue;
        const table = this.slideLayer.querySelector<HTMLTableElement>(
          `[data-element-id="${CSS.escape(element.id)}"] .text-content > table`,
        );
        const height = Math.ceil(table?.offsetHeight ?? 0);
        if (height >= 8 && Math.abs(height - element.h) > 1) heights.set(element.id, height);
      }
      if (heights.size === 0) return;
      this.store.commit((deck) => {
        const current = deck.slides[this.store.get().slideIndex];
        for (const element of current?.elements ?? []) {
          const height = heights.get(element.id);
          if (height !== undefined) element.h = height;
        }
      }, { label: 'Fit table rows', transient: true });
    });
  }

  /** Re-measure one table during its active resize transaction. */
  private syncTableHeight(elementId: string): void {
    const element = this.store.slide?.elements.find((candidate) => candidate.id === elementId);
    if (element?.type !== 'text' || !element.table?.autoHeight || element.autoFit) return;
    const table = this.slideLayer.querySelector<HTMLTableElement>(
      `[data-element-id="${CSS.escape(elementId)}"] .text-content > table`,
    );
    const height = Math.ceil(table?.offsetHeight ?? 0);
    if (height < 8 || Math.abs(height - element.h) <= 1) return;
    this.store.updateSelected((target) => {
      if (target.id === elementId) target.h = height;
    });
  }

  /**
   * Move the outgoing slide's decoded videos into the pool before the layer is
   * torn down, so the next render of the same media paints instantly.
   */
  private harvestVideos(): void {
    for (const video of this.slideLayer.querySelectorAll('video')) {
      // No decoded frame yet → nothing worth keeping alive.
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;
      // Keyed by presentation, not by file: an element is only reusable in a
      // slot that shows the same frame of the same file through the same
      // geometry. See `videoPresentationKey`.
      const key = video.dataset.mediaKey;
      if (!key) continue;
      const list = this.videoPool.get(key) ?? [];
      // Cap per key: enough for the densest realistic slide, without
      // hoarding decoder resources for media the deck has stopped showing.
      if (list.length >= 8) continue;
      video.pause();
      list.push(video);
      this.videoPool.set(key, list);
    }
  }

  /**
   * Replace freshly created (frameless, still-loading) `<video>` elements in
   * the new slide DOM with pooled ones that already hold a decoded frame.
   *
   * Only an element with the same presentation key is adopted, so the frame it
   * is already holding is exactly the frame this slot wants, painted through
   * exactly this slot's geometry: no seek, and nothing for the compositor to
   * stretch in the meantime.
   */
  private adoptVideos(slide: Slide): void {
    for (const el of slide.elements) {
      if (el.type !== 'video') continue;
      const fresh = this.videoNode(el.id);
      if (!fresh?.dataset.mediaKey) continue;
      const pooled = this.videoPool.get(fresh.dataset.mediaKey)?.pop();
      if (!pooled) continue;
      pooled.style.cssText = fresh.style.cssText;
      pooled.preload = fresh.preload;
      pooled.playsInline = true;
      pooled.removeAttribute('autoplay');
      applyVideoPlaybackState(pooled, el, { resolveSrc: (src) => window.api.assetUrl(src) });
      pooled.pause();
      // Matching keys mean the poster frame already matches too; a looping
      // clip that drifted still gets nudged back, which is invisible because
      // the geometry is identical either way.
      const posterTime = el.start > 0 ? el.start : 0.03;
      if (pooled.dataset.holdFrame !== 'true' && Math.abs(pooled.currentTime - posterTime) > 0.05) {
        pooled.currentTime = posterTime;
      }
      fresh.replaceWith(pooled);
      // Abort the fresh element's just-started fetch; the pooled element has
      // the bytes and the network is the scarce resource here.
      fresh.removeAttribute('src');
      fresh.load();
    }
  }

  /**
   * Rebuild just the elements whose html changed, in place. The element being
   * edited locally is left alone: its DOM is the live source of truth, and
   * replacing it would blur the contenteditable and eject the caret.
   */
  private patchChangedHtml(slide: Slide, previous: Slide): void {
    const before = new Map(previous.elements.map((e) => [e.id, e]));
    for (const el of slide.elements) {
      if (el.type !== 'text' && el.type !== 'html') continue;
      if (el.id === this.editingId) continue;
      const prev = before.get(el.id);
      if (!prev || !('html' in prev) || prev.html === el.html) continue;
      const node = this.slideLayer.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(el.id)}"]`,
      );
      if (!node) continue;
      node.replaceWith(renderElement(el, { resolveSrc: (src) => window.api.assetUrl(src) }));
    }
  }

  /** Reposition and restyle existing nodes for a non-structural change. */
  private applyGeometry(slide: Slide, previous?: Slide): void {
    // Layout identity lives on the rendered slide root. A preset change usually
    // keeps the same elements, so it takes this fast path rather than rebuilding
    // the DOM; keep the root class in sync as well as the element geometry.
    const resolve = { resolveSrc: (src: string) => window.api.assetUrl(src) };
    const rendered = this.slideLayer.querySelector<HTMLElement>(':scope > .slide');
    if (rendered) applySlideRootStyles(rendered, slide, resolve);

    for (const el of slide.elements) {
      const node = this.slideLayer.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(el.id)}"]`,
      );
      if (!node) continue;

      // The box and the text render state are written by the same functions
      // `renderElement` uses, so a property can never be handled by one path
      // and forgotten by the other. Everything below is genuinely editor-side:
      // details that live on child nodes a rebuild would have recreated.
      const before = previous?.elements.find((e) => e.id === el.id);
      applyElementBoxStyles(node, el, before);
      applyTextRenderState(node, el, before);
      if (el.type === 'image' || el.type === 'video') {
        syncMediaFrame(node, el);
        applyMediaFitStyles(node, el);
      }
      if (el.type === 'video') {
        const video = node.querySelector<HTMLVideoElement>('video');
        if (video) applyVideoPlaybackState(video, el, resolve);
      }

      // A shape's drawing is sized by its own viewBox, so the wrapper's new
      // box is not enough: rebuild the SVG for the current geometry.
      if (el.type === 'shape') syncShapeBody(node, el);
    }
  }

  /** Is a video currently playing on the canvas? */
  isPlaying(elementId: string): boolean {
    const video = this.videoNode(elementId);
    return video !== null && !video.paused;
  }

  /**
   * Play or pause a video in place on the editing canvas, so a clip can be
   * checked without leaving the editor or entering presentation mode.
   */
  toggleVideo(elementId: string): boolean {
    const video = this.videoNode(elementId);
    if (!video) return false;
    if (video.paused) {
      // The editor preview honours the trim exactly as the player does:
      // start at the in point, loop back to it at the out point.
      const el = this.store.slide?.elements.find((e) => e.id === elementId);
      if (el?.type === 'video' && (el.start > 0 || el.end !== null)) {
        if (video.currentTime < el.start || (el.end !== null && video.currentTime >= el.end)) {
          video.currentTime = el.start;
        }
        if (!video.dataset.trimWatch) {
          video.dataset.trimWatch = '1';
          video.addEventListener('timeupdate', () => {
            const cur = this.store.slide?.elements.find((e) => e.id === elementId);
            if (cur?.type !== 'video' || video.paused) return;
            const end = cur.end ?? Number.POSITIVE_INFINITY;
            if (video.currentTime >= end - 0.03) {
              if (cur.loop) video.currentTime = cur.start;
              else video.pause();
            }
          });
        }
      }
      void video.play().catch(() => {});
      return true;
    }
    video.pause();
    return false;
  }

  /** Clip length as known to the canvas video element, if metadata is in. */
  videoDuration(elementId: string): number | null {
    const video = this.videoNode(elementId);
    const d = video?.duration;
    return d && Number.isFinite(d) && d > 0 ? d : null;
  }

  /** Show the frame at `time` on the canvas, for live trim scrubbing. */
  seekVideo(elementId: string, time: number): void {
    const video = this.videoNode(elementId);
    if (!video) return;
    video.pause();
    const t = Math.max(0, time);
    // Seeking before metadata arrives is silently ignored by the browser, so
    // the preview would show nothing at all on a not-yet-touched clip.
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      video.currentTime = t;
    } else {
      video.addEventListener('loadedmetadata', () => (video.currentTime = t), {
        once: true,
      });
    }
  }

  private videoNode(elementId: string): HTMLVideoElement | null {
    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    return node?.querySelector('video') ?? null;
  }

  private rescale(): void {
    const { deck } = this.store.get();
    const r = this.host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // Leave a margin so handles on the outer edge stay grabbable.
    const fitted = fitScale(deck.canvas, { w: r.width - 64, h: r.height - 64 });
    const scale = fitted * this.zoom;
    this.scale = scale;

    for (const layer of [this.slideLayer, this.overlay]) {
      layer.style.width = `${deck.canvas.w}px`;
      layer.style.height = `${deck.canvas.h}px`;
    }
    this.stage.style.width = `${deck.canvas.w}px`;
    this.stage.style.height = `${deck.canvas.h}px`;
    this.stage.style.transform = `scale(${scale})`;
    this.stage.style.setProperty('--editor-inv-scale', String(1 / scale));
    this.stage.style.transformOrigin = 'top left';
    this.stage.style.left = `${(r.width - deck.canvas.w * scale) / 2 + this.pan.x}px`;
    this.stage.style.top = `${(r.height - deck.canvas.h * scale) / 2 + this.pan.y}px`;
    this.syncZoomInput();
    this.onViewportChange?.();
  }

  /** User-visible zoom percentage, relative to the normal fitted view. */
  zoomPercent(): number {
    return Math.round(this.zoom * 100);
  }

  /** Set zoom around the viewport centre. Exposed for shell actions and tests. */
  setZoomPercent(percent: number): void {
    this.setZoom(percent / 100);
  }

  /** Restore the normal fitted view and put the slide back in the middle. */
  recenter(): void {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.rescale();
  }

  private createZoomControls(): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'zoom-controls deck-only';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Canvas zoom');

    const button = (text: string, label: string, action: () => void) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'zoom-button';
      node.textContent = text;
      node.title = label;
      node.setAttribute('aria-label', label);
      node.addEventListener('click', action);
      return node;
    };

    const input = document.createElement('input');
    input.className = 'zoom-value';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', 'Zoom percentage');
    input.value = '100%';
    input.spellcheck = false;
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', () => this.commitZoomInput(input));
    input.addEventListener('blur', () => this.commitZoomInput(input));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') {
        this.syncZoomInput();
        input.blur();
      }
    });

    controls.append(
      button('−', 'Zoom out', () => this.setZoom(this.zoom - ZOOM_STEP)),
      input,
      button('+', 'Zoom in', () => this.setZoom(this.zoom + ZOOM_STEP)),
      button('⌖', 'Re-center slide', () => this.recenter()),
    );
    return controls;
  }

  private commitZoomInput(input: HTMLInputElement): void {
    const percent = Number.parseFloat(input.value.replace('%', '').trim());
    if (Number.isFinite(percent)) this.setZoomPercent(percent);
    else this.syncZoomInput();
  }

  private syncZoomInput(): void {
    if (this.zoomInput) this.zoomInput.value = `${this.zoomPercent()}%`;
  }

  /**
   * Zoom while keeping the canvas point under `anchor` fixed on screen.
   * Without an anchor, the viewport centre is used (buttons and direct input).
   */
  private setZoom(next: number, anchor?: { x: number; y: number }): void {
    const r = this.host.getBoundingClientRect();
    const { deck } = this.store.get();
    const bounded = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (r.width === 0 || r.height === 0) {
      this.zoom = bounded;
      this.syncZoomInput();
      return;
    }

    const point = anchor ?? { x: r.width / 2, y: r.height / 2 };
    const oldLeft = (r.width - deck.canvas.w * this.scale) / 2 + this.pan.x;
    const oldTop = (r.height - deck.canvas.h * this.scale) / 2 + this.pan.y;
    const canvasPoint = {
      x: (point.x - oldLeft) / this.scale,
      y: (point.y - oldTop) / this.scale,
    };

    this.zoom = bounded;
    const fitted = fitScale(deck.canvas, { w: r.width - 64, h: r.height - 64 });
    const nextScale = fitted * this.zoom;
    const centredLeft = (r.width - deck.canvas.w * nextScale) / 2;
    const centredTop = (r.height - deck.canvas.h * nextScale) / 2;
    this.pan = {
      x: point.x - canvasPoint.x * nextScale - centredLeft,
      y: point.y - canvasPoint.y * nextScale - centredTop,
    };

    // Returning to the fitted view should always recover the slide, even if it
    // had previously been panned far away.
    if (this.zoom === 1) this.pan = { x: 0, y: 0 };
    this.rescale();
    this.drawOverlay(deck, this.store.slide?.elements ?? [], this.store.get().selection);
  }

  private bindViewportGestures(): void {
    this.host.addEventListener('wheel', (event) => {
      if ((event.target as HTMLElement).closest('.zoom-controls')) return;

      // Chromium represents a macOS trackpad pinch as a wheel event with the
      // control modifier set. Anchoring it at the pointer makes the gesture
      // feel native and keeps the detail the user is inspecting under hand.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.host.clientHeight
            : 1;
        const factor = Math.exp(-event.deltaY * unit * 0.01);
        const hostRect = this.host.getBoundingClientRect();
        this.setZoom(this.zoom * factor, {
          x: event.clientX - hostRect.left,
          y: event.clientY - hostRect.top,
        });
        return;
      }

      // Ordinary wheel and two-finger scrolling pan the pasteboard at every
      // zoom level. Re-center is the explicit, predictable way home.
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.host.clientHeight
          : 1;
      this.pan.x -= event.deltaX * unit;
      this.pan.y -= event.deltaY * unit;
      this.rescale();
    }, { passive: false });
  }

  /**
   * A sibling of the slide and selection layers inside the scaled stage, in
   * slide coordinate space. Remote-presence decorations live in their own
   * layer because drawOverlay rebuilds the selection overlay wholesale on
   * every state change, which would throw away high-frequency cursor DOM.
   */
  addStageLayer(className: string): HTMLElement {
    const layer = document.createElement('div');
    layer.className = className;
    layer.style.pointerEvents = 'none';
    const { deck } = this.store.get();
    layer.style.width = `${deck.canvas.w}px`;
    layer.style.height = `${deck.canvas.h}px`;
    layer.style.position = 'absolute';
    layer.style.left = '0';
    layer.style.top = '0';
    this.stage.append(layer);
    return layer;
  }

  /** The element under live text edit, or null. For presence. */
  editingElementId(): string | null {
    return this.editingId;
  }

  /** Current stage scale, for counter-scaling constant-size decorations. */
  stageScale(): number {
    return this.scale;
  }

  /** Selection outlines, handles, snap guides and the marquee. */
  private drawOverlay(
    deck: Deck,
    elements: SlideElement[],
    selection: Set<string>,
  ): void {
    const frag = document.createDocumentFragment();

    // While the Build tab is open, number every element a build entry touches
    // so the cards in the panel can be matched to objects on the slide.
    if (this.buildBadgesVisible) {
      const slide = this.store.get().deck.slides[this.store.get().slideIndex];
      const numbersByElement = new Map<string, number[]>();
      // By-paragraph reveals get one badge per paragraph, pinned to the
      // paragraph's own line so each number matches its row in the panel.
      const paragraphNumbers = new Map<string, Array<{ part: number; num: number }>>();
      (slide ? expandTimeline(slide) : []).forEach((unit, i) => {
        if (unit.part !== null) {
          const list = paragraphNumbers.get(unit.action.target) ?? [];
          list.push({ part: unit.part, num: i + 1 });
          paragraphNumbers.set(unit.action.target, list);
        } else {
          const list = numbersByElement.get(unit.action.target) ?? [];
          list.push(i + 1);
          numbersByElement.set(unit.action.target, list);
        }
      });
      const makeBadge = (text: string, x: number, y: number) => {
        const badge = document.createElement('div');
        badge.className = 'build-badge';
        badge.textContent = text;
        badge.style.left = `${x}px`;
        badge.style.top = `${y}px`;
        badge.style.setProperty('--inv', String(1 / this.scale));
        frag.appendChild(badge);
      };
      const stageRect = this.stage.getBoundingClientRect();
      for (const el of elements) {
        const numbers = numbersByElement.get(el.id);
        if (numbers) makeBadge(numbers.join(','), el.x + el.w, el.y);
        const parts = paragraphNumbers.get(el.id);
        if (!parts) continue;
        const content = this.stage.querySelector<HTMLElement>(
          `[data-element-id="${CSS.escape(el.id)}"] .text-content`,
        );
        const units = content ? paragraphUnits(content) : [];
        for (const { part, num } of parts) {
          const rect = units[part]?.getBoundingClientRect();
          const y = rect && rect.height > 0
            ? (rect.top - stageRect.top) / this.scale
            : el.y + part * 24;
          makeBadge(String(num), el.x + el.w, y + 9);
        }
      }
    }

    // Comment badges: a small bubble pinned to the top-right corner of any
    // element that carries comments. Always visible (comments are useless if
    // you cannot find them), counter-scaled like the handles, clickable even
    // though the overlay itself is pointer-events: none.
    for (const el of elements) {
      const open = openCount(el.comments);
      if ((el.comments?.length ?? 0) === 0) continue;
      const bubble = document.createElement('div');
      bubble.className = `element-comment${open > 0 ? '' : ' resolved'}`;
      bubble.textContent = open > 0 ? String(open) : '✓';
      bubble.title = open > 0
        ? `${open} open comment${open === 1 ? '' : 's'}`
        : 'All comments resolved';
      bubble.style.left = `${el.x + el.w}px`;
      bubble.style.top = `${el.y}px`;
      bubble.style.setProperty('--inv', String(1 / this.scale));
      bubble.addEventListener('pointerdown', (e) => e.stopPropagation());
      bubble.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openElementComments(el.id, bubble.getBoundingClientRect());
      });
      frag.appendChild(bubble);
    }

    // In mask mode, show the full frame faintly outside the crop window so it
    // is clear what is being cut away rather than merely what is kept.
    if (this.maskingId) {
      const el = elements.find((e) => e.id === this.maskingId);
      if (el && (el.type === 'image' || el.type === 'video') && el.sourceBox) {
        const ghost = document.createElement('div');
        ghost.className = 'mask-ghost';
        ghost.style.left = `${el.x + el.sourceBox.x}px`;
        ghost.style.top = `${el.y + el.sourceBox.y}px`;
        ghost.style.width = `${el.sourceBox.w}px`;
        ghost.style.height = `${el.sourceBox.h}px`;
        frag.appendChild(ghost);
      }
    }

    for (const el of elements) {
      if (!selection.has(el.id)) continue;
      const box = document.createElement('div');
      box.className = `sel-box${this.maskingId === el.id ? ' masking' : ''}`;
      if (el.type === 'text' && el.table) box.classList.add('table-selection');
      box.style.left = `${el.x}px`;
      box.style.top = `${el.y}px`;
      box.style.width = `${el.w}px`;
      box.style.height = `${el.h}px`;
      const isLine = el.type === 'shape' && (el.shape === 'line' || el.shape === 'arrow');
      // The outline must sit on the element as drawn, not where the frame
      // would be at rot 0. Same rotation, same centre as the element node.
      // Line/arrow selections stay unrotated: their children (endpoints,
      // curve control, preview path) are positioned in canvas space, which
      // already includes the rotation — rotating the box would apply it twice.
      if (el.rot && !isLine) box.style.transform = `rotate(${el.rot}deg)`;
      // Counter-scale so outlines and handles stay one visual size at any zoom.
      box.style.setProperty('--inv', String(1 / this.scale));

      // Lines and arrows get endpoint handles instead of a resize box: what
      // you want to move is where the arrow starts and ends, not its bounding
      // rectangle.
      if (el.type === 'shape' && (el.shape === 'line' || el.shape === 'arrow')) {
        box.classList.add('line-sel');
        const pts = lineEndpoints(el);
        if (selection.size > 1) {
          box.classList.add('multi-line-sel');
          const ns = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(ns, 'svg');
          svg.classList.add('selection-line-preview');
          svg.setAttribute('width', String(el.w));
          svg.setAttribute('height', String(el.h));
          svg.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS(ns, 'path');
          const start = { x: pts.start.x - el.x, y: pts.start.y - el.y };
          const end = { x: pts.end.x - el.x, y: pts.end.y - el.y };
          path.setAttribute('d', el.control
            ? `M ${start.x} ${start.y} Q ${el.control.x - el.x} ${el.control.y - el.y} ${end.x} ${end.y}`
            : `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke-width', String(3 / this.scale));
          svg.appendChild(path);
          box.appendChild(svg);
          frag.appendChild(box);
          continue;
        }
        for (const which of ['start', 'end'] as const) {
          const h = document.createElement('div');
          h.className = 'handle handle-endpoint';
          h.dataset.endpoint = which;
          h.dataset.elementId = el.id;
          const p = pts[which];
          h.style.left = `${p.x - el.x}px`;
          h.style.top = `${p.y - el.y}px`;
          // left/top are the endpoint itself. Centre the complete border box,
          // independent of whichever visual size the editor theme gives it.
          h.style.margin = '0';
          h.style.transform = 'translate(-50%, -50%)';
          box.appendChild(h);
        }
        if (el.control) {
          const control = document.createElement('div');
          control.className = 'handle handle-curve-control';
          control.dataset.curveControl = 'true';
          control.dataset.elementId = el.id;
          control.style.left = `${el.control.x - el.x}px`;
          control.style.top = `${el.control.y - el.y}px`;
          control.style.margin = '0';
          control.style.transform = 'translate(-50%, -50%)';
          box.appendChild(control);
        }
        frag.appendChild(box);
        continue;
      }

      // PowerPoint-style multi-selection: every selected object keeps its own
      // handles. Dragging any one of them applies the same scale to all of the
      // selected objects around their corresponding opposite edges.
      const tableLayout = el.type === 'text' ? el.table : undefined;
      const handles = tableLayout
        ? HANDLE_NAMES.filter((name) => !['n', 's'].includes(name))
        : HANDLE_NAMES;
      for (const name of handles) {
        const h = document.createElement('div');
        h.className = `handle handle-${name}`;
        h.dataset.handle = name;
        h.dataset.elementId = el.id;
        box.appendChild(h);
      }
      if (selection.size === 1) {
        if (tableLayout && tableLayout.columnWidths.length > 1) {
          const total = tableLayout.columnWidths.reduce((sum, width) => sum + width, 0);
          let offset = 0;
          tableLayout.columnWidths.slice(0, -1).forEach((width, column) => {
            offset += width;
            const divider = document.createElement('div');
            divider.className = 'table-column-resize-handle';
            divider.dataset.tableColumn = String(column);
            divider.dataset.elementId = el.id;
            divider.style.left = `${offset / total * 100}%`;
            box.appendChild(divider);
          });
        }
      }
      frag.appendChild(box);
    }

    for (const g of this.guides) {
      const line = document.createElement('div');
      line.className = `guide guide-${g.axis}`;
      if (g.axis === 'x') {
        line.style.left = `${g.at}px`;
        line.style.height = `${deck.canvas.h}px`;
      } else {
        line.style.top = `${g.at}px`;
        line.style.width = `${deck.canvas.w}px`;
      }
      line.style.setProperty('--inv', String(1 / this.scale));
      frag.appendChild(line);
    }

    if (this.marquee) {
      const m = document.createElement('div');
      m.className = 'marquee';
      m.style.left = `${this.marquee.x}px`;
      m.style.top = `${this.marquee.y}px`;
      m.style.width = `${this.marquee.w}px`;
      m.style.height = `${this.marquee.h}px`;
      frag.appendChild(m);
    }

    this.overlay.replaceChildren(frag);
  }

  /** Screen point -> canvas point. */
  private toCanvas(ev: PointerEvent): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / this.scale, y: (ev.clientY - r.top) / this.scale };
  }

  private bindPointer(): void {
    this.host.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    this.host.addEventListener('pointermove', (ev) => {
      // Covers entering the canvas with Command already held, when this window
      // did not receive the original keydown.
      if (this.drag.kind === 'none') this.setRotationModifier(ev.metaKey);
      this.onPointerMove(ev);
    });
    this.host.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    this.host.addEventListener('pointercancel', () => this.endDrag());
    this.host.addEventListener('dblclick', (ev) => this.onDoubleClick(ev));
    this.host.addEventListener('contextmenu', (ev) => this.onContextMenu(ev));

    // Modifier state changes do not cause pointermove, so mirror Command onto
    // the canvas host to let CSS swap the handle cursor while it is hovered.
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Meta' || ev.metaKey) this.setRotationModifier(true);
    });
    window.addEventListener('keyup', (ev) => {
      if (ev.key === 'Meta' || !ev.metaKey) this.setRotationModifier(false);
    });
    window.addEventListener('blur', () => this.setRotationModifier(false));
  }

  private setRotationModifier(active: boolean): void {
    this.host.classList.toggle('command-rotate', active);
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    // Authored links are interactive slide content. Let Chromium activate the
    // prepared target=_blank link instead of turning the gesture into canvas
    // selection (whose preventDefault would suppress navigation entirely).
    if (slideLinkFromEvent(ev)) return;
    const target = ev.target as HTMLElement;
    // The no-deck welcome screen lives inside the canvas host, but its buttons
    // are ordinary application controls. Capturing their pointer on the canvas
    // changes the pointer-up target and prevents Chromium from synthesising a
    // click, which made all three welcome actions appear inert.
    if (target.closest('.welcome-screen, .zoom-controls')) return;
    const slide = this.store.slide;
    if (!slide) return;

    // Suppress the browser's own text selection: dragging across a slide would
    // otherwise sweep-select the text of every element it crossed.
    if (!this.editingId) ev.preventDefault();

    // preventDefault also suppresses the focus change a click normally causes,
    // so a previously focused surface (the slide rail) would keep owning
    // Backspace and delete the whole slide instead of the clicked object.
    if (!this.editingId && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    // Clicks inside an active text edit belong to the caret, not to dragging.
    if (this.editingId) {
      if (target.closest('.editing')) return;
      this.commitTextEdit();
    }
    const point = this.toCanvas(ev);
    this.host.setPointerCapture(ev.pointerId);

    // A click away from the active crop window is the implicit "Done" action.
    // Keep the click alive after leaving mask mode so it can still select the
    // object underneath (or begin a marquee on empty canvas). Mask handles are
    // allowed to sit just outside rounded/circular windows, so they count as
    // part of the active region even when their centre is outside the clip.
    if (this.maskingId) {
      const mask = slide.elements.find((candidate) => candidate.id === this.maskingId);
      const onActiveHandle = target.closest<HTMLElement>(
        `.handle[data-element-id="${CSS.escape(this.maskingId)}"]`,
      );
      if (
        !onActiveHandle &&
        (!mask || (mask.type !== 'image' && mask.type !== 'video') ||
          !mediaMaskContainsPoint(mask, point))
      ) {
        this.toggleMaskMode(null);
      }
    }

    // Like Keynote, Command turns any ordinary object handle into a rotation
    // handle. Curve controls remain dedicated to bending the curve.
    const rotationHandle = target.closest<HTMLElement>(
      '.handle:not(.handle-curve-control)[data-element-id]',
    );
    if (ev.metaKey && rotationHandle?.dataset.elementId) {
      const el = slide.elements.find(
        (candidate) => candidate.id === rotationHandle.dataset.elementId,
      );
      if (el) {
        const center = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
        const startAngle = Math.atan2(point.y - center.y, point.x - center.x);
        this.store.beginTransaction('Rotate object');
        this.host.classList.add('is-rotating');
        this.drag = {
          kind: 'rotate',
          elementId: el.id,
          startCanvas: point,
          center,
          originRotation: el.rot,
          lastAngle: startAngle,
          accumulatedAngle: 0,
        };
        return;
      }
    }

    // Bend handle on a quadratic line or arrow.
    if (target.dataset?.curveControl && target.dataset.elementId) {
      this.store.beginTransaction();
      this.drag = { kind: 'curve-control', elementId: target.dataset.elementId };
      return;
    }

    // A native table exposes its internal column boundaries directly on the
    // selection frame. Moving one preserves the table's total width and only
    // redistributes space between the adjacent columns.
    if (target.dataset?.tableColumn !== undefined && target.dataset.elementId) {
      const el = slide.elements.find((candidate) => candidate.id === target.dataset.elementId);
      const column = Number.parseInt(target.dataset.tableColumn, 10);
      if (el?.type === 'text' && el.table && Number.isInteger(column)) {
        this.store.beginTransaction('Resize table columns');
        this.drag = {
          kind: 'table-column-resize',
          elementId: el.id,
          column,
          startCanvas: point,
          originWidths: [...el.table.columnWidths],
        };
        return;
      }
    }

    // Endpoint handle on a line or arrow.
    const endpoint = target.dataset?.endpoint;
    if (endpoint && target.dataset.elementId) {
      this.store.beginTransaction();
      this.drag = {
        kind: 'endpoint',
        which: endpoint as 'start' | 'end',
        elementId: target.dataset.elementId,
      };
      return;
    }

    // Resize handle.
    const handle = target.dataset?.handle;
    if (handle && target.dataset.elementId) {
      const el = slide.elements.find((e) => e.id === target.dataset.elementId);
      if (el) {
        this.store.beginTransaction();
        if (el.type === 'image' || el.type === 'video') {
          // Captured once per drag: mask mode shifts this window, a plain
          // resize scales it with the box.
          this.maskOrigin = el.sourceBox ? { ...el.sourceBox } : null;
        }
        const origins = new Map<string, ResizeOrigin>();
        for (const selected of this.store.selectedElements()) {
          origins.set(selected.id, {
            x: selected.x,
            y: selected.y,
            w: selected.w,
            h: selected.h,
            rot: selected.rot,
            ...((selected.type === 'image' || selected.type === 'video')
              ? { sourceBox: selected.sourceBox ? { ...selected.sourceBox } : null }
              : {}),
            ...((selected.type === 'shape' && selected.control)
              ? { control: { ...selected.control } }
              : {}),
          });
        }
        this.drag = {
          kind: 'resize',
          handle,
          startCanvas: point,
          origin: { x: el.x, y: el.y, w: el.w, h: el.h },
          origins,
          elementId: el.id,
          aspect: el.w / el.h,
        };
        return;
      }
    }

    // Topmost element under the cursor wins, matching what you see.
    const hit = this.hitTest(point);
    if (hit) {
      const selection = this.store.get().selection;
      this.pendingTextEdit = !ev.shiftKey
        && selection.has(hit.id)
        && (hit.type === 'text' || hit.type === 'html')
        ? { elementId: hit.id, clientX: ev.clientX, clientY: ev.clientY }
        : null;
      if (!selection.has(hit.id)) {
        this.store.select([hit.id], ev.shiftKey);
      } else if (ev.shiftKey) {
        this.store.select([hit.id], true);
        return;
      }
      const origin = new Map<string, MoveOrigin>();
      for (const el of this.store.selectedElements()) {
        origin.set(el.id, {
          x: el.x, y: el.y, w: el.w, h: el.h,
          ...((el.type === 'shape' && el.control) ? { control: { ...el.control } } : {}),
        });
      }
      this.drag = { kind: 'move', startCanvas: point, origin };
      return;
    }

    if (!ev.shiftKey) this.store.clearSelection();
    this.drag = { kind: 'marquee', startCanvas: point };
  }

  private onPointerMove(ev: PointerEvent): void {
    // Presence: report the pointer in slide space whether hovering or
    // dragging, so collaborators see the cursor move, not only the edits.
    this.onPointerSample?.(this.toCanvas(ev));
    if (this.drag.kind === 'none') return;
    let slide = this.store.slide;
    if (!slide) return;

    const point = this.toCanvas(ev);
    const { deck } = this.store.get();
    const threshold = SNAP_SCREEN_PX / this.scale;

    // Ignore movement until it clears the threshold, in screen pixels so it
    // feels the same at any zoom. The marquee is exempt: it is always a drag.
    if (
      !this.dragStarted &&
      this.drag.kind !== 'marquee' &&
      this.drag.kind !== 'endpoint' &&
      this.drag.kind !== 'curve-control'
    ) {
      const start = this.drag.startCanvas;
      const moved =
        Math.hypot(point.x - start.x, point.y - start.y) * this.scale;
      if (moved < DRAG_THRESHOLD_PX) return;
      this.dragStarted = true;
      if (this.drag.kind === 'move') {
        const duplicating = ev.altKey;
        this.store.beginTransaction(
          duplicating ? 'Duplicate and move objects' : 'Move objects',
        );
        if (duplicating) {
          this.store.duplicateSelection({ x: 0, y: 0 });
          this.drag.origin = new Map(
            this.store.selectedElements().map((el) => [el.id, {
              x: el.x,
              y: el.y,
              w: el.w,
              h: el.h,
              ...((el.type === 'shape' && el.control)
                ? { control: { ...el.control } }
                : {}),
            }]),
          );
          // The duplicate commit creates a new current slide object. Use it
          // for snapping and movement rather than the stale pre-clone slide.
          slide = this.store.slide!;
        }
      }
    }

    switch (this.drag.kind) {
      case 'move': {
        const drag = this.drag;
        let dx = point.x - drag.startCanvas.x;
        let dy = point.y - drag.startCanvas.y;
        // Shift constrains to the dominant axis, the usual straight-line drag.
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }

        const ids = new Set(drag.origin.keys());
        // Snap to the boxes the author can see: a rotated neighbour's on-screen
        // extent is its rotated bounding box.
        const others = slide.elements
          .filter((e) => !ids.has(e.id))
          .map((e) => rotatedBounds(e));

        // Snap the group by its bounding box, then apply one delta to all
        // members, so relative positions inside a multi-selection are preserved.
        // The box is measured after rotation, since that is the outline the
        // author is lining up; a move is a pure translation, so the delta the
        // snap produces applies unchanged to the unrotated positions.
        const bounds = unionRect([...drag.origin.entries()].map(([id, origin]) => {
          const rot = slide.elements.find((e) => e.id === id)?.rot ?? 0;
          return rot ? rotatedBounds({ ...origin, rot } as SlideElement) : origin;
        }));
        const moved = { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
        const snapped = ev.metaKey
          ? { rect: moved, guides: [] } // Command suspends snapping for fine placement.
          : snapMove(moved, deck.canvas, others, threshold);
        this.guides = snapped.guides;

        const finalDx = snapped.rect.x - bounds.x;
        const finalDy = snapped.rect.y - bounds.y;
        this.store.updateSelected((el) => {
          const o = drag.origin.get(el.id);
          if (!o) return;
          el.x = Math.round(o.x + finalDx);
          el.y = Math.round(o.y + finalDy);
          if (el.type === 'shape' && 'control' in o && o.control) {
            el.control = {
              x: Math.round(o.control.x + finalDx),
              y: Math.round(o.control.y + finalDy),
            };
          }
        });
        break;
      }

      case 'table-column-resize': {
        const drag = this.drag;
        const element = slide.elements.find((candidate) => candidate.id === drag.elementId);
        if (element?.type !== 'text' || !element.table) break;
        const radians = element.rot * Math.PI / 180;
        const canvasDx = point.x - drag.startCanvas.x;
        const canvasDy = point.y - drag.startCanvas.y;
        const dx = radians
          ? canvasDx * Math.cos(radians) + canvasDy * Math.sin(radians)
          : canvasDx;
        const totalWeight = drag.originWidths.reduce((sum, width) => sum + width, 0);
        const pixels = drag.originWidths.map((width) => width / totalWeight * element.w);
        const left = drag.column;
        const right = left + 1;
        const pair = pixels[left] + pixels[right];
        const minimum = Math.min(40, pair / 2);
        pixels[left] = Math.max(minimum, Math.min(pair - minimum, pixels[left] + dx));
        pixels[right] = pair - pixels[left];
        this.store.updateSelected((target) => {
          if (target.id === drag.elementId && target.type === 'text' && target.table) {
            target.table.columnWidths = pixels;
            target.html = applyTableColumnWidths(target.html, pixels);
          }
        });
        this.syncTableHeight(drag.elementId);
        break;
      }

      case 'resize': {
        const drag = this.drag;
        const resizing = slide.elements.find((e) => e.id === drag.elementId);
        const tableResize = resizing?.type === 'text' && Boolean(resizing.table);
        const authoredEdges = HANDLES[drag.handle];
        const edges = tableResize
          ? { ...authoredEdges, top: false, bottom: false }
          : authoredEdges;
        const o = drag.origin;
        // Handles are drawn rotated with the element, so a drag along a handle's
        // own axis has to be read in the element's frame, not the canvas's.
        // Applying the raw canvas delta to unrotated edges made every handle on
        // a rotated object grow the wrong axis and drift the box as it went.
        const radians = ((resizing?.rot ?? 0) * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const canvasDx = point.x - drag.startCanvas.x;
        const canvasDy = point.y - drag.startCanvas.y;
        const dx = radians ? canvasDx * cos + canvasDy * sin : canvasDx;
        const dy = radians ? -canvasDx * sin + canvasDy * cos : canvasDy;

        // Option resizes about the element's center:
        // both sides move, and the center is re-pinned after constraints.
        const centered = ev.altKey;
        let rect: Rect = { ...o };
        if (centered) {
          if (edges.left) {
            rect.x = o.x + dx;
            rect.w = o.w - 2 * dx;
          }
          if (edges.right) {
            rect.x = o.x - dx;
            rect.w = o.w + 2 * dx;
          }
          if (edges.top) {
            rect.y = o.y + dy;
            rect.h = o.h - 2 * dy;
          }
          if (edges.bottom) {
            rect.y = o.y - dy;
            rect.h = o.h + 2 * dy;
          }
        } else {
          if (edges.left) {
            rect.x = o.x + dx;
            rect.w = o.w - dx;
          }
          if (edges.right) rect.w = o.w + dx;
          if (edges.top) {
            rect.y = o.y + dy;
            rect.h = o.h - dy;
          }
          if (edges.bottom) rect.h = o.h + dy;
        }

        // Shift constrains, and so does "Keep aspect ratio" on media — with it
        // off (fit: fill) a resize genuinely stretches the picture.
        const keepAspect =
          (resizing?.type === 'image' || resizing?.type === 'video') &&
          resizing.fit !== 'fill' &&
          !resizing.sourceBox;
        const constrained = ev.shiftKey || keepAspect;
        if (constrained) rect = constrainAspect(rect, o, edges, drag.aspect);

        // Guides align to what is on screen, which for a rotated neighbour is
        // its rotated bounding box, not its unrotated one.
        const others = slide.elements
          .filter((e) => !drag.origins.has(e.id))
          .map((e) => rotatedBounds(e));
        // A rotated element's own edges are not axis-aligned, so there is
        // nothing meaningful to snap them to; snapping it would only nudge the
        // box away from the pointer. Alt suspends snapping outright.
        const snapped = ev.altKey || radians
          ? { rect, guides: [] }
          : snapResize(rect, edges, deck.canvas, others, threshold);
        this.guides = snapped.guides;

        let r = { ...snapped.rect };
        // Snapping moves a single edge, which breaks the ratio the constraint
        // just imposed. Re-impose it so a keep-aspect resize cannot distort.
        if (constrained) r = constrainAspect(r, o, edges, drag.aspect);
        if (centered) {
          // Aspect constraints and snapping anchor the opposite corner, which
          // would drift the center — pin it back to where the drag started.
          r.x = o.x + (o.w - r.w) / 2;
          r.y = o.y + (o.h - r.h) / 2;
        }
        if (radians) {
          // CSS rotates about the box centre, so growing an edge in the local
          // frame swings the whole box around that centre. Move the centre by
          // the rotated version of its local displacement, which is what keeps
          // the edge opposite the handle pinned where the author sees it.
          const localDx = r.x + r.w / 2 - (o.x + o.w / 2);
          const localDy = r.y + r.h / 2 - (o.y + o.h / 2);
          r.x = o.x + o.w / 2 + (localDx * cos - localDy * sin) - r.w / 2;
          r.y = o.y + o.h / 2 + (localDx * sin + localDy * cos) - r.h / 2;
        }
        if (this.maskingId === drag.elementId) {
          // Cropping, not scaling: the window moves, the picture stays put.
          this.applyMaskResize(drag.elementId, r, drag.origin);
          break;
        }
        const scaleX = r.w / drag.origin.w;
        const scaleY = r.h / drag.origin.h;
        this.store.updateSelected((el) => {
          const origin = drag.origins.get(el.id);
          if (!origin) return;
          const resized = resizeByScale(origin, edges, scaleX, scaleY, centered);
          el.x = Math.round(resized.x);
          el.y = Math.round(resized.y);
          el.w = Math.max(1, Math.round(resized.w));
          el.h = Math.max(1, Math.round(resized.h));
          // Resizing a cropped element scales the whole picture with its
          // window, so the crop composition is preserved — without this, a
          // resize silently re-crops instead of scaling.
          if ((el.type === 'image' || el.type === 'video') && origin.sourceBox) {
            const fx = el.w / origin.w;
            const fy = el.h / origin.h;
            el.sourceBox = {
              x: Math.round(origin.sourceBox.x * fx),
              y: Math.round(origin.sourceBox.y * fy),
              w: Math.max(1, Math.round(origin.sourceBox.w * fx)),
              h: Math.max(1, Math.round(origin.sourceBox.h * fy)),
            };
          }
          if (el.type === 'shape' && origin.control) {
            const control = resizePointByScale(origin.control, origin, resized, scaleX, scaleY);
            el.control = { x: Math.round(control.x), y: Math.round(control.y) };
          }
        });
        for (const id of drag.origins.keys()) this.syncTableHeight(id);
        break;
      }

      case 'rotate': {
        const drag = this.drag;
        const angle = Math.atan2(point.y - drag.center.y, point.x - drag.center.x);
        let delta = angle - drag.lastAngle;
        // atan2 wraps at +/- pi. Accumulate the shortest step between pointer
        // samples so a drag can pass smoothly through that seam (or make more
        // than one full turn) without the object jumping by 360 degrees.
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        drag.accumulatedAngle += delta;
        drag.lastAngle = angle;

        let rotation = drag.originRotation + drag.accumulatedAngle * (180 / Math.PI);
        // Shift gives a precise, discoverable snap without changing the normal
        // free-rotation gesture.
        if (ev.shiftKey) rotation = Math.round(rotation / 15) * 15;
        rotation = Math.round(rotation * 10) / 10;
        this.store.updateSelected((target) => {
          if (target.id === drag.elementId) target.rot = rotation;
        });
        break;
      }

      case 'endpoint': {
        const drag = this.drag;
        const el = slide.elements.find((e) => e.id === drag.elementId);
        if (!el || el.type !== 'shape') break;
        const pts = lineEndpoints(el);
        const moved = { ...pts, [drag.which]: point };
        const geo = lineFromEndpoints(moved.start, moved.end, el.h);
        this.store.updateSelected((target) => {
          if (target.id !== drag.elementId) return;
          target.x = Math.round(geo.x);
          target.y = Math.round(geo.y);
          target.w = Math.round(geo.w);
          target.rot = Math.round(geo.rot * 10) / 10;
        });
        break;
      }

      case 'curve-control': {
        const drag = this.drag;
        this.store.updateSelected((target) => {
          if (target.id === drag.elementId && target.type === 'shape') {
            target.control = { x: Math.round(point.x), y: Math.round(point.y) };
          }
        });
        break;
      }

      case 'marquee': {
        const s = this.drag.startCanvas;
        this.marquee = {
          x: Math.min(s.x, point.x),
          y: Math.min(s.y, point.y),
          w: Math.abs(point.x - s.x),
          h: Math.abs(point.y - s.y),
        };
        this.drawOverlay(deck, slide.elements, this.store.get().selection);
        break;
      }
    }
  }

  private onPointerUp(ev: PointerEvent): void {
    const textEdit = !this.dragStarted ? this.pendingTextEdit : null;
    if (this.drag.kind === 'marquee' && this.marquee) {
      const slide = this.store.slide;
      if (slide) {
        const box = this.marquee;
        const hits = slide.elements
          .filter((e) => intersects(rotatedBounds(e), box))
          .map((e) => e.id);
        if (hits.length > 0) this.store.select(hits, ev.shiftKey);
      }
    }
    this.host.releasePointerCapture?.(ev.pointerId);
    this.endDrag();
    if (textEdit) this.beginTextEdit(textEdit.elementId, textEdit);
  }

  private endDrag(): void {
    this.store.endTransaction();
    this.drag = { kind: 'none' };
    this.dragStarted = false;
    this.host.classList.remove('is-rotating');
    this.maskOrigin = null;
    this.guides = [];
    this.marquee = null;
    this.pendingTextEdit = null;

    // Deliberately *not* a full render. Redrawing the slide layer here would
    // replace the node the pointer went down on, and a browser cannot
    // synthesise `click` — and therefore `dblclick` — when the original target
    // has left the document. That is what stopped double-click-to-edit from
    // working at all. Guides and the marquee live in the overlay, so redrawing
    // just the overlay is both sufficient and safe.
    const { deck, slideIndex, selection } = this.store.get();
    const slide = deck.slides[slideIndex];
    if (slide) this.drawOverlay(deck, slide.elements, selection);
  }

  /** Custom context menu: right-click selects the element and offers actions. */
  /**
   * Comments popover for one element. Public so the context menu's "Add
   * comment…" can open it; the badge drawn by drawOverlay uses it too.
   */
  openElementComments(elementId: string, anchor?: DOMRect): void {
    const slideId = this.store.slide?.id;
    if (!slideId) return;
    const find = (deck: Deck) =>
      deck.slides.find((s) => s.id === slideId)?.elements.find((e) => e.id === elementId);
    const current = () => find(this.store.get().deck)?.comments ?? [];
    // Anchor on the element's on-screen box when the caller has no badge rect.
    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const at = anchor ?? node?.getBoundingClientRect();
    if (!at) return;
    const mutate = (label: string, fn: (el: SlideElement) => void) => {
      this.store.commit((deck) => {
        const el = find(deck);
        if (el) fn(el);
      }, { label });
      pop.refresh(current());
    };
    const pop = openCommentsPopover({
      anchor: at,
      title: 'Comments',
      comments: current(),
      onAdd: (text) => mutate('Add comment', (el) => {
        (el.comments ??= []).push(newComment(text));
      }),
      onResolve: (id, resolved) => mutate(resolved ? 'Resolve comment' : 'Reopen comment', (el) => {
        const comment = el.comments?.find((c) => c.id === id);
        if (comment) comment.resolved = resolved;
      }),
      onDelete: (id) => mutate('Delete comment', (el) => {
        el.comments = (el.comments ?? []).filter((c) => c.id !== id);
        if (el.comments.length === 0) delete el.comments;
      }),
    });
  }

  private onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    document.getElementById('ctx-menu')?.remove();
    if (!this.contextActions) return;

    const hit = this.hitTest(this.toCanvas(ev as PointerEvent));
    if (hit && !this.store.get().selection.has(hit.id)) this.store.select([hit.id]);

    const items = this.contextActions(hit);
    if (items.length === 0) return;

    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;
    for (const item of items) {
      if (item === 'separator') {
        const hr = document.createElement('div');
        hr.className = 'ctx-sep';
        menu.appendChild(hr);
        continue;
      }
      const row = document.createElement('button');
      row.textContent = item.label;
      row.addEventListener('click', () => {
        menu.remove();
        item.action();
      });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    // A document-level pointerdown used to remove the menu *before* its row
    // could receive click, making actions such as Edit mask appear inert.
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    const close = () => menu.remove();
    setTimeout(() => document.addEventListener('pointerdown', close, { once: true }), 0);
  }

  /**
   * Double-click means "get into" the thing under the cursor: edit a text box,
   * play a video, open the trim window for nothing else.
   */
  private onDoubleClick(ev: PointerEvent | MouseEvent): void {
    // Once editing is active, native browser double-click selection owns this
    // gesture. Calling beginTextEdit again would select the entire text box and
    // replace the word selection the browser just made.
    if (this.editingId && (ev.target as HTMLElement).closest('.editing')) return;
    const slide = this.store.slide;
    if (!slide) return;
    const hit = this.hitTest(this.toCanvas(ev as PointerEvent));
    if (!hit) return;

    if (hit.type === 'text' || hit.type === 'html') {
      this.beginTextEdit(hit.id);
    } else if (hit.type === 'video') {
      this.toggleVideo(hit.id);
    }
  }

  /**
   * Edit a text element in place.
   *
   * The rendered node itself is made editable rather than overlaying an input,
   * so the text is styled by theme.css while you type and what you see is what
   * the slide will show.
   */
  beginTextEdit(
    elementId: string,
    caretPoint?: { clientX: number; clientY: number },
  ): void {
    const slide = this.store.slide;
    const el = slide?.elements.find((e) => e.id === elementId);
    if (!el || (el.type !== 'text' && el.type !== 'html')) return;

    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const body = node?.querySelector<HTMLElement>('.text-content') ?? null;
    if (!body) return;

    // Double-click selection and an existing caret belong to the rendered DOM
    // that is about to be replaced by authored markup. Preserve them as plain
    // text offsets first; a live Range whose nodes are detached by innerHTML
    // is otherwise silently collapsed or retargeted by Chromium.
    const existingSelection = window.getSelection();
    const existingRange = existingSelection?.rangeCount
      ? existingSelection.getRangeAt(0)
      : null;
    const existingOffsets = existingRange && body.contains(existingRange.commonAncestorContainer)
      ? this.textOffsetsForRange(body, existingRange)
      : null;

    this.editingId = elementId;
    this.tableSelection = null;
    node!.classList.add('editing');
    // The player replaces TeX delimiters with KaTeX DOM. Editing must expose
    // the authored source, otherwise a save would persist generated markup.
    //
    // Paragraphs are normalised to blocks first. Imported text separates them
    // with `<br>`, and pressing return next to one makes Chrome nest the rest
    // of the text inside a new `<div>` — after the second return every
    // paragraph but the first is buried a level down, out of reach of both
    // `--paragraph-spacing` and the by-paragraph builds. Blocks in, blocks
    // out: `defaultParagraphSeparator` then keeps return producing `<p>`.
    body.innerHTML = normalizeParagraphHtml(el.html, true);
    // jsdom has no execCommand; the editing command is a browser-only nicety.
    document.execCommand?.('defaultParagraphSeparator', false, 'p');
    body.contentEditable = 'true';
    body.spellcheck = false;
    body.style.outline = 'none';
    body.style.cursor = 'text';
    body.focus();

    const selection = window.getSelection();
    // Select-all is a placeholder affordance, not the default editing state.
    // Re-selecting all authored text on every entry makes the next keystroke
    // erase the box. For ordinary content, preserve the browser's caret/word
    // selection from the double-click instead.
    if (el.class.includes('placeholder')) {
      const range = document.createRange();
      range.selectNodeContents(body);
      selection?.removeAllRanges();
      selection?.addRange(range);
      this.textSelectionRange = range.cloneRange();
    } else if (caretPoint) {
      this.textSelectionRange = this.placeCaretAtPoint(body, caretPoint);
    } else if (existingOffsets) {
      this.restoreTextRange(body, existingOffsets);
    } else {
      this.textSelectionRange = null;
    }
    this.textEditCoalesceKey = `text:${elementId}:${++this.textEditSession}`;
    this.textEditOriginalHtml = el.html;
    this.onTextEditModeChange?.(elementId);

    // Live sync: stream the box's content to the store (and thus to
    // collaborators) while typing, throttled to one commit per interval. The
    // commits are transient — no undo slot, no history entry — and share this
    // session's coalesce key so the collab undo layer folds the whole stream
    // into one undoable "Edit text".
    let liveTimer = 0;
    const pushLive = () => {
      liveTimer = 0;
      if (this.editingId !== elementId) return;
      const html = authoredTextHtml(body);
      const current = this.store.slide?.elements.find((e) => e.id === elementId);
      if (!current || (current.type !== 'text' && current.type !== 'html')) return;
      if (current.html === html) return;
      const coalesceKey = this.textEditCoalesceKey ?? undefined;
      this.store.commit((deck) => {
        const target = deck.slides[this.store.get().slideIndex]?.elements.find(
          (e) => e.id === elementId,
        );
        if (target && (target.type === 'text' || target.type === 'html')) target.html = html;
      }, { label: 'Edit text', transient: true, coalesceKey });
    };

    const onPaste = (event: ClipboardEvent) => {
      const pasted = event.clipboardData?.getData('text/html') ?? '';
      const plainText = event.clipboardData?.getData('text/plain') ?? '';
      const tableData = pastedTableData(pasted, plainText);
      const safeTable = tableData?.html ?? null;
      if (!safeTable || !tableData) return;
      const template = document.createElement('template');
      template.innerHTML = safeTable;
      const table = template.content.querySelector('table')!;
      event.preventDefault();

      // Spreadsheet semantics inside a native table: paste the rectangular
      // range starting at the active cell, growing rows/columns as required.
      if (el.type === 'text' && el.table && this.tableSelection) {
        const destination = this.activeTable();
        const active = this.tableSelection;
        if (destination && active) {
          const sourceRows = [...table.rows];
          const requiredRows = active.row + sourceRows.length;
          const requiredColumns = active.column + tableData.columnWidths.length;
          while (destination.rows.length < requiredRows) {
            const row = destination.insertRow();
            for (let column = 0; column < Math.max(active.columns, requiredColumns); column++) {
              row.insertCell().appendChild(document.createElement('br'));
            }
          }
          for (const row of [...destination.rows]) {
            while (row.cells.length < requiredColumns) {
              row.insertCell().appendChild(document.createElement('br'));
            }
          }
          sourceRows.forEach((sourceRow, rowOffset) => {
            [...sourceRow.cells].forEach((sourceCell, columnOffset) => {
              const cell = destination.rows[active.row + rowOffset]
                ?.cells[active.column + columnOffset];
              if (!cell) return;
              cell.innerHTML = sourceCell.innerHTML;
              cell.style.cssText = sourceCell.style.cssText;
            });
          });
          active.rows = destination.rows.length;
          active.columns = Math.max(active.columns, requiredColumns);
          this.commitTableDom('Paste table cells', (widths) => {
            while (widths.length < requiredColumns) widths.push(1);
            return widths;
          });
          this.syncTableHeight(elementId);
          return;
        }
      }

      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && body.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(table);
        range.setStartAfter(table);
        range.collapse(true);
        selection!.removeAllRanges();
        selection!.addRange(range);
      } else {
        body.appendChild(table);
      }
      onInput();
      pushLive();
      this.onTableSelectionChange?.();
    };

    let tableDrag: { pointerId: number; row: number; column: number } | null = null;
    let borderPaintDrag: { pointerId: number; changed: boolean } | null = null;
    const tableCellFromEvent = (event: PointerEvent | MouseEvent): HTMLTableCellElement | null => {
      const cell = (event.target as Element | null)?.closest('td, th') as HTMLTableCellElement | null;
      return cell && body.contains(cell) ? cell : null;
    };
    const tableCoordinates = (cell: HTMLTableCellElement) => {
      const row = cell.parentElement as HTMLTableRowElement | null;
      const table = cell.closest('table');
      if (!row || !table) return null;
      return {
        row: row.rowIndex,
        column: cell.cellIndex,
        rows: table.rows.length,
        columns: Math.max(0, ...[...table.rows].map((item) => item.cells.length)),
      };
    };
    const borderEdgeAtPointer = (
      cell: HTMLTableCellElement,
      event: PointerEvent | MouseEvent,
    ): TableBorderEdge | null => {
      const rect = cell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const distances: Array<[TableBorderEdge, number]> = [
        ['top', Math.abs(event.clientY - rect.top)],
        ['right', Math.abs(rect.right - event.clientX)],
        ['bottom', Math.abs(rect.bottom - event.clientY)],
        ['left', Math.abs(event.clientX - rect.left)],
      ];
      distances.sort((a, b) => a[1] - b[1]);
      const threshold = Math.min(
        Math.max(8, this.tableBorderSettingsValue.width / 2 + 4),
        rect.width / 3,
        rect.height / 3,
      );
      return distances[0][1] <= threshold ? distances[0][0] : null;
    };
    const onTablePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const cell = tableCellFromEvent(event);
      if (!cell) return;
      if (this.tableBorderSettingsValue.drawing) {
        const edge = borderEdgeAtPointer(cell, event);
        if (!edge) return;
        event.preventDefault();
        borderPaintDrag = { pointerId: event.pointerId, changed: true };
        this.paintTableBorderEdge(cell, edge);
        this.showTableBorderPreview(cell, edge);
        return;
      }
      const point = tableCoordinates(cell);
      if (!point) return;
      // A fresh cell gesture invalidates any character Range from a previous
      // cell. If this gesture stays inside the cell, selectionchange will
      // replace it with the newly highlighted word/characters.
      this.textSelectionRange = null;
      tableDrag = { pointerId: event.pointerId, row: point.row, column: point.column };
      this.tableSelection = {
        elementId,
        mode: 'cell',
        row: point.row,
        column: point.column,
        rowEnd: point.row,
        columnEnd: point.column,
        rows: point.rows,
        columns: point.columns,
      };
      this.syncTableSelectionHighlight();
      this.onTableSelectionChange?.();
    };
    const onTablePointerMove = (event: PointerEvent) => {
      if (this.tableBorderSettingsValue.drawing) {
        const cell = tableCellFromEvent(event);
        const edge = cell ? borderEdgeAtPointer(cell, event) : null;
        if (cell && edge) {
          this.showTableBorderPreview(cell, edge);
          if (borderPaintDrag?.pointerId === event.pointerId) {
            event.preventDefault();
            this.paintTableBorderEdge(cell, edge);
            borderPaintDrag.changed = true;
          }
        } else {
          this.clearTableBorderPreview();
        }
        return;
      }
      if (!tableDrag || event.pointerId !== tableDrag.pointerId) return;
      const cell = tableCellFromEvent(event);
      if (!cell) return;
      const point = tableCoordinates(cell);
      if (!point || !this.tableSelection) return;
      if (
        point.row === this.tableSelection.rowEnd
        && point.column === this.tableSelection.columnEnd
      ) return;

      // Once the pointer crosses a cell boundary this is a spreadsheet range
      // gesture, not a DOM text selection. Keeping the native range would make
      // a vertical drag include every intervening line in document order.
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.textSelectionRange = null;
      body.classList.add('table-cell-dragging');
      this.tableSelection.rowEnd = point.row;
      this.tableSelection.columnEnd = point.column;
      this.tableSelection.mode = point.row === tableDrag.row
        ? (point.column === tableDrag.column ? 'cell' : 'row')
        : point.column === tableDrag.column ? 'column' : 'range';
      this.syncTableSelectionHighlight();
      this.onTableSelectionChange?.();
    };
    const onTableMouseMove = (event: MouseEvent) => {
      if (!this.tableBorderSettingsValue.drawing || borderPaintDrag) return;
      const cell = tableCellFromEvent(event);
      const edge = cell ? borderEdgeAtPointer(cell, event) : null;
      if (cell && edge) this.showTableBorderPreview(cell, edge);
      else this.clearTableBorderPreview();
    };
    const onTablePointerUp = (event: PointerEvent) => {
      if (borderPaintDrag?.pointerId === event.pointerId) {
        const changed = borderPaintDrag.changed;
        borderPaintDrag = null;
        if (changed) this.commitTableDom('Draw table borders');
        return;
      }
      if (!tableDrag || event.pointerId !== tableDrag.pointerId) return;
      tableDrag = null;
      body.classList.remove('table-cell-dragging');
    };

    const finish = (commit: boolean) => {
      body.removeEventListener('blur', onBlur);
      body.removeEventListener('keydown', onKey);
      body.removeEventListener('beforeinput', onBeforeInput);
      body.removeEventListener('input', onInput);
      body.removeEventListener('paste', onPaste);
      body.removeEventListener('pointerdown', onTablePointerDown);
      body.removeEventListener('pointermove', onTablePointerMove);
      body.removeEventListener('mousemove', onTableMouseMove);
      document.removeEventListener('pointerup', onTablePointerUp, true);
      document.removeEventListener('pointercancel', onTablePointerUp, true);
      body.classList.remove('table-cell-dragging');
      this.setTableBorderDrawing(false);
      if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = 0;
      }
      if (commit) this.commitTextEdit();
      else {
        this.editingId = null;
        this.tableSelection = null;
        this.textSelectionRange = null;
        window.getSelection()?.removeAllRanges();
        this.onTextEditModeChange?.(null);
        // Escape means discard — including anything live sync already
        // streamed. The revert shares the session's coalesce key, so in the
        // collab undo layer stream + revert fold into one net no-op.
        const streamed = this.store.slide?.elements.find((e) => e.id === elementId);
        if (
          streamed && (streamed.type === 'text' || streamed.type === 'html')
          && streamed.html !== el.html
        ) {
          const coalesceKey = this.textEditCoalesceKey ?? undefined;
          this.store.commit((deck) => {
            const target = deck.slides[this.store.get().slideIndex]?.elements.find(
              (e) => e.id === elementId,
            );
            if (target && (target.type === 'text' || target.type === 'html')) {
              target.html = el.html;
            }
          }, { label: 'Edit text', transient: true, coalesceKey });
        }
        this.textEditCoalesceKey = null;
        this.render();
      }
    };

    const onBlur = (event: FocusEvent) => {
      // Native selects need focus in order to open. Keep the live Range while
      // the font picker is used; its change handler restores focus afterward.
      if (event.relatedTarget instanceof Element
        && event.relatedTarget.closest(
          '.font-family-field, .text-table-options, .text-list-toggle, .color-picker-popover',
        )) return;
      // A table row/column selection is a formatting target in its own right.
      // Let typography fields take focus without ending the edit and clearing
      // that target before their change handlers run.
      if (event.relatedTarget instanceof Element
        && event.relatedTarget.closest('.editor-inspector')) return;
      finish(true);
    };
    const onInput = (event?: Event) => {
      const typed = event instanceof InputEvent ? event : null;
      if (
        typed?.inputType === 'insertText'
        && typed.data === '>'
        && !typed.isComposing
      ) {
        convertTypedArrow(body, window.getSelection());
      }
      if (el.type === 'text' && (el.autoFit || el.noWrap)) scheduleAutoFit(node!);
      if (this.liveTextSync && !liveTimer) liveTimer = window.setTimeout(pushLive, 250);
    };
    const onBeforeInput = (event: InputEvent) => {
      const nativeFormat = event.inputType === 'formatBold'
        ? 'bold'
        : event.inputType === 'formatItalic'
          ? 'italic'
          : event.inputType === 'formatUnderline'
            ? 'underline'
            : null;
      if (nativeFormat) {
        // Electron/Chromium can route macOS editing commands through
        // beforeinput without delivering the corresponding Cmd+B/Cmd+I/Cmd+U
        // keydown to the contenteditable. Own those semantic commands too so
        // native menu/accelerator routing and physical keyboard routing have
        // identical, model-backed formatting behaviour.
        event.preventDefault();
        this.toggleTextSelectionFormat(nativeFormat);
        return;
      }
      if (
        event.inputType !== 'insertText'
        || event.data === null
        || event.isComposing
      ) return;
      const range = this.activeTextRange(body);
      if (!range || !range.collapsed) return;
      const container = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      const marker = container?.closest<HTMLElement>('[data-editor-typing-style]') ?? null;
      if (!marker || !body.contains(marker)) return;

      // Chromium's native Input.insertText sometimes moves inserted text
      // beside an empty inline marker instead of inheriting it. Own this one
      // narrow case so pending Cmd+B/Cmd+I state has identical semantics for
      // physical typing, automation, and collaboration clients.
      event.preventDefault();
      const inserted = document.createTextNode(event.data);
      range.insertNode(inserted);
      range.setStartAfter(inserted);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      this.textSelectionRange = range.cloneRange();
      onInput(event);
    };
    const onKey = (e: KeyboardEvent) => {
      // Editing keys must not reach the canvas shortcuts (Delete would remove
      // the element you are typing into).
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const format = e.key.toLowerCase() === 'b'
          ? 'bold'
          : e.key.toLowerCase() === 'i' ? 'italic' : 'underline';
        this.toggleTextSelectionFormat(format);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        // Programmatic inline formatting (for example, changing one word's
        // font) is not reliably represented in Chromium's contenteditable
        // undo stack. Use app history, then immediately reopen the same text
        // element and reconstruct its Range from text offsets. Formatting and
        // list-style changes preserve text, so the same characters remain
        // selected instead of Ctrl/Cmd+Z unexpectedly dropping edit mode.
        e.preventDefault();
        const elementId = this.editingId;
        const active = window.getSelection();
        const selectedRange = active && active.rangeCount > 0 && !active.getRangeAt(0).collapsed
          ? active.getRangeAt(0)
          : this.textSelectionRange;
        const offsets = selectedRange && !selectedRange.collapsed
          ? this.textOffsetsForRange(body, selectedRange)
          : null;
        const tableSelection = this.tableSelection ? { ...this.tableSelection } : null;
        finish(true);
        if (this.onUndoRequest) this.onUndoRequest(e.shiftKey);
        else if (e.shiftKey) this.store.redo();
        else this.store.undo();
        if (elementId && this.store.slide?.elements.some((element) => element.id === elementId)) {
          this.beginTextEdit(elementId);
          const restoredBody = this.slideLayer.querySelector<HTMLElement>(
            `[data-element-id="${CSS.escape(elementId)}"] .text-content`,
          );
          if (restoredBody && offsets) this.restoreTextRange(restoredBody, offsets);
          if (tableSelection && restoredBody?.querySelector('table')) {
            this.tableSelection = tableSelection;
            this.syncTableSelectionHighlight();
            this.onTableSelectionChange?.();
          }
        }
      } else if (e.key === 'Escape') {
        // Escape leaves edit mode but keeps what was typed — it is "done
        // editing", not "undo my edit". Undo is still one keystroke away.
        e.preventDefault();
        finish(true);
        body.blur();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        if (convertTypedListMarker(body, window.getSelection())) {
          e.preventDefault();
          onInput();
          // The Props checkboxes should reflect the conversion immediately,
          // even in the desktop shell where ordinary typing syncs on blur.
          pushLive();
        }
      } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Tab indents a bullet one level (nested lists render a "-" marker,
        // see type.css); shift-tab unindents. Outside a list, tab keeps its
        // browser default (which would blur the box), so swallow it there too.
        e.preventDefault();
        const anchor = window.getSelection()?.anchorNode;
        const inItem = anchor instanceof Element
          ? anchor.closest('li')
          : anchor?.parentElement?.closest('li');
        if (inItem && body.contains(inItem)) {
          document.execCommand?.(e.shiftKey ? 'outdent' : 'indent');
        }
      }
    };

    body.addEventListener('blur', onBlur);
    body.addEventListener('keydown', onKey);
    body.addEventListener('beforeinput', onBeforeInput);
    body.addEventListener('input', onInput);
    body.addEventListener('paste', onPaste);
    body.addEventListener('pointerdown', onTablePointerDown);
    body.addEventListener('pointermove', onTablePointerMove);
    body.addEventListener('mousemove', onTableMouseMove);
    document.addEventListener('pointerup', onTablePointerUp, true);
    document.addEventListener('pointercancel', onTablePointerUp, true);
  }

  /** Put the editing caret at the glyph nearest the click that opened the box. */
  private placeCaretAtPoint(
    body: HTMLElement,
    point: { clientX: number; clientY: number },
  ): Range | null {
    const doc = body.ownerDocument;
    let range: Range | null = null;
    const position = doc.caretPositionFromPoint?.(point.clientX, point.clientY);
    if (position && body.contains(position.offsetNode)) {
      range = doc.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    } else {
      const legacyRange = doc.caretRangeFromPoint?.(point.clientX, point.clientY) ?? null;
      if (legacyRange && body.contains(legacyRange.startContainer)) range = legacyRange;
    }
    if (!range) return null;
    const selection = doc.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range.cloneRange();
  }

  private textOffsetsForRange(root: HTMLElement, range: Range): { start: number; end: number } | null {
    if (!root.contains(range.commonAncestorContainer)) return null;
    try {
      // Range#intersectsNode includes a text node that merely touches a Range
      // boundary. Measuring each boundary from the root avoids treating that
      // zero-width contact as selected text.
      const prefix = document.createRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length;
      prefix.setEnd(range.endContainer, range.endOffset);
      return { start, end: prefix.toString().length };
    } catch {
      return null;
    }
  }

  private restoreTextRange(root: HTMLElement, offsets: { start: number; end: number }): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      texts.push(current as Text);
    }
    if (texts.length === 0) return;
    const locate = (offset: number, affinity: 'forward' | 'backward'): { node: Text; offset: number } => {
      let remaining = Math.max(0, offset);
      for (const text of texts) {
        if (
          remaining < text.data.length
          || (remaining === text.data.length && affinity === 'backward')
        ) {
          return { node: text, offset: remaining };
        }
        remaining -= text.data.length;
      }
      const last = texts[texts.length - 1];
      return { node: last, offset: last.data.length };
    };
    const start = locate(offsets.start, 'forward');
    const end = offsets.end === offsets.start
      ? start
      : locate(Math.max(offsets.start, offsets.end), 'backward');
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.textSelectionRange = range.cloneRange();
    root.focus();
  }

  /**
   * The live browser Range when it still belongs to this editor, otherwise the
   * offset-stable bookmark captured before focus moved into inspector chrome.
   */
  private activeTextRange(root: HTMLElement): Range | null {
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const live = selection.getRangeAt(0);
      if (root.contains(live.commonAncestorContainer)) return live;
    }
    const saved = this.textSelectionRange;
    return saved && root.contains(saved.commonAncestorContainer) ? saved : null;
  }

  /** Text node whose authored style controls typing at a collapsed caret. */
  private textNodeAtCaret(root: HTMLElement, range: Range): Text | null {
    if (range.startContainer instanceof Text) return range.startContainer;
    const offsets = this.textOffsetsForRange(root, range);
    if (!offsets) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let cursor = 0;
    let previous: Text | null = null;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const text = current as Text;
      if (offsets.start <= cursor + text.data.length) return text;
      cursor += text.data.length;
      previous = text;
    }
    return previous;
  }

  private clearTypingStyleMarker(marker: HTMLElement): void {
    const walker = document.createTreeWalker(marker, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      texts.push(current as Text);
    }
    texts.forEach((text) => { text.data = text.data.replaceAll(TYPING_STYLE_SENTINEL, ''); });
    marker.removeAttribute('data-editor-typing-style');
    if (!(marker.textContent ?? '')) marker.remove();
  }

  /**
   * Give a collapsed caret an explicit authored style without relying on
   * execCommand/queryCommandState. The word-joiner keeps the Range inside the
   * span; typed characters inherit the span and the sentinel is stripped when
   * the DOM is serialized.
   */
  private applyCollapsedTypingStyle(
    content: HTMLElement,
    originalRange: Range,
    property: 'fontWeight' | 'fontFamily' | 'fontSize' | 'fontStyle' | 'textDecorationLine' | 'color',
    value: string,
  ): boolean {
    const offsets = this.textOffsetsForRange(content, originalRange);
    if (!offsets) return false;
    let range = originalRange;
    const container = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    const existing = container?.closest<HTMLElement>('[data-editor-typing-style]') ?? null;
    if (existing && content.contains(existing)) {
      if ((existing.textContent ?? '') === TYPING_STYLE_SENTINEL) {
        existing.style[property] = value;
        const text = existing.firstChild;
        if (text instanceof Text) {
          const caret = document.createRange();
          caret.setStart(text, 0);
          caret.collapse(true);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(caret);
          this.textSelectionRange = caret.cloneRange();
        }
        content.focus();
        this.onTextFormatStateChange?.();
        return true;
      }
      // The old typing run now contains authored characters. Seal it before
      // starting a differently styled run at the same logical text offset.
      this.clearTypingStyleMarker(existing);
      this.restoreTextRange(content, { start: offsets.start, end: offsets.start });
      range = this.activeTextRange(content) ?? range;
    }

    const marker = document.createElement('span');
    marker.dataset.editorTypingStyle = 'true';
    marker.style[property] = value;
    const sentinel = document.createTextNode(TYPING_STYLE_SENTINEL);
    marker.appendChild(sentinel);
    range.insertNode(marker);
    const caret = document.createRange();
    caret.setStart(sentinel, 0);
    caret.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    this.textSelectionRange = caret.cloneRange();
    content.focus();
    this.onTextFormatStateChange?.();
    return true;
  }

  /** Write the edited markup back to the deck as a single undoable change. */
  private commitTextEdit(): void {
    const elementId = this.editingId;
    if (!elementId) return;
    this.editingId = null;
    this.tableSelection = null;
    this.textSelectionRange = null;
    this.onTextEditModeChange?.(null);

    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const body = node?.querySelector<HTMLElement>('.text-content') ?? null;
    if (!body) return;

    // Without `splitBreaks`: a shift-return the author typed is a soft break
    // inside its paragraph, not a new one.
    const html = authoredTextHtml(body);
    body.contentEditable = 'false';
    node!.classList.remove('editing');
    // contenteditable selections survive blur in Chromium. Clear that native
    // highlight when edit mode ends; the object selection outline remains the
    // sole blue selection affordance outside editing.
    window.getSelection()?.removeAllRanges();

    const coalesceKey = this.textEditCoalesceKey ?? undefined;
    const originalHtml = this.textEditOriginalHtml;
    this.textEditCoalesceKey = null;
    this.textEditOriginalHtml = null;

    const current = this.store.slide?.elements.find((e) => e.id === elementId);
    if (!current || (current.type !== 'text' && current.type !== 'html')) return;
    // Live sync may have already streamed the final html; the session still
    // counts as an edit (and strips the placeholder class) if the text ends
    // up different from where it started.
    if (current.html === html && !current.class.includes('placeholder')) {
      if (html === (originalHtml ?? html)) {
        // Nothing changed, so there is no commit and therefore no re-render --
        // but the node still holds what `beginTextEdit` swapped in: the authored
        // source. For anything the renderer transforms, that is the wrong DOM to
        // leave behind; TeX is the visible case, where the box keeps showing a
        // literal `$E=mc^2$` where KaTeX output belongs until an unrelated redraw.
        this.restoreRenderedForm(current, body);
      }
      // Live formatting/table commits already recorded the authored change.
      // Do not add a second no-op history entry when edit mode finishes; one
      // real Ctrl/Cmd+Z must undo one real formatting click.
      return;
    }

    this.store.commit((deck) => {
      const el = deck.slides[this.store.get().slideIndex].elements.find(
        (e) => e.id === elementId,
      );
      if (el && (el.type === 'text' || el.type === 'html')) {
        el.html = html;
        el.class = el.class.filter((name) => name !== 'placeholder');
      }
    }, { label: 'Edit text', coalesceKey });
  }

  /**
   * Put the rendered form of an element back after an edit session that changed
   * nothing, but only where the renderer actually transforms the source.
   *
   * Editing swaps the authored source into the node, so for markup the renderer
   * rewrites -- TeX above all -- ending an edit without a change would otherwise
   * leave a literal `$E=mc^2$` on the slide until an unrelated redraw. Plain
   * text renders to itself, and there the existing node is kept: replacing it
   * needlessly would discard the editing state the caller just settled.
   */
  private restoreRenderedForm(el: SlideElement, body: HTMLElement): void {
    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(el.id)}"]`,
    );
    if (!node) return;
    const fresh = renderElement(el, { resolveSrc: (src) => window.api.assetUrl(src) });
    const rendered = fresh.querySelector<HTMLElement>('.text-content');
    if (!rendered || rendered.innerHTML === body.innerHTML) return;
    node.replaceWith(fresh);
  }

  /** True while a text element is being edited, so callers can defer redraws. */
  isEditing(): boolean {
    return this.editingId !== null;
  }

  /** Whether inspector chrome should target characters rather than a selected
   * table cell/range. A collapsed caret inside a selected cell is not an
   * expanded character selection and must not consume cell typography. */
  hasExpandedTextSelection(): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (!content) return false;
    const live = window.getSelection();
    if (live?.rangeCount) {
      const range = live.getRangeAt(0);
      if (content.contains(range.commonAncestorContainer)) return !range.collapsed;
    }
    return Boolean(
      this.textSelectionRange
      && !this.textSelectionRange.collapsed
      && content.contains(this.textSelectionRange.commonAncestorContainer),
    );
  }

  /** Refit after live theme CSS changes without rebuilding the slide DOM. */
  refitAutoText(): void {
    fitAutoText(this.slideLayer);
    // Table padding, borders and type are intentionally theme.css-driven.
    // Re-measure the native frame as part of the same hot-reload pass so an
    // agent can restyle rows and cells without leaving stale table geometry.
    this.scheduleTableHeightSync();
  }

  /** Apply weight to the selected characters without styling the whole box. */
  applyTextSelectionWeight(weight: number): boolean {
    return this.applyTextSelectionStyle('fontWeight', String(Math.max(1, Math.min(1000, weight))));
  }

  /** Apply a font family to the selected characters without styling the box. */
  applyTextSelectionFontFamily(value: string): boolean {
    return this.applyTextSelectionStyle('fontFamily', value || 'inherit');
  }

  applyTextSelectionFontSize(value: number): boolean {
    const size = Math.round(Math.max(6, Math.min(400, value)) * 10) / 10;
    return this.applyTextSelectionStyle('fontSize', `${size}px`);
  }

  /** Apply paragraph spacing to the blocks touched by the live selection. */
  applyTextSelectionParagraphSpacing(value: number | null): boolean {
    if (!this.editingId || this.tableSelection) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const live = window.getSelection();
    const range = live && live.rangeCount > 0 && !live.getRangeAt(0).collapsed
      ? live.getRangeAt(0)
      : this.textSelectionRange;
    if (!content || !range || range.collapsed || !content.contains(range.commonAncestorContainer)) {
      return false;
    }
    const blocks = [...content.querySelectorAll<HTMLElement>('p, li, div')]
      .filter((block) => {
        try { return range.intersectsNode(block); } catch { return false; }
      })
      .filter((block) => !block.querySelector('p, li, div'));
    if (blocks.length === 0) return false;

    const spacing = value === null ? null : `${Math.max(0, value)}px`;
    blocks.forEach((block) => {
      if (spacing === null) block.style.removeProperty('margin-bottom');
      else block.style.marginBottom = spacing;
      if (!block.getAttribute('style')?.trim()) block.removeAttribute('style');
    });
    const next = document.createRange();
    next.setStartBefore(blocks[0]);
    next.setEndAfter(blocks[blocks.length - 1]);
    live?.removeAllRanges();
    live?.addRange(next);
    this.textSelectionRange = next.cloneRange();
    content.focus();
    const node = content.closest<HTMLElement>('.element');
    if (node) scheduleAutoFit(node);
    this.commitLiveTextDom(
      spacing === null ? 'Use theme spacing for selected paragraphs' : 'Change selected paragraph spacing',
    );
    return true;
  }

  /** Return a shared authored spacing for the paragraphs in the live selection. */
  textSelectionParagraphSpacing(): number | null {
    if (!this.editingId || this.tableSelection) return null;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = this.textSelectionRange;
    if (!content || !range || range.collapsed || !content.contains(range.commonAncestorContainer)) {
      return null;
    }
    const blocks = [...content.querySelectorAll<HTMLElement>('p, li, div')]
      .filter((block) => {
        try { return range.intersectsNode(block); } catch { return false; }
      })
      .filter((block) => !block.querySelector('p, li, div'));
    if (blocks.length === 0) return null;
    const values = blocks.map((block) => Number.parseFloat(block.style.marginBottom));
    if (values.some((value) => !Number.isFinite(value))) return null;
    return values.every((value) => value === values[0]) ? values[0] : null;
  }

  applyTextSelectionColor(value: string | null): boolean {
    return this.applyTextSelectionStyle('color', value || 'inherit');
  }

  /** Explicit marker paint shared by the list items touched by the live selection. */
  textSelectionMarkerColor(): ListMarkerColorState | null {
    if (!this.editingId || this.tableSelection) return null;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = content ? this.activeTextRange(content) : null;
    if (!content || !range || !content.contains(range.commonAncestorContainer)) return null;
    const items = this.listItemsForRange(content, range);
    if (items.length === 0) return null;
    const values = items.map((item) => item.hasAttribute(LIST_MARKER_COLOR_ATTRIBUTE)
      ? item.style.getPropertyValue(LIST_MARKER_COLOR_PROPERTY).trim() || null
      : null);
    const mixed = !values.every((value) => value === values[0]);
    return { hasList: true, mixed, value: mixed ? null : values[0] };
  }

  /** Colour the markers for the current item or selected items, without touching their text. */
  applyTextSelectionMarkerColor(value: string | null): boolean {
    if (!this.editingId || this.tableSelection) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = content ? this.activeTextRange(content) : null;
    if (!content || !range || !content.contains(range.commonAncestorContainer)) return false;
    const items = this.listItemsForRange(content, range);
    if (items.length === 0) return false;
    const offsets = this.textOffsetsForRange(content, range);
    for (const item of items) {
      if (value) {
        item.setAttribute(LIST_MARKER_COLOR_ATTRIBUTE, 'true');
        item.style.setProperty(LIST_MARKER_COLOR_PROPERTY, value);
      } else {
        item.removeAttribute(LIST_MARKER_COLOR_ATTRIBUTE);
        item.style.removeProperty(LIST_MARKER_COLOR_PROPERTY);
        if (!item.getAttribute('style')?.trim()) item.removeAttribute('style');
      }
    }
    if (offsets) this.restoreTextRange(content, offsets);
    content.focus();
    this.commitLiveTextDom(value ? 'Change list marker colour' : 'Make list markers follow text colour');
    return true;
  }

  private listItemsForRange(content: HTMLElement, range: Range): HTMLElement[] {
    if (range.collapsed) {
      const container = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      const item = container?.closest<HTMLElement>('li') ?? null;
      return item && content.contains(item) ? [item] : [];
    }
    return [...content.querySelectorAll<HTMLElement>('li')].filter((item) => {
      try { return range.intersectsNode(item); } catch { return false; }
    });
  }

  /** Toggle a standard inline format on the active selection. */
  toggleTextSelectionFormat(format: 'bold' | 'italic' | 'underline'): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const range = content ? this.activeTextRange(content) : null;
    if (!content || !range || !content.contains(range.commonAncestorContainer)) {
      return false;
    }

    // Use the same offset-based formatter in Chromium and in the test/runtime
    // fallback. execCommand mutates selection boundaries differently across
    // focus changes and browsers, which made the toolbar and keyboard paths
    // disagree and occasionally formatted adjacent runs.
    const active = this.textSelectionFormatState(format);
    if (format === 'bold') return this.applyTextSelectionStyle('fontWeight', active ? '400' : '700');
    if (format === 'italic') return this.applyTextSelectionStyle('fontStyle', active ? 'normal' : 'italic');
    return this.applyTextSelectionStyle('textDecorationLine', active ? 'none' : 'underline');
  }

  textSelectionFormatState(format: 'bold' | 'italic' | 'underline'): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (!content) return false;
    const range = this.activeTextRange(content);
    if (!range) return false;
    if (range.collapsed) {
      const caret = this.textNodeAtCaret(content, range);
      return Boolean(caret && this.textNodeFormatState(caret, content, format));
    }
    const offsets = this.textOffsetsForRange(content, range);
    const first = offsets ? this.textSlicesForOffsets(content, offsets)[0]?.text : null;
    return Boolean(first && this.textNodeFormatState(first, content, format));
  }

  applyTextSelectionAlignment(value: 'left' | 'center' | 'right' | 'justify'): boolean {
    if (!this.editingId || this.tableSelection) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const live = window.getSelection();
    const range = live && live.rangeCount > 0 && !live.getRangeAt(0).collapsed
      ? live.getRangeAt(0)
      : this.textSelectionRange;
    if (!content || !range || range.collapsed || !content.contains(range.commonAncestorContainer)) {
      return false;
    }
    const blocks = [...content.querySelectorAll<HTMLElement>('p, li, div')]
      .filter((block) => {
        try { return range.intersectsNode(block); } catch { return false; }
      })
      .filter((block) => !block.querySelector('p, li, div'));
    if (blocks.length === 0) return false;
    blocks.forEach((block) => { block.style.textAlign = value; });
    const next = document.createRange();
    next.setStartBefore(blocks[0]);
    next.setEndAfter(blocks[blocks.length - 1]);
    live?.removeAllRanges();
    live?.addRange(next);
    this.textSelectionRange = next.cloneRange();
    content.focus();
    this.commitLiveTextDom('Align selected paragraphs');
    return true;
  }

  /** The list style containing the live selection, if it has one. */
  textSelectionListStyle(): 'None' | 'Bulleted' | 'Numbered' | null {
    if (!this.editingId) return null;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const live = window.getSelection();
    const range = live && live.rangeCount > 0 && !live.getRangeAt(0).collapsed
      ? live.getRangeAt(0)
      : this.textSelectionRange;
    if (!content || !range || range.collapsed || !content.contains(range.commonAncestorContainer)) {
      return null;
    }
    const styles = [...content.children].flatMap((child) => {
      try {
        if (!range.intersectsNode(child)) return [];
      } catch {
        return [];
      }
      if (child.tagName === 'OL') return ['Numbered' as const];
      if (child.tagName === 'UL') return ['Bulleted' as const];
      return ['None' as const];
    });
    return new Set(styles).size === 1 ? styles[0] ?? null : null;
  }

  /** Change whole touched lists, even when only part of one item is selected. */
  applyTextSelectionListStyle(style: 'None' | 'Bulleted' | 'Numbered'): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    const live = window.getSelection();
    const range = live && live.rangeCount > 0 && !live.getRangeAt(0).collapsed
      ? live.getRangeAt(0)
      : this.textSelectionRange;
    if (!content || !range || range.collapsed || !content.contains(range.commonAncestorContainer)) {
      return false;
    }

    const selectedBlocks = [...content.children].filter((child) => {
      try { return range.intersectsNode(child); } catch { return false; }
    }) as HTMLElement[];
    if (selectedBlocks.length === 0) return false;

    // If any selected text belongs to a list, that whole top-level list is the
    // formatting target. Unrelated paragraphs crossed by the Range are left
    // alone; this is the familiar Keynote/word-processor list behaviour.
    const selectedLists = selectedBlocks.filter((block) => /^(OL|UL)$/.test(block.tagName));
    const targets = selectedLists.length > 0 ? selectedLists : selectedBlocks;
    const inserted: Node[] = [];
    let changed = false;

    if (style === 'None') {
      for (const block of targets) {
        if (!/^(OL|UL)$/.test(block.tagName)) {
          inserted.push(block);
          continue;
        }
        const fragment = document.createDocumentFragment();
        const paragraphs: HTMLElement[] = [];
        for (const item of [...block.children] as HTMLElement[]) {
          if (item.tagName !== 'LI') continue;
          const paragraph = document.createElement('p');
          for (const attr of [...item.attributes]) {
            if (attr.name !== LIST_MARKER_COLOR_ATTRIBUTE) {
              paragraph.setAttribute(attr.name, attr.value);
            }
          }
          paragraph.style.removeProperty(LIST_MARKER_COLOR_PROPERTY);
          if (!paragraph.getAttribute('style')?.trim()) paragraph.removeAttribute('style');
          while (item.firstChild) paragraph.appendChild(item.firstChild);
          paragraphs.push(paragraph);
          fragment.appendChild(paragraph);
        }
        block.replaceWith(fragment);
        inserted.push(...paragraphs);
        changed = true;
      }
    } else {
      const targetTag = style === 'Numbered' ? 'OL' : 'UL';
      if (selectedLists.length === 0) {
        // Keep the typed-marker inference used by automatic list conversion
        // (`1.`, `2)`, `*`, `-`) while limiting it to the selected blocks.
        const source = document.createElement('div');
        targets.forEach((block) => source.appendChild(block.cloneNode(true)));
        const converted = style === 'Numbered'
          ? paragraphsToOrderedList(source.innerHTML)
          : paragraphsToList(source.innerHTML);
        const template = document.createElement('template');
        template.innerHTML = converted;
        const replacements = [...template.content.childNodes];
        const parent = targets[0].parentNode;
        if (!parent || replacements.length === 0) return false;
        replacements.forEach((replacement) => parent.insertBefore(replacement, targets[0]));
        targets.forEach((block) => block.remove());
        inserted.push(...replacements);
        changed = true;
      }
      for (const block of selectedLists) {
        if (/^(OL|UL)$/.test(block.tagName)) {
          if (block.tagName === targetTag) {
            inserted.push(block);
            continue;
          }
          const replacement = document.createElement(targetTag.toLowerCase());
          for (const attr of [...block.attributes]) {
            if (targetTag === 'UL' && attr.name === 'start') continue;
            replacement.setAttribute(attr.name, attr.value);
          }
          while (block.firstChild) replacement.appendChild(block.firstChild);
          block.replaceWith(replacement);
          inserted.push(replacement);
          changed = true;
          continue;
        }
      }
      // Merge adjacent lists created from a multi-paragraph selection.
      for (let index = 1; index < inserted.length; index++) {
        const previous = inserted[index - 1] as HTMLElement;
        const current = inserted[index] as HTMLElement;
        if (previous.tagName !== targetTag || current.tagName !== targetTag
          || previous.nextSibling !== current) continue;
        while (current.firstChild) previous.appendChild(current.firstChild);
        current.remove();
        inserted.splice(index, 1);
        index -= 1;
      }
    }
    if (!changed) return true;
    if (inserted.length === 0) return false;

    const next = document.createRange();
    next.setStartBefore(inserted[0]);
    next.setEndAfter(inserted[inserted.length - 1]);
    live?.removeAllRanges();
    live?.addRange(next);
    this.textSelectionRange = next.cloneRange();
    content.focus();
    const node = content.closest<HTMLElement>('.element');
    if (node) scheduleAutoFit(node);
    this.commitLiveTextDom(`Change selected list style to ${style.toLowerCase()}`);
    return true;
  }

  private commitLiveTextDom(label: string): void {
    const elementId = this.editingId;
    if (!elementId) return;
    const body = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"] .text-content`,
    );
    if (!body) return;
    const html = authoredTextHtml(body);
    const coalesceKey = this.textEditCoalesceKey ?? undefined;
    this.store.commit((deck) => {
      const target = deck.slides[this.store.get().slideIndex]?.elements.find(
        (element) => element.id === elementId,
      );
      if (target && (target.type === 'text' || target.type === 'html')) target.html = html;
    }, { label, coalesceKey });
  }

  /** Positive-width text slices covered by flat character offsets. */
  private textSlicesForOffsets(
    root: HTMLElement,
    offsets: { start: number; end: number },
  ): Array<{ text: Text; start: number; end: number }> {
    const slices: Array<{ text: Text; start: number; end: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let cursor = 0;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const text = current as Text;
      const start = Math.max(0, offsets.start - cursor);
      const end = Math.min(text.data.length, offsets.end - cursor);
      if (end > start) slices.push({ text, start, end });
      cursor += text.data.length;
      if (cursor >= offsets.end) break;
    }
    return slices;
  }

  /** Resolve one character's effective toggle state from the inside out. */
  private textNodeFormatState(
    text: Text,
    root: HTMLElement,
    format: 'bold' | 'italic' | 'underline',
  ): boolean {
    for (let node = text.parentElement; node && node !== root; node = node.parentElement) {
      if (format === 'bold' && node.style.fontWeight) {
        const weight = Number.parseInt(node.style.fontWeight, 10);
        return node.style.fontWeight === 'bold' || weight >= 600;
      }
      if (format === 'italic' && node.style.fontStyle) {
        return node.style.fontStyle === 'italic';
      }
      if (format === 'underline' && node.style.textDecorationLine) {
        return node.style.textDecorationLine.includes('underline');
      }
      if (format === 'bold' && node.matches('b, strong')) return true;
      if (format === 'italic' && node.matches('i, em')) return true;
      if (format === 'underline' && node.matches('u')) return true;
    }
    const computed = text.parentElement ? getComputedStyle(text.parentElement) : null;
    if (format === 'bold') {
      const weight = Number.parseInt(computed?.fontWeight ?? '', 10);
      return computed?.fontWeight === 'bold' || weight >= 600;
    }
    if (format === 'italic') return computed?.fontStyle === 'italic';
    return computed?.textDecorationLine.includes('underline') === true;
  }

  private applyTextSelectionStyle(
    property: 'fontWeight' | 'fontFamily' | 'fontSize' | 'fontStyle' | 'textDecorationLine' | 'color',
    value: string,
  ): boolean {
    if (!this.editingId) return false;
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (!content) return false;
    const range = this.activeTextRange(content);
    if (!range || !content.contains(range.commonAncestorContainer)) {
      return false;
    }
    if (range.collapsed) {
      return this.applyCollapsedTypingStyle(content, range, property, value);
    }

    const offsets = this.textOffsetsForRange(content, range);
    if (!offsets || offsets.end <= offsets.start) return false;

    // Never wrap a cross-block Range in one span. A selection containing
    // paragraphs or list items would put those blocks inside an inline span;
    // Chromium repairs that invalid shape by inserting/splitting lines. Style
    // each selected text run in place so the authored block structure is
    // exactly preserved.
    const slices = this.textSlicesForOffsets(content, offsets);
    if (slices.length === 0) return false;

    for (const { text, start, end } of slices) {
      if (end < text.data.length) text.splitText(end);
      const selected = start > 0 ? text.splitText(start) : text;
      const span = document.createElement('span');
      span.style[property] = value;
      selected.replaceWith(span);
      span.appendChild(selected);
    }
    normalizeInlineStyleSpans(content);
    this.restoreTextRange(content, offsets);
    content.focus();
    const label = property === 'fontFamily' ? 'Change selected text font'
      : property === 'fontSize' ? 'Change selected text size'
        : property === 'color' ? 'Change selected text colour'
      : property === 'fontWeight' ? 'Change selected text weight'
        : property === 'fontStyle' ? 'Change selected text italic'
          : 'Change selected text underline';
    this.commitLiveTextDom(label);
    return true;
  }

  tableSelectionInfo(): TableSelection | null {
    return this.tableSelection ? { ...this.tableSelection } : null;
  }

  tableBorderSettings(): TableBorderSettings {
    return { ...this.tableBorderSettingsValue };
  }

  setTableBorderSettings(color: string, width: number): void {
    this.tableBorderSettingsValue.color = color || '#000000';
    this.tableBorderSettingsValue.width = Math.round(Math.max(0.25, Math.min(40, width)) * 100) / 100;
    this.updateTableBorderPreviewPaint();
  }

  setTableBorderDrawing(active: boolean): void {
    // The inspector can briefly rerender between a collaboration commit and
    // its echoed DOM patch. Keep the explicit tool state independent of that
    // transient lookup; pointer painting still requires a real table cell.
    const next = active;
    if (this.tableBorderSettingsValue.drawing === next) return;
    this.tableBorderSettingsValue.drawing = next;
    const table = this.activeTable();
    table?.classList.toggle('editor-table-border-drawing', next);
    if (!next) this.clearTableBorderPreview();
    this.onTableBorderPaintModeChange?.();
  }

  applyTableBorderPreset(preset: TableBorderPreset): void {
    const table = this.activeTable();
    if (!table) return;
    this.setTableBorderDrawing(false);
    const border = `${this.tableBorderSettingsValue.width}px solid ${this.tableBorderSettingsValue.color}`;
    for (const cell of table.querySelectorAll<HTMLTableCellElement>('td, th')) {
      for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
        // A zero-width explicit border reliably overrides theme.css and keeps
        // each side independently paintable. (`border-*: none` is also
        // inconsistently preserved by DOM CSS serializers.)
        cell.style.setProperty(`border-${edge}`, '0px solid transparent');
      }
      if (preset === 'vertical') {
        cell.style.borderLeft = border;
        cell.style.borderRight = border;
      } else if (preset === 'horizontal') {
        cell.style.borderTop = border;
        cell.style.borderBottom = border;
      }
    }
    this.commitTableDom(
      preset === 'none' ? 'Remove table borders'
        : preset === 'vertical' ? 'Apply vertical table borders'
          : 'Apply horizontal table borders',
    );
  }

  private clearTableBorderPreview(): void {
    const preview = this.tableBorderPreview;
    if (!preview) return;
    preview.cell.classList.remove(`editor-table-border-preview-${preview.edge}`);
    preview.cell.style.removeProperty('--table-border-preview-color');
    preview.cell.style.removeProperty('--table-border-preview-width');
    if (!preview.cell.getAttribute('style')?.trim()) preview.cell.removeAttribute('style');
    this.tableBorderPreview = null;
  }

  private updateTableBorderPreviewPaint(): void {
    const cell = this.tableBorderPreview?.cell;
    if (!cell) return;
    cell.style.setProperty('--table-border-preview-color', this.tableBorderSettingsValue.color);
    cell.style.setProperty('--table-border-preview-width', `${this.tableBorderSettingsValue.width}px`);
  }

  private showTableBorderPreview(cell: HTMLTableCellElement, edge: TableBorderEdge): void {
    if (this.tableBorderPreview?.cell === cell && this.tableBorderPreview.edge === edge) return;
    this.clearTableBorderPreview();
    this.tableBorderPreview = { cell, edge };
    cell.classList.add(`editor-table-border-preview-${edge}`);
    this.updateTableBorderPreviewPaint();
  }

  private paintTableBorderEdge(cell: HTMLTableCellElement, edge: TableBorderEdge): void {
    const table = cell.closest('table');
    const row = cell.parentElement as HTMLTableRowElement | null;
    if (!table || !row) return;
    const border = `${this.tableBorderSettingsValue.width}px solid ${this.tableBorderSettingsValue.color}`;
    cell.style.setProperty(`border-${edge}`, border);
    const opposite: Record<TableBorderEdge, TableBorderEdge> = {
      top: 'bottom', right: 'left', bottom: 'top', left: 'right',
    };
    const neighbour = edge === 'left' ? row.cells[cell.cellIndex - 1]
      : edge === 'right' ? row.cells[cell.cellIndex + 1]
        : edge === 'top' ? table.rows[row.rowIndex - 1]?.cells[cell.cellIndex]
          : table.rows[row.rowIndex + 1]?.cells[cell.cellIndex];
    neighbour?.style.setProperty(`border-${opposite[edge]}`, border);
  }

  private activeTable(): HTMLTableElement | null {
    const selected = this.tableSelection;
    if (!selected) return null;
    return this.slideLayer.querySelector<HTMLTableElement>(
      `[data-element-id="${CSS.escape(selected.elementId)}"] .text-content table`,
    );
  }

  private selectedTableCells(): HTMLTableCellElement[] {
    const table = this.activeTable();
    const selected = this.tableSelection;
    if (!table || !selected) return [];
    const rowStart = Math.min(selected.row, selected.rowEnd);
    const rowEnd = Math.max(selected.row, selected.rowEnd);
    const columnStart = Math.min(selected.column, selected.columnEnd);
    const columnEnd = Math.max(selected.column, selected.columnEnd);
    const cells: HTMLTableCellElement[] = [];
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let column = columnStart; column <= columnEnd; column++) {
        const cell = table.rows[row]?.cells[column];
        if (cell) cells.push(cell);
      }
    }
    return cells;
  }

  private syncTableSelectionHighlight(): void {
    const table = this.activeTable();
    if (!table) return;
    table.querySelectorAll('.editor-table-selected').forEach((cell) => {
      cell.classList.remove('editor-table-selected');
    });
    this.selectedTableCells().forEach((cell) => cell.classList.add('editor-table-selected'));
  }

  private commitTableDom(
    label: string,
    updateWidths?: (widths: number[]) => number[],
  ): void {
    const selected = this.tableSelection;
    if (!selected) return;
    const body = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(selected.elementId)}"] .text-content`,
    );
    if (!body) return;
    const html = authoredTextHtml(body);
    const coalesceKey = this.textEditCoalesceKey ?? undefined;
    this.store.commit((deck) => {
      const target = deck.slides[this.store.get().slideIndex]?.elements.find(
        (element) => element.id === selected.elementId,
      );
      if (target && target.type === 'text') {
        if (target.table && updateWidths) {
          target.table.columnWidths = updateWidths([...target.table.columnWidths]);
        }
        target.html = target.table
          ? applyTableColumnWidths(html, target.table.columnWidths)
          : html;
      }
    }, { label, coalesceKey });
    this.syncTableSelectionHighlight();
  }

  applyTableCellColor(property: 'backgroundColor' | 'color', value: string | null): void {
    const cells = this.selectedTableCells();
    if (cells.length === 0) return;
    for (const cell of cells) {
      cell.style[property] = value ?? '';
      if (!cell.getAttribute('style')?.trim()) cell.removeAttribute('style');
    }
    this.commitTableDom(property === 'color' ? 'Change table text colour' : 'Change table cell colour');
  }

  applyTableCellTextStyle(
    property: 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle'
      | 'textDecorationLine' | 'textAlign' | 'verticalAlign',
    value: string | null,
  ): boolean {
    const cells = this.selectedTableCells();
    if (cells.length === 0) return false;
    for (const cell of cells) {
      cell.style[property] = value ?? '';
      if (!cell.getAttribute('style')?.trim()) cell.removeAttribute('style');
    }
    this.commitTableDom('Change table cell typography');
    return true;
  }

  toggleTableCellTextFormat(format: 'bold' | 'italic' | 'underline'): boolean {
    const cells = this.selectedTableCells();
    if (cells.length === 0) return false;
    const property = format === 'bold' ? 'fontWeight'
      : format === 'italic' ? 'fontStyle' : 'textDecorationLine';
    const active = cells.every((cell) => format === 'bold'
      ? Number.parseInt(cell.style.fontWeight, 10) >= 600
      : format === 'italic'
        ? cell.style.fontStyle === 'italic'
        : cell.style.textDecorationLine.includes('underline'));
    const value = format === 'bold' ? (active ? '400' : '700')
      : format === 'italic' ? (active ? 'normal' : 'italic')
        : active ? 'none' : 'underline';
    return this.applyTableCellTextStyle(property, value);
  }

  tableCellTextFormatState(format: 'bold' | 'italic' | 'underline'): boolean {
    const cells = this.selectedTableCells();
    if (cells.length === 0) return false;
    return cells.every((cell) => format === 'bold'
      ? Number.parseInt(cell.style.fontWeight, 10) >= 600
      : format === 'italic'
        ? cell.style.fontStyle === 'italic'
        : cell.style.textDecorationLine.includes('underline'));
  }

  textComputedTypography(elementId: string): {
    fontFamily: string | null;
    fontSize: number | null;
    fontWeight: number | null;
    fontFamilyExplicit: boolean;
    fontSizeExplicit: boolean;
    fontWeightExplicit: boolean;
    fittedFontSize: number | null;
  } {
    const element = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const node = element?.querySelector<HTMLElement>(
      '.text-content',
    ) ?? null;
    let target: HTMLElement | null = this.tableSelection?.elementId === elementId
      ? this.selectedTableCells()[0] ?? node
      : node;
    if (node && this.editingId === elementId && this.tableSelection?.elementId !== elementId) {
      const range = this.textSelectionRange;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (!range?.intersectsNode(current)) continue;
        target = current.parentElement ?? node;
        break;
      }
    }
    if (!target || !node) {
      return {
        fontFamily: null,
        fontSize: null,
        fontWeight: null,
        fontFamilyExplicit: false,
        fontSizeExplicit: false,
        fontWeightExplicit: false,
        fittedFontSize: null,
      };
    }
    const style = getComputedStyle(target);
    const fontWeight = Number.parseFloat(style.fontWeight);
    const explicit = (property: 'fontFamily' | 'fontSize' | 'fontWeight'): boolean => {
      for (let current: HTMLElement | null = target; current && node.contains(current); current = current.parentElement) {
        // Auto-fit writes its result directly on `.text-content`. It is a
        // rendered measurement, not an authored character-level override.
        if (!(property === 'fontSize' && current === node && node.dataset.fittedFontSize)
          && current.style[property]) return true;
        if (current === node) break;
      }
      return false;
    };
    const fontSizeExplicit = explicit('fontSize');
    const measuredFontSize = Number.parseFloat(style.fontSize);
    const fittedFontSize = Number.parseFloat(node.dataset.fittedFontSize ?? '');
    let unfittedFontSize = measuredFontSize;
    if (!fontSizeExplicit && Number.isFinite(fittedFontSize) && node.style.fontSize) {
      // Reveal the authored/theme declaration hidden by AutoFit's temporary
      // inline result. This is only a read: restore the fitted value before
      // returning so the canvas never flashes at its ceiling size.
      const fittedDeclaration = node.style.getPropertyValue('font-size');
      const fittedPriority = node.style.getPropertyPriority('font-size');
      node.style.removeProperty('font-size');
      unfittedFontSize = Number.parseFloat(getComputedStyle(node).fontSize);
      node.style.setProperty('font-size', fittedDeclaration, fittedPriority);
    }
    if (!Number.isFinite(unfittedFontSize) && element) {
      unfittedFontSize = Number.parseFloat(getComputedStyle(element).fontSize);
    }
    const fontSize = fontSizeExplicit ? measuredFontSize : unfittedFontSize;
    return {
      fontFamily: style.fontFamily || null,
      fontSize: Number.isFinite(fontSize) ? fontSize : null,
      fontWeight: Number.isFinite(fontWeight) ? fontWeight : null,
      fontFamilyExplicit: explicit('fontFamily'),
      fontSizeExplicit,
      fontWeightExplicit: explicit('fontWeight'),
      fittedFontSize: Number.isFinite(fittedFontSize) ? fittedFontSize : null,
    };
  }

  insertTableColumn(after: boolean): void {
    const table = this.activeTable();
    const selected = this.tableSelection;
    if (!table || !selected) return;
    const selectedStart = Math.min(selected.column, selected.columnEnd);
    const selectedEnd = Math.max(selected.column, selected.columnEnd);
    const index = after ? selectedEnd + 1 : selectedStart;
    for (const row of [...table.rows]) {
      const reference = row.cells[index] ?? null;
      const cell = document.createElement(row.parentElement?.tagName === 'THEAD' ? 'th' : 'td');
      cell.appendChild(document.createElement('br'));
      row.insertBefore(cell, reference);
    }
    selected.column = index;
    selected.columnEnd = index;
    selected.mode = 'cell';
    selected.columns += 1;
    this.commitTableDom('Insert table column', (widths) => {
      const source = Math.max(0, Math.min(widths.length - 1, after ? index - 1 : index));
      const width = widths[source] ?? 1;
      widths[source] = width / 2;
      widths.splice(index, 0, width / 2);
      return widths;
    });
    this.syncTableHeight(selected.elementId);
  }

  deleteTableColumn(): void {
    const table = this.activeTable();
    const selected = this.tableSelection;
    if (!table || !selected || selected.columns <= 1) return;
    const removedColumn = Math.min(selected.column, selected.columnEnd);
    for (const row of [...table.rows]) row.cells[removedColumn]?.remove();
    selected.columns -= 1;
    selected.column = Math.min(selected.column, selected.columns - 1);
    selected.columnEnd = selected.column;
    selected.rowEnd = selected.row;
    selected.mode = 'cell';
    this.commitTableDom('Delete table column', (widths) => {
      const [removed = 0] = widths.splice(removedColumn, 1);
      const recipient = Math.min(removedColumn, widths.length - 1);
      if (recipient >= 0) widths[recipient] += removed;
      return widths;
    });
    this.syncTableHeight(selected.elementId);
  }

  private captureTextSelection(): void {
    if (!this.editingId) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (content?.contains(range.commonAncestorContainer)) {
      const container = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      const activeMarker = container?.closest('[data-editor-typing-style]') ?? null;
      // Once the caret leaves a pending run, seal authored characters and
      // remove an unused sentinel. Otherwise invisible marker characters
      // accumulate and corrupt later plain-text offset bookmarks.
      content.querySelectorAll<HTMLElement>('[data-editor-typing-style]').forEach((marker) => {
        if (marker !== activeMarker) this.clearTypingStyleMarker(marker);
      });
      this.textSelectionRange = range.cloneRange();
    }
  }

  /** Show or hide the numbered build badges (on while the Build tab is open). */
  setBuildBadgesVisible(visible: boolean): void {
    if (this.buildBadgesVisible === visible) return;
    this.buildBadgesVisible = visible;
    this.render();
  }

  /** The element whose mask is being edited, if any. */
  maskingElement(): string | null {
    return this.maskingId;
  }

  /**
   * Turn mask editing on or off for an element.
   *
   * Entering mask mode seeds a full-frame crop if the element has none, so the
   * handles have something to grab — the same lesson as the trim window, where
   * a crop hidden behind a checkbox meant there was nothing on screen to drag.
   */
  toggleMaskMode(elementId: string | null): void {
    if (elementId === null || this.maskingId === elementId) {
      this.maskingId = null;
      this.onMaskModeChange?.(null);
      this.render();
      return;
    }

    const el = this.store.slide?.elements.find((e) => e.id === elementId);
    if (!el || (el.type !== 'image' && el.type !== 'video')) return;

    if (!el.sourceBox) {
      this.store.commit((deck) => {
        const target = deck.slides[this.store.get().slideIndex].elements.find(
          (e) => e.id === elementId,
        );
        if (target && (target.type === 'image' || target.type === 'video')) {
          // The media currently fills the box exactly, so a full-frame crop is
          // the identity transform and nothing moves on screen.
          target.sourceBox = { x: 0, y: 0, w: target.w, h: target.h };
        }
      }, { label: 'Edit media mask' });
    }

    this.maskingId = elementId;
    this.store.select([elementId]);
    this.onMaskModeChange?.(elementId);
    this.render();
  }

  /**
   * Resize the crop window while keeping the media fixed on the slide.
   *
   * Moving an edge changes the element box, and `sourceBox` is shifted by the
   * same amount in the opposite direction so the visible picture does not slide
   * around under the cursor. That is the difference between cropping and
   * scaling.
   */
  private applyMaskResize(elementId: string, rect: Rect, origin: Rect): void {
    // The offset is measured from where the drag began, so it must be applied
    // to the crop as it was at that moment. Applying it to the *current* crop
    // would re-add the whole delta on every pointermove, and the media would
    // shoot out of its window within a few frames.
    const base = this.maskOrigin;
    if (!base) return;

    this.store.commit((deck) => {
      const el = deck.slides[this.store.get().slideIndex].elements.find(
        (e) => e.id === elementId,
      );
      if (!el || (el.type !== 'image' && el.type !== 'video')) return;

      const dx = rect.x - origin.x;
      const dy = rect.y - origin.y;
      el.x = Math.round(rect.x);
      el.y = Math.round(rect.y);
      el.w = Math.max(8, Math.round(rect.w));
      el.h = Math.max(8, Math.round(rect.h));
      el.sourceBox = {
        w: base.w,
        h: base.h,
        x: Math.round(base.x - dx),
        y: Math.round(base.y - dy),
      };
    });
  }

  /** Topmost element containing a canvas point. */
  private hitTest(point: { x: number; y: number }): SlideElement | null {
    const slide = this.store.slide;
    if (!slide) return null;
    const ordered = [...slide.elements].sort((a, b) => b.z - a.z);
    for (const el of ordered) {
      if (elementContainsPoint(el, point, LINE_HIT_SCREEN_PX / this.scale)) return el;
      // Text that outgrew its box is painted outside it, and a box-only hit
      // test made those visible glyphs unclickable: clicking the words you
      // can see selected whatever happened to be behind them. Overflowing
      // text belongs to its box, so it selects its box.
      if (el.type !== 'text') continue;
      if (rectContainsPoint(el, textPaintBox(el, this.textPaintMetrics(el)), point)) return el;
    }
    return null;
  }

  /**
   * Where a text element's content actually landed, relative to the element's
   * own origin, in slide units.
   *
   * Read from layout (`offset*`) rather than `getBoundingClientRect`, so the
   * stage's zoom transform and any rotation are already out of the numbers:
   * the wrapper is the content's offset parent, and both live in slide space.
   */
  private textPaintMetrics(el: SlideElement): PaintMetrics | null {
    if (el.type !== 'text') return null;
    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(el.id)}"]`,
    );
    const content = node?.querySelector<HTMLElement>(':scope > .text-body > .text-content');
    if (!content) return null;
    return {
      left: content.offsetLeft,
      top: content.offsetTop,
      width: content.offsetWidth,
      height: content.offsetHeight,
    };
  }

  /**
   * Drop media from Finder/Nautilus straight onto the slide.
   *
   * Elements appear instantly as pending placeholders — real elements, so they
   * can be moved and resized (and sync to collaborators) while the bytes are
   * still uploading or transcoding. Each file then imports independently,
   * streaming progress into its placeholder; when the import lands, the
   * placeholder src is swapped for the real asset path.
   */
  private bindDrop(): void {
    // Both the desktop preload and the collab netApi push import progress
    // through this hook; it's absent only in stripped-down harnesses.
    window.api.onAssetImportProgress?.((p) => {
      setPendingProgress(p);
      applyPendingHud(this.slideLayer);
    });

    const stop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    this.host.addEventListener('dragover', (e) => {
      stop(e);
      this.host.classList.add('drop-active');
    });
    this.host.addEventListener('dragleave', () => this.host.classList.remove('drop-active'));

    this.host.addEventListener('drop', async (e) => {
      stop(e);
      this.host.classList.remove('drop-active');
      const files = [...(e.dataTransfer?.files ?? [])]
        .map((file) => ({ file, kind: classifyMediaName(file.name) }))
        .filter((f): f is { file: File; kind: 'image' | 'video' } => f.kind !== null);
      if (files.length === 0) return;

      const { deck } = this.store.get();
      const r = this.stage.getBoundingClientRect();
      const dropPoint = {
        x: (e.clientX - r.left) / this.scale,
        y: (e.clientY - r.top) / this.scale,
      };

      // Natural size and a preview frame are read from the local bytes before
      // anything uploads, so the placeholder lands with the right aspect and
      // shows the first frame while the import runs.
      const probes = await Promise.all(
        files.map(({ file, kind }) => probeLocalFile(file, kind)),
      );

      const created: string[] = [];
      const drops = files.map(({ file, kind }, i) => {
        // Fall back to a PDF-ish or 16:9 box when the browser can't decode it.
        const natural = {
          w: probes[i].width ?? (file.name.toLowerCase().endsWith('.pdf') ? 1400 : 1600),
          h: probes[i].height ?? (file.name.toLowerCase().endsWith('.pdf') ? 1000 : 900),
        };
        const maxW = deck.canvas.w * 0.6;
        const scale = Math.min(1, maxW / natural.w);
        const id = makeId(kind);
        created.push(id);
        return {
          file,
          kind,
          id,
          w: Math.round(natural.w * scale),
          h: Math.round(natural.h * scale),
          preview: probes[i].preview,
        };
      });

      this.store.commit((d) => {
        const slide = d.slides[this.store.get().slideIndex];
        const maxZ = slide.elements.reduce((m, el) => Math.max(m, el.z), 0);
        drops.forEach((drop, i) => {
          // Centre on the cursor, cascading multi-file drops so they don't stack.
          const offset = i * 40;
          const base = {
            id: drop.id,
            x: Math.round(dropPoint.x - drop.w / 2 + offset),
            y: Math.round(dropPoint.y - drop.h / 2 + offset),
            w: drop.w,
            h: drop.h,
            rot: 0,
            z: maxZ + 1 + i,
            opacity: 1,
            class: [],
            style: {},
          };
          const src = makePendingSrc(drop.id, drop.file.name);
          slide.elements.push(
            drop.kind === 'video'
              ? {
                  ...base,
                  type: 'video',
                  src,
                  fit: 'contain',
                  autoplay: true,
                  loop: true,
                  muted: true,
                  controls: false,
                  start: 0,
                  end: null,
                  poster: null,
                  sourceBox: null,
                }
              : {
                  ...base,
                  type: 'image',
                  src,
                  fit: 'contain',
                  alt: drop.file.name,
                  sourceBox: null,
                },
          );
        });
      });
      this.store.select(created);
      for (const drop of drops) {
        if (drop.preview) setPendingPreview(drop.id, drop.preview);
      }
      applyPendingHud(this.slideLayer);

      // Each file imports on its own: one failure marks only its placeholder.
      await Promise.all(drops.map((drop) => this.importDroppedFile(drop)));
    });
  }

  /** Upload/import one dropped file and resolve its pending placeholder. */
  private async importDroppedFile(drop: {
    file: File;
    id: string;
    w: number;
    h: number;
  }): Promise<void> {
    try {
      // The browser collab client uploads file bytes over HTTP; Electron
      // recovers filesystem paths through the preload. Both land in the same
      // content-hash importer, keyed by the element id for progress events.
      const assets = window.api.importAssetFiles
        ? await window.api.importAssetFiles([drop.file], drop.id)
        : await window.api.importAssets(
            [window.api.pathForFile(drop.file)].filter(Boolean),
            drop.id,
          );
      const asset = assets[0];
      if (!asset) throw new Error('unsupported or unreadable file');

      clearPending(drop.id);
      this.store.commit((d) => {
        // Every element still holding this upload's placeholder src, not just
        // the one that was dropped. Duplicating (or copy-pasting) an element
        // mid-upload clones the `pending:` src under a fresh id, and resolving
        // by id alone left the copy a placeholder for good -- saved into the
        // deck, so it stayed broken after a reload too.
        for (const slide of d.slides) {
          for (const el of slide.elements) {
            if (el.type !== 'image' && el.type !== 'video') continue;
            if (pendingToken(el.src) !== drop.id) continue;
            el.src = asset.src;
            // If the box is untouched and the real dimensions differ from the
            // local guess (a PDF, or an undecodable codec), refit it in place.
            if (el.w === drop.w && el.h === drop.h && asset.width && asset.height) {
              const maxW = d.canvas.w * 0.6;
              const scale = Math.min(1, maxW / asset.width);
              const w = Math.round(asset.width * scale);
              const h = Math.round(asset.height * scale);
              el.x = Math.round(el.x + (el.w - w) / 2);
              el.y = Math.round(el.y + (el.h - h) / 2);
              el.w = w;
              el.h = h;
            }
          }
        }
      });
    } catch (err) {
      console.error(`Import failed for ${drop.file.name}:`, err);
      markPendingFailed(drop.id);
      applyPendingHud(this.slideLayer);
    }
  }
}

/**
 * Whether two versions of a slide differ only in geometry.
 *
 * Same elements, same order, same media and same content — so the existing DOM
 * can be repositioned rather than rebuilt.
 */
function sameStructure(a: Slide, b: Slide, ignoreHtml = false): boolean {
  if (a.elements.length !== b.elements.length) return false;
  for (let i = 0; i < a.elements.length; i++) {
    const x = a.elements[i];
    const y = b.elements[i];
    if (x.id !== y.id || x.type !== y.type || x.z !== y.z) return false;
    if ('src' in x && 'src' in y && x.src !== y.src) return false;
    if (
      (x.type === 'image' || x.type === 'video') &&
      (y.type === 'image' || y.type === 'video') &&
      Boolean(x.sourceBox) !== Boolean(y.sourceBox)
    ) return false;
    if (!ignoreHtml && 'html' in x && 'html' in y && x.html !== y.html) return false;
    if (x.class.join(' ') !== y.class.join(' ')) return false;
    if (
      (x.type === 'text' || x.type === 'image' || x.type === 'video') &&
      (y.type === 'text' || y.type === 'image' || y.type === 'video') &&
      JSON.stringify(x.effects ?? []) !== JSON.stringify(y.effects ?? [])
    ) return false;
    // Shape paint and kind live on SVG children; wrapper-only updates cannot
    // apply them. Rebuild when they change (including rect -> ellipse).
    if (x.type === 'shape' && y.type === 'shape') {
      if (
        x.shape !== y.shape || x.fill !== y.fill || x.stroke !== y.stroke ||
        x.strokeWidth !== y.strokeWidth || x.radius !== y.radius ||
        x.path !== y.path || x.arrowStart !== y.arrowStart || x.arrowEnd !== y.arrowEnd ||
        Boolean(x.control) !== Boolean(y.control)
      ) return false;
    }
    // The crop VALUE is geometry (applyGeometry moves the inner media), but a
    // crop appearing or vanishing changes the DOM shape (wrapper vs bare tag).
    // Treating value changes as structural rebuilt the <video> on every frame
    // of a resize, which leaked media elements until the app crashed.
    const ac = 'sourceBox' in x ? x.sourceBox !== null : false;
    const bc = 'sourceBox' in y ? y.sourceBox !== null : false;
    if (ac !== bc) return false;
  }
  return true;
}

/** Axis-aligned bounds of an element as rendered (rotation about its centre). */
function rotatedBounds(el: SlideElement): Rect {
  if (!el.rot) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const rad = (el.rot * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = el.w * cos + el.h * sin;
  const h = el.w * sin + el.h * cos;
  return { x: el.x + (el.w - w) / 2, y: el.y + (el.h - h) / 2, w, h };
}

/** Geometry-aware hit testing, with a screen-derived tolerance for strokes. */
/** Layout of a text element's content box, relative to the element's origin. */
export interface PaintMetrics {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The rect a text element is actually visible in: its own box, grown to cover
 * any content that spilled out of it.
 *
 * Auto-fit and no-wrap boxes clip their overflow (see type.css), so for those
 * the box is the whole of what is painted and the element's own bounds stand.
 */
export function textPaintBox(
  el: SlideElement,
  painted: PaintMetrics | null,
): { x: number; y: number; w: number; h: number } {
  const box = { x: el.x, y: el.y, w: el.w, h: el.h };
  if (el.type !== 'text' || !painted || el.autoFit || el.noWrap) return box;
  const left = Math.min(0, painted.left);
  const top = Math.min(0, painted.top);
  const right = Math.max(el.w, painted.left + painted.width);
  const bottom = Math.max(el.h, painted.top + painted.height);
  return { x: el.x + left, y: el.y + top, w: right - left, h: bottom - top };
}

/**
 * Whether a canvas point falls inside a rect that rotates with `el`.
 *
 * A grown text rect is still drawn under the element's own rotation, about
 * the element's own centre -- not the grown rect's.
 */
export function rectContainsPoint(
  el: SlideElement,
  rect: { x: number; y: number; w: number; h: number },
  point: { x: number; y: number },
): boolean {
  if (rect.w <= 0 || rect.h <= 0) return false;
  let { x, y } = point;
  if (el.rot) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const rad = (-el.rot * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
  }
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export function elementContainsPoint(
  el: SlideElement,
  point: { x: number; y: number },
  tolerance = LINE_HIT_SCREEN_PX,
): boolean {
  if (el.type === 'shape' && (el.shape === 'line' || el.shape === 'arrow')) {
    const { start, end } = lineEndpoints(el);
    if (el.control) {
      let previous = start;
      for (let i = 1; i <= 24; i++) {
        const t = i / 24;
        const inverse = 1 - t;
        const next = {
          x: inverse * inverse * start.x + 2 * inverse * t * el.control.x + t * t * end.x,
          y: inverse * inverse * start.y + 2 * inverse * t * el.control.y + t * t * end.y,
        };
        if (distanceToSegment(point, previous, next) <= Math.max(tolerance, el.strokeWidth / 2)) {
          return true;
        }
        previous = next;
      }
      return false;
    }
    const vx = end.x - start.x;
    const vy = end.y - start.y;
    const length2 = vx * vx + vy * vy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1,
      ((point.x - start.x) * vx + (point.y - start.y) * vy) / length2));
    const nearestX = start.x + t * vx;
    const nearestY = start.y + t * vy;
    return Math.hypot(point.x - nearestX, point.y - nearestY) <=
      Math.max(tolerance, el.strokeWidth / 2);
  }
  // Rotated elements render about their centre; undo the rotation on the
  // point so the axis-aligned bounds check matches what's on screen.
  let { x, y } = point;
  if (el.rot) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const rad = (-el.rot * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
  }

  if (el.type === 'shape' && (el.shape === 'rect' || el.shape === 'ellipse')) {
    const fillVisible = visiblePaint(el.fill);
    const strokeVisible = visiblePaint(el.stroke) && el.strokeWidth > 0;
    if (!fillVisible && !strokeVisible) return false;

    if (el.shape === 'rect') {
      const inside = x >= el.x && x <= el.x + el.w &&
        y >= el.y && y <= el.y + el.h;
      if (!inside || fillVisible) return inside;

      // A hollow rectangle is paint only at its perimeter. Treating its whole
      // bounding box as solid made a subtle full-slide border intercept every
      // click on the objects beneath it.
      const distanceToEdge = Math.min(
        x - el.x,
        el.x + el.w - x,
        y - el.y,
        el.y + el.h - y,
      );
      return distanceToEdge <= Math.max(tolerance, el.strokeWidth / 2);
    }

    const rx = el.w / 2;
    const ry = el.h / 2;
    const dx = x - (el.x + rx);
    const dy = y - (el.y + ry);
    const implicit = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
    if (fillVisible) return implicit <= 1;
    if (!strokeVisible) return false;

    // First-order distance to the ellipse boundary. This keeps the forgiving
    // screen-space stroke tolerance without turning an unfilled ellipse into
    // a solid rectangular target.
    const gradient = Math.hypot((2 * dx) / (rx * rx), (2 * dy) / (ry * ry));
    const distanceToEdge = gradient > 0
      ? Math.abs(implicit - 1) / gradient
      : Number.POSITIVE_INFINITY;
    return distanceToEdge <= Math.max(tolerance, el.strokeWidth / 2);
  }
  return x >= el.x && x <= el.x + el.w &&
    y >= el.y && y <= el.y + el.h;
}

/** Whether a point is inside the visible crop window of a media element. */
function mediaMaskContainsPoint(
  el: Extract<SlideElement, { type: 'image' | 'video' }>,
  point: { x: number; y: number },
): boolean {
  // Media rotates around its centre. Bring the pointer back into the element's
  // unrotated coordinate system before testing the clip shape.
  let { x, y } = point;
  if (el.rot) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const rad = (-el.rot * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
  }

  if (x < el.x || x > el.x + el.w || y < el.y || y > el.y + el.h) return false;

  if (el.maskShape === 'circle') {
    const rx = el.w / 2;
    const ry = el.h / 2;
    const dx = x - (el.x + rx);
    const dy = y - (el.y + ry);
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  }

  // Match the rounded rectangle produced by the inspector's corner-radius
  // control. CSS caps an oversized radius at half the shortest side.
  const radius = Math.min(el.borderRadius ?? 0, el.w / 2, el.h / 2);
  if (radius <= 0) return true;
  if (
    (x >= el.x + radius && x <= el.x + el.w - radius) ||
    (y >= el.y + radius && y <= el.y + el.h - radius)
  ) return true;
  const cornerX = x < el.x + radius ? el.x + radius : el.x + el.w - radius;
  const cornerY = y < el.y + radius ? el.y + radius : el.y + el.h - radius;
  return Math.hypot(x - cornerX, y - cornerY) <= radius;
}

/** Whether a CSS paint value produces visible pixels. */
function visiblePaint(value: string | null): boolean {
  if (!value) return false;
  const paint = value.trim().toLowerCase();
  if (!paint || paint === 'none' || paint === 'transparent') return false;
  const alpha = paint.match(/^rgba?\([^)]*[,/]\s*([\d.]+)%?\s*\)$/)?.[1];
  return alpha === undefined || Number(alpha) > 0;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const vx = end.x - start.x;
  const vy = end.y - start.y;
  const length2 = vx * vx + vy * vy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * vx + (point.y - start.y) * vy) / length2));
  return Math.hypot(point.x - (start.x + t * vx), point.y - (start.y + t * vy));
}

/**
 * The two endpoints of a line/arrow element in canvas coordinates. The shape
 * renders from the box's left-centre to right-centre, rotated about the
 * box centre — so endpoints are derived, not stored.
 */
export function lineEndpoints(el: {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const rad = (el.rot * Math.PI) / 180;
  const dx = (Math.cos(rad) * el.w) / 2;
  const dy = (Math.sin(rad) * el.w) / 2;
  return {
    start: { x: cx - dx, y: cy - dy },
    end: { x: cx + dx, y: cy + dy },
  };
}

/** Rebuild a line element's box+rotation from two endpoints. */
export function lineFromEndpoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  h: number,
): { x: number; y: number; w: number; h: number; rot: number } {
  const w = Math.max(8, Math.hypot(end.x - start.x, end.y - start.y));
  const rot = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
  const cx = (start.x + end.x) / 2;
  const cy = (start.y + end.y) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot };
}

function unionRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Force a resize back onto the original aspect ratio, keeping the anchor corner
 * (the one opposite the handle) fixed.
 */
function constrainAspect(
  rect: Rect,
  origin: Rect,
  edges: { left: boolean; right: boolean; top: boolean; bottom: boolean },
  aspect: number,
): Rect {
  const out = { ...rect };
  // Drive from whichever dimension the handle changed more, so the box tracks
  // the cursor rather than snapping to one axis.
  const dw = Math.abs(rect.w - origin.w);
  const dh = Math.abs(rect.h - origin.h);
  if (dw >= dh) out.h = out.w / aspect;
  else out.w = out.h * aspect;

  if (edges.left) out.x = origin.x + origin.w - out.w;
  if (edges.top) out.y = origin.y + origin.h - out.h;
  return out;
}

/**
 * Apply one resize scale to an object's own box.
 *
 * Multi-selected objects do not become a temporary group: each keeps its
 * position and uses the same handle/opposite-edge relationship as the object
 * whose handle is being dragged. This is the Office-style behaviour that lets
 * several separate objects grow or shrink identically without changing the
 * spacing between their anchor edges.
 */
function resizeByScale(
  origin: ResizeOrigin,
  edges: { left: boolean; right: boolean; top: boolean; bottom: boolean },
  scaleX: number,
  scaleY: number,
  centered: boolean,
): Rect {
  const w = origin.w * scaleX;
  const h = origin.h * scaleY;
  let x = centered
    ? origin.x + (origin.w - w) / 2
    : edges.left
      ? origin.x + origin.w - w
      : origin.x;
  let y = centered
    ? origin.y + (origin.h - h) / 2
    : edges.top
      ? origin.y + origin.h - h
      : origin.y;

  // Each object's handles live in its own rotated frame. Keep its opposite
  // visible edge pinned just as a direct single-object resize does.
  if (origin.rot) {
    const radians = origin.rot * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const localDx = x + w / 2 - (origin.x + origin.w / 2);
    const localDy = y + h / 2 - (origin.y + origin.h / 2);
    x = origin.x + origin.w / 2 + (localDx * cos - localDy * sin) - w / 2;
    y = origin.y + origin.h / 2 + (localDx * sin + localDy * cos) - h / 2;
  }

  return { x, y, w, h };
}

/** Scale an absolute point in the same local, possibly rotated frame. */
function resizePointByScale(
  point: { x: number; y: number },
  origin: ResizeOrigin,
  resized: Rect,
  scaleX: number,
  scaleY: number,
): { x: number; y: number } {
  const radians = origin.rot * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - (origin.x + origin.w / 2);
  const dy = point.y - (origin.y + origin.h / 2);
  const localX = (dx * cos + dy * sin) * scaleX;
  const localY = (-dx * sin + dy * cos) * scaleY;
  return {
    x: resized.x + resized.w / 2 + localX * cos - localY * sin,
    y: resized.y + resized.h / 2 + localX * sin + localY * cos,
  };
}
