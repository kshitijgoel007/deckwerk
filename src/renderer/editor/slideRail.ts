import { makeId } from '@shared/geometry.js';
import { recoverPreviewFrames } from '../player/previewFrameRecovery.js';
import { freezePreviewVideos } from '../player/previewPoster.js';
import { renderSlide } from '../player/render.js';
import { applySlideLayout } from './slideLayouts.js';
import { newComment, openCommentsPopover, openCount } from './comments.js';
import type { Deck, Slide } from '@shared/deck.js';
import type { EditorStore } from './store.js';

/**
 * The slide list. Text-first rather than thumbnail-first: rendering live
 * thumbnails of video-heavy slides would mean decoding every clip in the deck
 * at once, which is exactly the cost this tool exists to avoid.
 */
/** Rendered width of a slide thumbnail, in CSS pixels. */
const THUMB_WIDTH = 168;
/** Enough decoded thumbnails for the viewport plus generous scroll overscan. */
const THUMB_CACHE_LIMIT = 40;

export interface RailPresence {
  name: string;
  color: string;
  selectedElementIds: string[];
}

export class SlideRail {
  private host: HTMLElement;
  private store: EditorStore;
  /** Keeps cached slide surfaces scaled to the fluid thumbnail frame. */
  private thumbResizeObserver: ResizeObserver | null = null;
  /** Mount full slide DOM only near the scroll viewport. */
  private thumbVisibilityObserver: IntersectionObserver | null = null;
  private pendingThumbs = new WeakMap<HTMLElement, { deck: Deck; slide: Slide }>();
  /** Index of the slide being dragged, while a reorder is in progress. */
  private dragFrom: number | null = null;
  /** Off-screen node used as the drag image while reordering. */
  private dragImage: HTMLElement | null = null;
  /** The slides array last drawn, so a selection change can skip the rebuild. */
  private renderedSlides: unknown = null;
  /**
   * Thumbnail DOM cached per slide *object*. The store clones the deck on
   * every commit but untouched slides keep their object identity, so only the
   * edited slide's thumbnail is rebuilt. Rebuilding all of them recreated
   * every <video> in the rail on every edit — none of which had loaded a frame
   * yet, so the previews went black.
   */
  private thumbCache = new Map<unknown, HTMLElement>();
  /**
   * Runs of consecutive hidden slides the user has expanded, keyed by the id
   * of the run's first slide. Runs of two or more hidden slides collapse into
   * a single placeholder by default; expanding is an explicit, per-run choice
   * that survives re-renders but not a reload.
   */
  private expandedRuns = new Set<string>();
  /**
   * The active hidden slide whose run the user explicitly collapsed.
   *
   * Normally selecting a hidden slide auto-expands its run so the rail never
   * loses the selection. The collapse bracket is an explicit exception: keep
   * editing that slide even though its row is now represented by the run
   * placeholder. Selecting another slide clears the exception.
   */
  private collapsedActiveSlideId: string | null = null;
  /**
   * Collaboration presence: who is on which slide, drawn as colored dots on
   * the rail rows. Unset outside collab sessions.
   */
  presenceForSlide?: (slideId: string) => RailPresence[];

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.store = store;
    if (typeof ResizeObserver !== 'undefined') {
      this.thumbResizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) this.scaleThumb(entry.target as HTMLElement);
        // Remote-selection boxes share the thumbnail's scale, so they must
        // track the frame without forcing its cached slide DOM to be rebuilt.
        this.refreshPresence();
      });
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.thumbVisibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const placeholder = entry.target as HTMLElement;
          const pending = this.pendingThumbs.get(placeholder);
          this.thumbVisibilityObserver?.unobserve(placeholder);
          if (!pending || !placeholder.isConnected) continue;
          placeholder.replaceWith(this.thumbFor(pending.deck, pending.slide));
        }
        this.refreshPresence();
      }, { root: this.host, rootMargin: '400px 0px' });
    }
    store.subscribe(() => this.onStoreChange());
    this.bindKeys();
    this.render();
  }

  /**
   * Redraw only what changed.
   *
   * Rebuilding the rail recreates every thumbnail, which tears down and
   * reloads each slide's media — the visible symptom being every video in the
   * sidebar flickering on any click, and vanishing during a drag. A selection
   * change only needs the highlight moved.
   */
  private onStoreChange(): void {
    const { deck, slideIndex, slideSelection } = this.store.get();
    const activeSlide = deck.slides[slideIndex];
    if (
      this.collapsedActiveSlideId !== null
      && (activeSlide?.id !== this.collapsedActiveSlideId || !activeSlide.skipped)
    ) {
      this.collapsedActiveSlideId = null;
    }
    if (deck.slides === this.renderedSlides) {
      this.highlight(slideIndex, slideSelection);
      return;
    }
    this.render();
  }

  private highlight(slideIndex: number, slideSelection: Set<string>): void {
    // Selecting a slide inside a collapsed run (keyboard navigation, agent
    // edits) must reveal it — its row doesn't exist until the run expands.
    if (!this.host.querySelector(`.rail-item[data-index="${slideIndex}"]`)) {
      this.render();
      return;
    }
    for (const item of this.host.querySelectorAll<HTMLElement>('.rail-item')) {
      const index = Number(item.dataset.index);
      const active = index === slideIndex;
      const slide = this.store.get().deck.slides[index];
      item.classList.toggle('active', active);
      item.classList.toggle('selected', Boolean(slide && slideSelection.has(slide.id)));
      item.setAttribute('aria-selected', String(Boolean(slide && slideSelection.has(slide.id))));
      if (active) item.scrollIntoView({ block: 'nearest' });
    }
  }

  render(): void {
    const { deck, slideIndex, slideSelection } = this.store.get();
    this.renderedSlides = deck.slides;
    this.thumbVisibilityObserver?.disconnect();
    // Drop cache entries for slides that no longer exist in this deck version.
    const live = new Set<unknown>(deck.slides);
    for (const key of this.thumbCache.keys()) {
      if (!live.has(key)) {
        const thumb = this.thumbCache.get(key);
        if (thumb) this.thumbResizeObserver?.unobserve(thumb);
        this.thumbCache.delete(key);
      }
    }
    this.host.replaceChildren();

    // Group consecutive hidden slides: runs of 2+ collapse to one placeholder
    // unless expanded. A run holding the active slide normally stays expanded;
    // an explicit bracket click may hide that row while preserving the editor.
    for (let i = 0; i < deck.slides.length; ) {
      if (!deck.slides[i].skipped) {
        this.host.appendChild(this.buildItem(deck, i, slideIndex, slideSelection));
        i += 1;
        continue;
      }
      let end = i;
      while (end + 1 < deck.slides.length && deck.slides[end + 1].skipped) end += 1;
      if (end === i) {
        this.host.appendChild(this.buildItem(deck, i, slideIndex, slideSelection));
        i += 1;
        continue;
      }
      const runKey = deck.slides[i].id;
      const containsActive = slideIndex >= i && slideIndex <= end;
      const explicitlyCollapsed = containsActive
        && deck.slides[slideIndex]?.id === this.collapsedActiveSlideId;
      if (!this.expandedRuns.has(runKey) && (!containsActive || explicitlyCollapsed)) {
        this.host.appendChild(
          this.buildCollapsedRun(deck, i, end, runKey, slideSelection),
        );
      } else {
        this.expandedRuns.add(runKey);
        this.host.appendChild(this.buildExpandedRun(deck, i, end, runKey, slideIndex, slideSelection));
      }
      i = end + 1;
    }

    const actions = document.createElement('div');
    actions.className = 'rail-actions';
    actions.append(
      railButton('+ Slide', () => this.addSlide()),
      railButton('Duplicate', () => this.duplicateSlide()),
      railButton(
        deck.slides[slideIndex]?.skipped ? 'Show' : 'Hide',
        () => this.toggleHidden(),
      ),
      railButton('Delete', () => this.deleteSlide()),
    );
    this.host.appendChild(actions);
  }

  /**
   * Placeholder row standing in for a collapsed run of hidden slides: a
   * normal-sized row whose thumbnail is the first hidden slide drawn as the
   * top card of a stack, so the collapsed run reads as "slides live here".
   */
  private buildCollapsedRun(
    deck: ReturnType<EditorStore['get']>['deck'],
    start: number,
    end: number,
    runKey: string,
    slideSelection: Set<string>,
  ): HTMLElement {
    const row = document.createElement('button');
    const selected = deck.slides
      .slice(start, end + 1)
      .some((slide) => slideSelection.has(slide.id));
    row.className = `rail-item rail-collapsed${selected ? ' selected' : ''}`;
    row.setAttribute('aria-selected', String(selected));
    row.title = `Show hidden slides ${start + 1}–${end + 1}`;

    const num = document.createElement('span');
    num.className = 'rail-num';
    num.textContent = `${start + 1}…${end + 1}`;

    const stack = document.createElement('div');
    stack.className = 'rail-stack';
    stack.style.setProperty('--rail-thumb-aspect', `${deck.canvas.w} / ${deck.canvas.h}`);
    stack.appendChild(this.thumbFor(deck, deck.slides[start]));

    const badge = document.createElement('span');
    badge.className = 'rail-skipped-badge';
    badge.textContent = `${end - start + 1} hidden`;

    row.append(num, stack, badge);
    // A collapsed run is also the only affordable target for selecting a
    // large hidden range. Shift-clicking it selects the represented run and
    // deliberately leaves the thumbnails folded.
    // Expanding a media-heavy suffix merely to select it can create dozens of
    // video surfaces at once and exhaust Chromium's renderer.
    row.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      this.collapsedActiveSlideId = deck.slides[end]?.id ?? null;
      this.store.selectSlideRange(start, end);
      this.host.focus({ preventScroll: true });
    });
    row.addEventListener('click', (event) => {
      // pointerdown above synchronously re-renders the row; keep this guard for
      // synthetic clicks and browsers that still dispatch the trailing click.
      if (event.shiftKey) return;
      this.expandedRuns.add(runKey);
      this.collapsedActiveSlideId = null;
      this.render();
    });
    return row;
  }

  /**
   * An expanded run of hidden slides: the rows themselves, with a bracket
   * along their left edge that collapses the run again when clicked.
   */
  private buildExpandedRun(
    deck: ReturnType<EditorStore['get']>['deck'],
    start: number,
    end: number,
    runKey: string,
    slideIndex: number,
    slideSelection: Set<string>,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'rail-run';
    const bracket = document.createElement('button');
    bracket.className = 'rail-run-bracket';
    bracket.title = `Collapse hidden slides ${start + 1}–${end + 1}`;
    bracket.setAttribute('aria-label', bracket.title);
    bracket.addEventListener('click', () => {
      this.expandedRuns.delete(runKey);
      if (slideIndex >= start && slideIndex <= end) {
        this.collapsedActiveSlideId = deck.slides[slideIndex]?.id ?? null;
      }
      this.render();
    });
    const col = document.createElement('div');
    col.className = 'rail-run-items';
    for (let i = start; i <= end; i += 1) {
      col.appendChild(this.buildItem(deck, i, slideIndex, slideSelection));
    }
    wrap.append(bracket, col);
    return wrap;
  }

  /**
   * A real miniature, cached by slide identity so untouched slides keep
   * their live DOM (and their already-decoded video frames) across edits.
   */
  private thumbFor(
    deck: ReturnType<EditorStore['get']>['deck'],
    slide: ReturnType<EditorStore['get']>['deck']['slides'][number],
  ): HTMLElement {
    let thumb = this.thumbCache.get(slide);
    if (thumb) {
      // Map insertion order is the LRU order.
      this.thumbCache.delete(slide);
      this.thumbCache.set(slide, thumb);
      // A cached thumbnail spends time detached while the rail rebuilds, and
      // the load gate aborts the fetch of a detached element. Re-queue
      // anything that came back without a frame rather than re-appending a
      // black box. See previewFrameRecovery.ts.
      recoverPreviewFrames(thumb);
    }
    if (!thumb) {
      thumb = document.createElement('div');
      thumb.className = 'rail-thumb';
      thumb.dataset.canvasWidth = String(deck.canvas.w);
      thumb.style.setProperty('--rail-thumb-aspect', `${deck.canvas.w} / ${deck.canvas.h}`);
      const inner = document.createElement('div');
      inner.className = 'rail-thumb-inner';
      inner.style.width = `${deck.canvas.w}px`;
      inner.style.height = `${deck.canvas.h}px`;
      if (slide.background.color) inner.style.background = slide.background.color;
      inner.appendChild(
        renderSlide(slide, { resolveSrc: (src) => window.api.assetUrl(src), mediaPreload: 'metadata' }),
      );
      for (const video of inner.querySelectorAll('video')) {
        video.removeAttribute('autoplay');
        // renderSlide's 'metadata' preload decodes exactly one poster frame,
        // so the thumbnail shows a picture without buffering the clip.
        video.pause();
      }
      // A thumbnail needs one frame, never playback, and a live <video> is
      // what makes it go black when the page is hidden, occluded or holding
      // more players than Chromium wants resident. Freeze it into a still.
      freezePreviewVideos(inner);
      thumb.appendChild(inner);
      this.scaleThumb(thumb);
      this.thumbResizeObserver?.observe(thumb);
      this.thumbCache.set(slide, thumb);
      if (this.thumbVisibilityObserver) this.trimThumbCache();
    }
    return thumb;
  }

  /** A geometry-only shell upgraded to a real slide when it nears the viewport. */
  private deferredThumb(
    deck: ReturnType<EditorStore['get']>['deck'],
    slide: Slide,
    eager: boolean,
  ): HTMLElement {
    if (eager || !this.thumbVisibilityObserver) return this.thumbFor(deck, slide);
    const placeholder = document.createElement('div');
    placeholder.className = 'rail-thumb rail-thumb-placeholder';
    placeholder.dataset.canvasWidth = String(deck.canvas.w);
    placeholder.style.setProperty('--rail-thumb-aspect', `${deck.canvas.w} / ${deck.canvas.h}`);
    this.pendingThumbs.set(placeholder, { deck, slide });
    this.thumbVisibilityObserver.observe(placeholder);
    return placeholder;
  }

  private trimThumbCache(): void {
    while (this.thumbCache.size > THUMB_CACHE_LIMIT) {
      const oldest = this.thumbCache.entries().next().value as [unknown, HTMLElement] | undefined;
      if (!oldest) return;
      const [key, thumb] = oldest;
      this.thumbCache.delete(key);
      this.thumbResizeObserver?.unobserve(thumb);
    }
  }

  /** Scale the canonical slide surface into its current fluid-width frame. */
  private scaleThumb(thumb: HTMLElement): void {
    const canvasWidth = Number(thumb.dataset.canvasWidth);
    const inner = thumb.querySelector<HTMLElement>('.rail-thumb-inner');
    if (!inner || !Number.isFinite(canvasWidth) || canvasWidth <= 0) return;
    inner.style.transform = `scale(${this.thumbWidth(thumb) / canvasWidth})`;
  }

  private thumbWidth(thumb: HTMLElement): number {
    // jsdom and detached nodes have no layout; retain the historical width as
    // a stable fallback until ResizeObserver reports the on-screen frame.
    return thumb.clientWidth || thumb.getBoundingClientRect().width || THUMB_WIDTH;
  }

  /** Re-decorate presence in place, without invalidating thumbnails. */
  refreshPresence(): void {
    for (const dots of this.host.querySelectorAll<HTMLElement>('.rail-presence')) {
      const slideId = dots.dataset.slideId;
      if (slideId) this.paintPresence(dots, slideId);
    }
  }

  private paintPresence(container: HTMLElement, slideId: string): void {
    const peers = this.presenceForSlide?.(slideId) ?? [];
    // One shared tooltip naming everyone on the slide, on the group and on
    // each dot, so hovering anywhere over the cluster shows the full list.
    const names = peers.map((peer) => peer.name).join(', ');
    container.title = names;
    container.replaceChildren(...peers.map((peer) => {
      const dot = document.createElement('span');
      dot.className = 'rail-presence-dot';
      dot.style.background = peer.color;
      dot.title = names;
      return dot;
    }));

    const item = container.closest<HTMLElement>('.rail-item');
    const thumb = item?.querySelector<HTMLElement>('.rail-thumb');
    const { deck } = this.store.get();
    const index = Number(item?.dataset.index);
    const indexedSlide = Number.isInteger(index) ? deck.slides[index] : undefined;
    const slide = indexedSlide?.id === slideId ? indexedSlide : undefined;
    if (!thumb || !slide) return;

    let selections = thumb.querySelector<HTMLElement>('.rail-presence-selections');
    if (!selections) {
      selections = document.createElement('span');
      selections.className = 'rail-presence-selections';
      thumb.appendChild(selections);
    }

    const scale = this.thumbWidth(thumb) / deck.canvas.w;
    const byId = new Map(slide.elements.map((element) => [element.id, element]));
    const boxes: HTMLElement[] = [];
    for (const [peerIndex, peer] of peers.entries()) {
      for (const id of peer.selectedElementIds) {
        const element = byId.get(id);
        if (!element) continue;
        const box = document.createElement('span');
        box.className = 'rail-presence-selection';
        box.title = peer.name;
        box.style.cssText = [
          `left:${element.x * scale}px`,
          `top:${element.y * scale}px`,
          `width:${element.w * scale}px`,
          `height:${element.h * scale}px`,
          `transform:rotate(${element.rot}deg)`,
          `outline:2px solid ${peer.color}`,
          `outline-offset:${peerIndex * 2}px`,
          `background:color-mix(in srgb, ${peer.color} 14%, transparent)`,
        ].join(';');
        boxes.push(box);
      }
    }
    selections.replaceChildren(...boxes);
  }

  /** One slide row: number, cached thumbnail, hidden badge, handlers. */
  private buildItem(
    deck: ReturnType<EditorStore['get']>['deck'],
    i: number,
    slideIndex: number,
    slideSelection: Set<string>,
  ): HTMLElement {
    const slide = deck.slides[i];
    {
      const item = document.createElement('button');
      item.className = `rail-item${slideSelection.has(slide.id) ? ' selected' : ''}${i === slideIndex ? ' active' : ''}${slide.skipped ? ' skipped' : ''}`;
      item.setAttribute('aria-selected', String(slideSelection.has(slide.id)));
      item.draggable = true;
      item.dataset.index = String(i);
      this.bindReorder(item, i);

      const num = document.createElement('span');
      num.className = 'rail-num';
      num.textContent = String(i + 1);

      const thumb = this.deferredThumb(deck, slide, i === slideIndex);
      item.append(num, thumb);
      // Presence dots live on the row (not the cached thumbnail), in the left
      // gutter beside the slide's top edge. Rows are rebuilt fresh each time,
      // so no stale container can linger here.
      const dots = document.createElement('span');
      dots.className = 'rail-presence';
      dots.dataset.slideId = slide.id;
      item.appendChild(dots);
      this.paintPresence(dots, slide.id);
      if (slide.skipped) {
        const badge = document.createElement('span');
        badge.className = 'rail-skipped-badge';
        badge.textContent = 'Hidden';
        item.appendChild(badge);
      }
      // Comment affordance in the row's bottom-right corner: hidden until
      // hover when the slide has no comments, always visible (with the open
      // count) when it does. A <span>, not a <button> — the row itself is a
      // button and nesting them is invalid HTML.
      {
        const open = openCount(slide.comments);
        const bubble = document.createElement('span');
        bubble.className = `rail-comment${open > 0 ? ' has-comments' : ''}`;
        bubble.setAttribute('role', 'button');
        bubble.title = open > 0
          ? `${open} open comment${open === 1 ? '' : 's'}`
          : 'Add comment';
        bubble.textContent = open > 0 ? String(open) : '+';
        bubble.addEventListener('pointerdown', (e) => e.stopPropagation());
        bubble.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openComments(slide.id, i, bubble.getBoundingClientRect());
        });
        item.appendChild(bubble);
      }
      // Selection runs on pointerdown, not click: the row is draggable for
      // reorder, and Chromium starts a native drag on a few pixels of drift,
      // which suppresses the click entirely — every real (slightly wobbly)
      // click on a thumbnail then did nothing.
      item.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        this.store.selectSlide(i, event.shiftKey);
        // Picking slides makes the rail the active surface, so Backspace is a
        // slide command from here on. Without this the keystroke reaches the
        // window handler, which only knows about canvas objects, and selecting
        // slides then pressing Backspace appears to do nothing at all.
        this.host.focus({ preventScroll: true });
      });
      item.addEventListener('contextmenu', (event) => this.onContextMenu(event, i));
      return item;
    }
  }

  /**
   * Right-click menu on a slide row. Shares the canvas menu's #ctx-menu
   * styling so the two menus read as one control.
   */
  private onContextMenu(ev: MouseEvent, index: number): void {
    ev.preventDefault();
    ev.stopPropagation();
    document.getElementById('ctx-menu')?.remove();

    // Right-clicking outside the current selection retargets it, matching how
    // the canvas menu (and every desktop list control) behaves.
    const { deck, slideSelection } = this.store.get();
    const slide = deck.slides[index];
    if (!slide) return;
    if (!slideSelection.has(slide.id)) this.store.selectSlide(index);
    this.host.focus({ preventScroll: true });

    const hidden = Boolean(this.store.get().deck.slides[index]?.skipped);
    const items: Array<{ label: string; action: () => void } | 'separator'> = [
      { label: hidden ? 'Show slide' : 'Hide slide', action: () => this.toggleHidden() },
      'separator',
      { label: 'Add slide below', action: () => this.addSlide() },
      { label: 'Duplicate', action: () => this.duplicateSlide() },
      'separator',
      { label: 'Delete', action: () => this.deleteSlide() },
    ];

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
    // Same ordering fix as the canvas menu: a document-level pointerdown must
    // not tear the menu down before its row can receive the click.
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    const close = () => menu.remove();
    setTimeout(() => document.addEventListener('pointerdown', close, { once: true }), 0);
  }

  /** Keyboard navigation and quick insertion while the rail has focus. */
  private bindKeys(): void {
    this.host.tabIndex = 0;
    this.host.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // Suppress the focused button's synthetic click: Return inserts once.
        e.preventDefault();
        e.stopPropagation();
        this.addSlide();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // When the rail or its active thumbnail owns focus, either deletion
        // key is a slide command. Stop it here so the window-level shortcut
        // cannot also delete a selected canvas object.
        e.preventDefault();
        e.stopPropagation();
        this.deleteSlide();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation();
      const { slideIndex, deck } = this.store.get();
      // Arrow keys walk visible slides only: hidden slides (and collapsed
      // runs of them) are skipped, never revealed. Clicking is the only way
      // to select a hidden slide.
      const step = e.key === 'ArrowDown' ? 1 : -1;
      let next = slideIndex + step;
      while (next >= 0 && next < deck.slides.length && deck.slides[next].skipped) next += step;
      if (next < 0 || next >= deck.slides.length) return;
      this.store.selectSlide(next);
    });
  }

  /**
   * A compact "Slide N" chip standing in for the dragged row. It has to be in
   * the document and rendered when setDragImage runs, so it lives off-screen
   * until dragend.
   */
  private makeDragImage(index: number): HTMLElement {
    this.clearDragImage();
    const chip = document.createElement('div');
    chip.className = 'rail-drag-image';
    chip.textContent = `Slide ${index + 1}`;
    document.body.appendChild(chip);
    this.dragImage = chip;
    return chip;
  }

  private clearDragImage(): void {
    this.dragImage?.remove();
    this.dragImage = null;
  }

  /**
   * Drag a slide onto another to reorder.
   *
   * Uses native HTML drag-and-drop rather than pointer events: the rail is a
   * list, the drop target is a whole row, and the browser's own drop indicator
   * and auto-scrolling come free.
   */
  private bindReorder(item: HTMLElement, index: number): void {
    item.addEventListener('dragstart', (e) => {
      this.dragFrom = index;
      e.dataTransfer?.setData('text/plain', String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      // Chromium's default drag image for a row whose thumbnail is a
      // transform-scaled full-size slide surface ends up being a snapshot of
      // the whole window, so the entire UI appeared to follow the cursor in
      // the browser client. A small explicit drag image avoids the snapshot.
      if (e.dataTransfer) e.dataTransfer.setDragImage(this.makeDragImage(index), 12, 10);
      item.classList.add('dragging');
    });

    item.addEventListener('dragend', () => {
      this.dragFrom = null;
      this.clearDragImage();
      this.render();
    });

    item.addEventListener('dragover', (e) => {
      if (this.dragFrom === null || this.dragFrom === index) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      // Which half of the row the pointer is in decides whether the slide
      // lands before or after it.
      const r = item.getBoundingClientRect();
      item.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
      item.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drop-before', 'drop-after');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this.dragFrom;
      item.classList.remove('drop-before', 'drop-after');
      if (from === null || from === index) return;

      const r = item.getBoundingClientRect();
      const after = e.clientY >= r.top + r.height / 2;
      let to = after ? index + 1 : index;
      // Removing the dragged slide first shifts every later index down by one.
      if (from < to) to -= 1;

      this.dragFrom = null;
      if (to === from) return;

      this.store.commit((deck) => {
        const [moved] = deck.slides.splice(from, 1);
        deck.slides.splice(to, 0, moved);
      });
      this.store.selectSlide(to);
    });
  }

  /** Open the comments popover for a slide; edits commit like any other. */
  private openComments(slideId: string, index: number, anchor: DOMRect): void {
    const current = () =>
      this.store.get().deck.slides.find((s) => s.id === slideId)?.comments ?? [];
    const mutate = (label: string, fn: (slide: Slide) => void) => {
      this.store.commit((deck) => {
        const slide = deck.slides.find((s) => s.id === slideId);
        if (slide) fn(slide);
      }, { label });
      pop.refresh(current());
    };
    const pop = openCommentsPopover({
      anchor,
      title: `Comments — slide ${index + 1}`,
      comments: current(),
      onAdd: (text) => mutate('Add comment', (slide) => {
        (slide.comments ??= []).push(newComment(text));
      }),
      onResolve: (id, resolved) => mutate(resolved ? 'Resolve comment' : 'Reopen comment', (slide) => {
        const comment = slide.comments?.find((c) => c.id === id);
        if (comment) comment.resolved = resolved;
      }),
      onDelete: (id) => mutate('Delete comment', (slide) => {
        slide.comments = (slide.comments ?? []).filter((c) => c.id !== id);
        if (slide.comments.length === 0) delete slide.comments;
      }),
    });
  }

  addSlide(): void {
    const at = this.store.get().slideIndex + 1;
    this.store.commit((deck) => {
      const slide = {
        id: makeId('slide'),
        name: '',
        background: { color: null, image: null },
        notes: '',
        elements: [],
        timeline: [],
      };
      deck.slides.splice(at, 0, slide);
      applySlideLayout(slide, 'standard');
    }, { label: 'Add slide' });
    this.store.selectSlide(at);
  }

  duplicateSlide(): void {
    const { slideIndex } = this.store.get();
    this.store.commit((deck) => {
      const source = deck.slides[slideIndex];
      if (!source) return;
      const copy = structuredClone(source);
      copy.id = makeId('slide');
      copy.name = source.name ? `${source.name} copy` : '';
      // Fresh ids, or the duplicate's timeline would drive the original's
      // elements as well.
      const remap = new Map<string, string>();
      for (const el of copy.elements) {
        // Preserve ancestry independently from the fresh deck id. Auto-pair
        // can then recognize an edited duplicate without animating it until
        // the author explicitly asks for suggestions.
        el.lineageId = el.lineageId ?? el.id;
        const id = makeId(el.type);
        remap.set(el.id, id);
        el.id = id;
        // A duplicated slide starts with no Magic Move decisions. Auto-pair is
        // available in the dedicated panel when that is what the author wants.
        el.magicMoveId = null;
      }
      copy.magicMoveFromPrevious = false;
      for (const entry of copy.timeline) {
        entry.id = makeId('t');
        entry.action.target = remap.get(entry.action.target) ?? entry.action.target;
        if (entry.trigger.ref) {
          entry.trigger.ref = remap.get(entry.trigger.ref) ?? entry.trigger.ref;
        }
      }
      deck.slides.splice(slideIndex + 1, 0, copy);
    });
    this.store.selectSlide(slideIndex + 1);
  }

  /**
   * Toggle "skipped" for every slide selected in the rail.
   *
   * Hidden slides stay in the deck and remain editable; the player steps over
   * them when presenting. The current slide decides the direction, so a mixed
   * selection lands in one consistent state rather than inverting each slide.
   */
  toggleHidden(): void {
    const { deck, slideIndex, slideSelection } = this.store.get();
    const current = deck.slides[slideIndex];
    if (!current) return;
    const hide = !current.skipped;
    const ids = new Set(
      deck.slides.filter((s) => slideSelection.has(s.id)).map((s) => s.id),
    );
    if (ids.size === 0) ids.add(current.id);
    this.store.commit((d) => {
      for (const slide of d.slides) {
        if (ids.has(slide.id)) slide.skipped = hide ? true : undefined;
      }
    }, { label: hide ? 'Hide slide' : 'Show slide' });
  }

  /**
   * Delete every slide selected in the rail, not just the current one.
   *
   * A Shift-click range is a single unit as far as the user is concerned, so
   * deleting it is one undo entry. A deck must keep at least one slide, so a
   * selection covering the whole deck is refused rather than half-applied.
   */
  deleteSlide(): void {
    const { deck, slideIndex, slideSelection } = this.store.get();
    const doomed = deck.slides
      .map((slide, index) => ({ slide, index }))
      .filter(({ slide }) => slideSelection.has(slide.id));
    if (doomed.length === 0 || doomed.length >= deck.slides.length) return;

    const ids = new Set(doomed.map(({ slide }) => slide.id));
    const first = Math.min(...doomed.map(({ index }) => index), slideIndex);
    this.store.commit((d) => {
      d.slides = d.slides.filter((slide) => !ids.has(slide.id));
    }, { label: ids.size === 1 ? 'Delete slide' : `Delete ${ids.size} slides` });
    this.store.selectSlide(Math.max(0, first - 1));
  }
}

function railButton(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
