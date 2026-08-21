import { MIRRORED_TEXT_STYLE_PROPERTIES } from '@shared/deck.js';
import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { type Rect, fitScale, makeId } from '@shared/geometry.js';
import {
  fitAutoText,
  quadraticPath,
  renderElement,
  renderSlide,
  scheduleAutoFit,
  syncMediaFrame,
} from '../player/render.js';
import { typedPropertyOwnsCss } from '@shared/nativeCss.js';
import { expandTimeline } from '@shared/timeline.js';
import { classifyMediaName, makePendingSrc } from '@shared/media.js';
import { normalizeParagraphHtml, paragraphUnits } from '@shared/paragraphs.js';
import {
  applyPendingHud,
  clearPending,
  markPendingFailed,
  probeLocalFile,
  setPendingPreview,
  setPendingProgress,
} from './pendingUploads.js';
import { newComment, openCommentsPopover, openCount } from './comments.js';
import { HANDLES, type SnapLine, snapMove, snapResize } from './snapping.js';
import type { EditorStore } from './store.js';

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
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;
const HANDLE_NAMES = Object.keys(HANDLES);
type MoveOrigin = Rect & { control?: { x: number; y: number } };

type DragMode =
  | { kind: 'none' }
  | { kind: 'move'; startCanvas: { x: number; y: number }; origin: Map<string, MoveOrigin> }
  | {
      kind: 'resize';
      handle: string;
      startCanvas: { x: number; y: number };
      origin: Rect;
      elementId: string;
      aspect: number;
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
      return;
    }

    this.renderedSlide = slide;

    // Re-rendering under an active text edit would destroy the node the caret
    // lives in, so the edit is committed first.
    if (this.editingId) this.commitTextEdit();

    // Which videos were playing before the redraw, so playback survives an
    // unrelated edit elsewhere on the slide.
    const playing = new Set<string>();
    for (const node of this.slideLayer.querySelectorAll<HTMLElement>('[data-element-id]')) {
      const video = node.querySelector('video');
      if (video && !video.paused) playing.add(node.dataset.elementId!);
    }

    this.slideLayer.replaceChildren(
      renderSlide(slide, { resolveSrc: (src) => window.api.assetUrl(src) }),
    );

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
    const rendered = this.slideLayer.querySelector<HTMLElement>(':scope > .slide');
    if (rendered) rendered.className = `slide layout-${slide.layout ?? 'freeform'}`;

    for (const el of slide.elements) {
      const node = this.slideLayer.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(el.id)}"]`,
      );
      if (!node) continue;

      // Inline styles (colour above all) change without changing structure and
      // must land here — before this, picking a text colour updated the deck
      // but never the pixels. Keys removed since the last render are cleared.
      const before = previous?.elements.find((e) => e.id === el.id);
      if (before) {
        for (const key of Object.keys(before.style)) {
          if (!(key in el.style) || typedPropertyOwnsCss(el, key)) node.style.removeProperty(key);
        }
      }
      for (const [key, value] of Object.entries(el.style)) {
        if (typedPropertyOwnsCss(el, key)) {
          node.style.removeProperty(key);
          continue;
        }
        node.style.setProperty(key, value);
      }
      // Inheritable text properties are also mirrored onto .text-content
      // (see MIRRORED_TEXT_STYLE_PROPERTIES): theme rules that target the
      // content node directly would otherwise override the element's inline
      // style, and colour changes from the inspector would never show.
      if (el.type === 'text') {
        // Alignment is a typed property, not an entry in el.style, so nothing
        // above touches it: without this an align change updated the deck but
        // never the pixels until the slide was rebuilt from scratch.
        const body = node.querySelector<HTMLElement>('.text-body');
        if (body) {
          body.style.textAlign = el.align;
          body.style.justifyContent =
            el.valign === 'top' ? 'flex-start' : el.valign === 'bottom' ? 'flex-end' : 'center';
        }
        const content = node.querySelector<HTMLElement>('.text-content');
        if (content) {
          for (const property of MIRRORED_TEXT_STYLE_PROPERTIES) {
            const value = el.style[property];
            if (value !== undefined) content.style.setProperty(property, value);
            else content.style.removeProperty(property);
          }
        }
      }

      node.style.left = `${el.x}px`;
      node.style.top = `${el.y}px`;
      node.style.width = `${el.w}px`;
      node.style.height = `${el.h}px`;
      node.style.opacity = String(el.opacity);
      node.style.transform = el.rot ? `rotate(${el.rot}deg)` : '';
      if (el.type === 'text') {
        // Mirrored here as well as in renderElement so a spacing change shows
        // immediately — including mid-edit — instead of on the next rebuild.
        if (el.paragraphSpacing !== undefined) {
          node.dataset.paragraphSpacing = String(el.paragraphSpacing);
          node.style.setProperty('--paragraph-spacing', `${el.paragraphSpacing}px`);
        } else {
          delete node.dataset.paragraphSpacing;
          node.style.removeProperty('--paragraph-spacing');
        }
        if (el.noWrap) node.dataset.noWrap = 'true';
        else delete node.dataset.noWrap;
        if (el.noWrap && el.noWrapMode === 'condense') node.dataset.fitMode = 'condense';
        else delete node.dataset.fitMode;
        // noWrap implies the fit: with soft wrapping off, shrinking is the
        // only way an overlong line stays inside the box.
        if (el.autoFit || el.noWrap) {
          node.dataset.autoFit = 'true';
          scheduleAutoFit(node);
        } else {
          delete node.dataset.autoFit;
          node.querySelector<HTMLElement>('.text-content')?.style.removeProperty('font-size');
        }
      }
      if (el.type === 'image' || el.type === 'video') {
        syncMediaFrame(node, el);
      }
      if (el.type === 'video') {
        const video = node.querySelector<HTMLVideoElement>('video');
        if (video) video.controls = el.controls;
      }

      if (el.type === 'shape' && el.control) {
        node.querySelector('svg > path')?.setAttribute('d', quadraticPath(el));
      }

      // "Keep aspect ratio" flips `fit` without changing structure, so the
      // inner tag's object-fit must follow here — otherwise a resize with the
      // toggle off keeps letterboxing instead of stretching the picture.
      if ((el.type === 'image' || el.type === 'video') && !el.sourceBox) {
        const media = node.querySelector<HTMLElement>('img, video');
        if (media) media.style.objectFit = el.fit;
      }

      // Cropped media: the inner tag is positioned in the window's coordinates
      // and has to follow crop changes here, since they no longer rebuild.
      if ((el.type === 'image' || el.type === 'video') && el.sourceBox) {
        const media = node.querySelector<HTMLElement>('img, video');
        if (media) {
          media.style.left = `${el.sourceBox.x}px`;
          media.style.top = `${el.sourceBox.y}px`;
          media.style.width = `${el.sourceBox.w}px`;
          media.style.height = `${el.sourceBox.h}px`;
        }
      }
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
      if (event.ctrlKey) {
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

      // At an enlarged view, ordinary two-finger scrolling moves the viewport
      // so every part of the slide remains reachable.
      if (this.zoom > 1) {
        event.preventDefault();
        this.pan.x -= event.deltaX;
        this.pan.y -= event.deltaY;
        this.rescale();
      }
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

      // Handles only on a single selection: resizing a multi-selection needs a
      // group transform, which v1 doesn't model.
      if (selection.size === 1) {
        for (const name of HANDLE_NAMES) {
          const h = document.createElement('div');
          h.className = `handle handle-${name}`;
          h.dataset.handle = name;
          h.dataset.elementId = el.id;
          box.appendChild(h);
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
        this.drag = {
          kind: 'resize',
          handle,
          startCanvas: point,
          origin: { x: el.x, y: el.y, w: el.w, h: el.h },
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
        const others = slide.elements
          .filter((e) => !ids.has(e.id))
          .map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));

        // Snap the group by its bounding box, then apply one delta to all
        // members, so relative positions inside a multi-selection are preserved.
        const bounds = unionRect([...drag.origin.values()]);
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

      case 'resize': {
        const drag = this.drag;
        const edges = HANDLES[drag.handle];
        const dx = point.x - drag.startCanvas.x;
        const dy = point.y - drag.startCanvas.y;
        const o = drag.origin;

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
        const target = slide.elements.find((e) => e.id === drag.elementId);
        const keepAspect =
          (target?.type === 'image' || target?.type === 'video') &&
          target.fit !== 'fill' &&
          !target.sourceBox;
        if (ev.shiftKey || keepAspect) rect = constrainAspect(rect, o, edges, drag.aspect);

        const others = slide.elements
          .filter((e) => e.id !== drag.elementId)
          .map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));
        const snapped = ev.altKey
          ? { rect, guides: [] }
          : snapResize(rect, edges, deck.canvas, others, threshold);
        this.guides = snapped.guides;

        const r = { ...snapped.rect };
        if (centered) {
          // Aspect constraints and snapping anchor the opposite corner, which
          // would drift the center — pin it back to where the drag started.
          r.x = o.x + (o.w - r.w) / 2;
          r.y = o.y + (o.h - r.h) / 2;
        }
        if (this.maskingId === drag.elementId) {
          // Cropping, not scaling: the window moves, the picture stays put.
          this.applyMaskResize(drag.elementId, r, drag.origin);
          break;
        }
        const cropBase = this.maskOrigin;
        this.store.updateSelected((el) => {
          if (el.id !== drag.elementId) return;
          el.x = Math.round(r.x);
          el.y = Math.round(r.y);
          el.w = Math.max(8, Math.round(r.w));
          el.h = Math.max(8, Math.round(r.h));
          // Resizing a cropped element scales the whole picture with its
          // window, so the crop composition is preserved — without this, a
          // resize silently re-crops instead of scaling.
          if ((el.type === 'image' || el.type === 'video') && cropBase) {
            const fx = el.w / Math.max(1, drag.origin.w);
            const fy = el.h / Math.max(1, drag.origin.h);
            el.sourceBox = {
              x: Math.round(cropBase.x * fx),
              y: Math.round(cropBase.y * fy),
              w: Math.max(1, Math.round(cropBase.w * fx)),
              h: Math.max(1, Math.round(cropBase.h * fy)),
            };
          }
        });
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
  }

  private endDrag(): void {
    this.store.endTransaction();
    this.drag = { kind: 'none' };
    this.dragStarted = false;
    this.host.classList.remove('is-rotating');
    this.maskOrigin = null;
    this.guides = [];
    this.marquee = null;

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
  beginTextEdit(elementId: string): void {
    const slide = this.store.slide;
    const el = slide?.elements.find((e) => e.id === elementId);
    if (!el || (el.type !== 'text' && el.type !== 'html')) return;

    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const body = node?.querySelector<HTMLElement>('.text-content') ?? null;
    if (!body) return;

    this.editingId = elementId;
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
      const html = normalizeParagraphHtml(body.innerHTML);
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

    const finish = (commit: boolean) => {
      body.removeEventListener('blur', onBlur);
      body.removeEventListener('keydown', onKey);
      body.removeEventListener('input', onInput);
      if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = 0;
      }
      if (commit) this.commitTextEdit();
      else {
        this.editingId = null;
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

    const onBlur = () => finish(true);
    const onInput = () => {
      if (el.type === 'text' && (el.autoFit || el.noWrap)) scheduleAutoFit(node!);
      if (this.liveTextSync && !liveTimer) liveTimer = window.setTimeout(pushLive, 250);
    };
    const onKey = (e: KeyboardEvent) => {
      // Editing keys must not reach the canvas shortcuts (Delete would remove
      // the element you are typing into).
      e.stopPropagation();
      if (e.key === 'Escape') {
        // Escape leaves edit mode but keeps what was typed — it is "done
        // editing", not "undo my edit". Undo is still one keystroke away.
        e.preventDefault();
        finish(true);
        body.blur();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish(true);
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
    body.addEventListener('input', onInput);
  }

  /** Write the edited markup back to the deck as a single undoable change. */
  private commitTextEdit(): void {
    const elementId = this.editingId;
    if (!elementId) return;
    this.editingId = null;
    this.textSelectionRange = null;
    this.onTextEditModeChange?.(null);

    const node = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const body = node?.querySelector<HTMLElement>('.text-content') ?? null;
    if (!body) return;

    // Without `splitBreaks`: a shift-return the author typed is a soft break
    // inside its paragraph, not a new one.
    const html = normalizeParagraphHtml(body.innerHTML);
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
    if (current.html === html && html === (originalHtml ?? html)) return;

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

  /** True while a text element is being edited, so callers can defer redraws. */
  isEditing(): boolean {
    return this.editingId !== null;
  }

  /** Refit after live theme CSS changes without rebuilding the slide DOM. */
  refitAutoText(): void {
    fitAutoText(this.slideLayer);
  }

  /** Apply weight to the selected characters without styling the whole box. */
  applyTextSelectionWeight(weight: number): boolean {
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

    const span = document.createElement('span');
    span.style.fontWeight = String(Math.max(100, Math.min(900, weight)));
    span.appendChild(range.extractContents());
    range.insertNode(span);
    const next = document.createRange();
    next.selectNodeContents(span);
    live?.removeAllRanges();
    live?.addRange(next);
    this.textSelectionRange = next.cloneRange();
    return true;
  }

  private captureTextSelection(): void {
    if (!this.editingId) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const content = this.slideLayer.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(this.editingId)}"] .text-content`,
    );
    if (content?.contains(range.commonAncestorContainer)) {
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
    }
    return null;
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
        for (const slide of d.slides) {
          const el = slide.elements.find((x) => x.id === drop.id);
          if (!el || (el.type !== 'image' && el.type !== 'video')) continue;
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
          return;
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
