import { makeId } from '@shared/geometry.js';
import { renderSlide } from '../player/render.js';
import { applySlideLayout } from './slideLayouts.js';
import type { EditorStore } from './store.js';

/**
 * The slide list. Text-first rather than thumbnail-first: rendering live
 * thumbnails of video-heavy slides would mean decoding every clip in the deck
 * at once, which is exactly the cost this tool exists to avoid.
 */
/** Rendered width of a slide thumbnail, in CSS pixels. */
const THUMB_WIDTH = 168;

export class SlideRail {
  private host: HTMLElement;
  private store: EditorStore;
  /** Index of the slide being dragged, while a reorder is in progress. */
  private dragFrom: number | null = null;
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

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.store = store;
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
    if (deck.slides === this.renderedSlides) {
      this.highlight(slideIndex, slideSelection);
      return;
    }
    this.render();
  }

  private highlight(slideIndex: number, slideSelection: Set<string>): void {
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
    // Drop cache entries for slides that no longer exist in this deck version.
    const live = new Set<unknown>(deck.slides);
    for (const key of this.thumbCache.keys()) {
      if (!live.has(key)) this.thumbCache.delete(key);
    }
    this.host.replaceChildren();

    deck.slides.forEach((slide, i) => {
      const item = document.createElement('button');
      item.className = `rail-item${slideSelection.has(slide.id) ? ' selected' : ''}${i === slideIndex ? ' active' : ''}`;
      item.setAttribute('aria-selected', String(slideSelection.has(slide.id)));
      item.draggable = true;
      item.dataset.index = String(i);
      this.bindReorder(item, i);

      const num = document.createElement('span');
      num.className = 'rail-num';
      num.textContent = String(i + 1);

      // A real miniature, cached by slide identity so untouched slides keep
      // their live DOM (and their already-decoded video frames) across edits.
      let thumb = this.thumbCache.get(slide);
      if (!thumb) {
        thumb = document.createElement('div');
        thumb.className = 'rail-thumb';
        const inner = document.createElement('div');
        inner.className = 'rail-thumb-inner';
        inner.style.width = `${deck.canvas.w}px`;
        inner.style.height = `${deck.canvas.h}px`;
        inner.style.transform = `scale(${THUMB_WIDTH / deck.canvas.w})`;
        if (slide.background.color) inner.style.background = slide.background.color;
        inner.appendChild(
          renderSlide(slide, { resolveSrc: (src) => window.api.assetUrl(src) }),
        );
        for (const video of inner.querySelectorAll('video')) {
          video.removeAttribute('autoplay');
          // Decode one frame so the thumbnail shows a picture, then hold.
          video.preload = 'auto';
          video.pause();
        }
        thumb.appendChild(inner);
        this.thumbCache.set(slide, thumb);
      }

      item.append(num, thumb);
      item.addEventListener('click', (event) => {
        this.store.selectSlide(i, event.shiftKey);
        // Picking slides makes the rail the active surface, so Backspace is a
        // slide command from here on. Without this the keystroke reaches the
        // window handler, which only knows about canvas objects, and selecting
        // slides then pressing Backspace appears to do nothing at all.
        this.host.focus({ preventScroll: true });
      });
      this.host.appendChild(item);
    });

    const actions = document.createElement('div');
    actions.className = 'rail-actions';
    actions.append(
      railButton('+ Slide', () => this.addSlide()),
      railButton('Duplicate', () => this.duplicateSlide()),
      railButton('Delete', () => this.deleteSlide()),
    );
    this.host.appendChild(actions);
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
      if (e.key === 'Backspace') {
        // When the rail or its active thumbnail owns focus, Backspace is a
        // slide command. Stop it here so the window-level shortcut cannot also
        // delete a selected canvas object.
        e.preventDefault();
        e.stopPropagation();
        this.deleteSlide();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation();
      const { slideIndex, deck } = this.store.get();
      const next = e.key === 'ArrowDown' ? slideIndex + 1 : slideIndex - 1;
      if (next < 0 || next >= deck.slides.length) return;
      this.store.selectSlide(next);
    });
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
      item.classList.add('dragging');
    });

    item.addEventListener('dragend', () => {
      this.dragFrom = null;
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
