import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import {
  type Cursor,
  type SlideState,
  applyAction,
  groupIntoSteps,
  nextCursor,
  prevCursor,
  resolveState,
  stepCount,
} from '@shared/timeline.js';
import { applyStageScale, renderSlide } from './render.js';
import { explicitMagicMovePairs, unchangedMagicMovePairs } from '@shared/magicMove.js';

/**
 * The runtime that owns navigation and turns timeline entries into DOM and
 * media effects. Shared by the editor preview, the present window and exports.
 *
 * Two paths reach the same place by design:
 *  - jumping (arrow back, opening mid-deck) replays `resolveState` with delays
 *    collapsed, so the state is correct instantly;
 *  - stepping forward schedules the same actions honouring `delay` and
 *    `mediaEnd`, so builds animate the way they were authored.
 */
export interface PlayerOptions {
  deck: Deck;
  container: HTMLElement;
  resolveSrc: (src: string) => string;
  /** Notified on every cursor change, for slide counters and the editor rail. */
  onCursor?: (cursor: Cursor, steps: number) => void;
}

export class Player {
  private deck: Deck;
  private container: HTMLElement;
  private resolveSrc: (src: string) => string;
  private onCursor?: (cursor: Cursor, steps: number) => void;

  private stage: HTMLElement;
  private cursor: Cursor = { slide: 0, step: 0 };
  private blanked = false;

  /** Timers and media listeners owned by the current step, cleared on any move. */
  private pending: ReturnType<typeof setTimeout>[] = [];
  private mediaListeners: Array<() => void> = [];
  /** Videos already given a trim watcher, so listeners are not stacked. */
  private trimmed = new Set<string>();
  private resizeObserver: ResizeObserver;

  constructor(opts: PlayerOptions) {
    this.deck = opts.deck;
    this.container = opts.container;
    this.resolveSrc = opts.resolveSrc;
    this.onCursor = opts.onCursor;

    this.container.classList.add('player-root');
    this.stage = document.createElement('div');
    this.stage.className = 'stage';
    this.container.replaceChildren(this.stage);

    this.resizeObserver = new ResizeObserver(() => this.rescale());
    this.resizeObserver.observe(this.container);

    this.goTo({ slide: 0, step: 0 });
  }

  destroy(): void {
    this.clearPending();
    this.resizeObserver.disconnect();
    this.container.replaceChildren();
  }

  getCursor(): Cursor {
    return { ...this.cursor };
  }

  /** Swap in a new deck, keeping the cursor where it still makes sense. */
  setDeck(deck: Deck): void {
    this.deck = deck;
    const slide = Math.min(this.cursor.slide, Math.max(0, deck.slides.length - 1));
    const steps = deck.slides[slide] ? stepCount(deck.slides[slide]) : 1;
    this.goTo({ slide, step: Math.min(this.cursor.step, steps - 1) });
  }

  next(): void {
    const target = nextCursor(this.deck.slides, this.cursor);
    if (target.slide === this.cursor.slide && target.step === this.cursor.step) return;
    // Advancing within a slide plays the new step's build; changing slide is a
    // fresh render.
    if (target.slide === this.cursor.slide) this.advanceStep(target.step);
    else this.goTo(target);
  }

  prev(): void {
    const target = prevCursor(this.deck.slides, this.cursor);
    if (target.slide === this.cursor.slide && target.step === this.cursor.step) return;
    this.goTo(target);
  }

  goToSlide(index: number): void {
    this.goTo({ slide: index, step: 0 });
  }

  /** Full render of a slide at a given step, with the state resolved instantly. */
  goTo(cursor: Cursor): void {
    this.clearPending();
    const slides = this.deck.slides;
    if (slides.length === 0) {
      this.stage.replaceChildren();
      return;
    }
    const previousSlideIndex = this.cursor.slide;
    const slide = slides[Math.min(Math.max(cursor.slide, 0), slides.length - 1)];
    const previousSlide = slides[previousSlideIndex];
    const explicitPairs = previousSlide
      ? explicitMagicMovePairs(previousSlide.elements, slide.elements)
      : [];
    const magicMoveEnabled = slide.magicMoveFromPrevious ?? explicitPairs.length > 0;
    const magicMove = previousSlideIndex !== slides.indexOf(slide) && previousSlide && magicMoveEnabled;
    const steps = stepCount(slide);
    this.cursor = {
      slide: slides.indexOf(slide),
      step: Math.min(Math.max(cursor.step, 0), steps - 1),
    };

    // A video that appears on consecutive slides (Keynote's "plays across
    // slides") must continue, not restart: capture playback positions by
    // source before tearing the old slide down, and hand them to any matching
    // video on the new one.
    const carry = new Map<string, number>();
    for (const video of this.stage.querySelectorAll('video')) {
      if (!video.paused && video.currentTime > 0) {
        carry.set(video.getAttribute('src') ?? '', video.currentTime);
      }
    }
    const previousNodes = new Map<string, HTMLElement>();
    if (magicMove) {
      for (const node of this.stage.querySelectorAll<HTMLElement>('[data-element-id]')) {
        const id = node.dataset.elementId;
        if (id && node.style.visibility !== 'hidden') {
          previousNodes.set(id, node.cloneNode(true) as HTMLElement);
        }
      }
    }

    const rendered = renderSlide(slide, { resolveSrc: this.resolveSrc });
    this.stage.replaceChildren(rendered);

    for (const video of this.stage.querySelectorAll('video')) {
      const from = carry.get(video.getAttribute('src') ?? '');
      if (from === undefined) continue;
      const resume = () => {
        video.currentTime = from;
      };
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) resume();
      else video.addEventListener('loadedmetadata', resume, { once: true });
    }

    this.rescale();

    this.applyState(slide, resolveState(slide, this.cursor.step));
    if (magicMove && previousSlide) this.runMagicMove(previousSlide, slide, previousNodes);
    this.onCursor?.(this.getCursor(), steps);
  }

  private runMagicMove(
    previous: Slide,
    next: Slide,
    previousNodes: Map<string, HTMLElement>,
  ): void {
    const duration = this.deck.magicMoveDuration;
    const easing = 'cubic-bezier(.2,.8,.2,1)';
    const pairs = matchMagicMoveElements(previous.elements, next.elements);
    const pairedSources = new Set(pairs.map(([source]) => source.id));
    const pairedTargets = new Set(pairs.map(([, target]) => target.id));
    const unchanged = unchangedMagicMovePairs(
      previous.elements.filter((element) => !pairedSources.has(element.id)),
      next.elements.filter((element) => !pairedTargets.has(element.id)),
    );
    for (const [source, target] of unchanged) {
      pairedSources.add(source.id);
      pairedTargets.add(target.id);
    }
    for (const [from, to] of pairs) {
      const node = this.stage.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(to.id)}"]`,
      );
      if (!node?.animate) continue;
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      const sx = from.w / to.w;
      const sy = from.h / to.h;
      const finalTransform = to.style.transform ?? (to.rot ? `rotate(${to.rot}deg)` : 'none');
      node.animate([
        {
          transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})${from.rot ? ` rotate(${from.rot}deg)` : ''}`,
          transformOrigin: 'top left',
          opacity: String(from.opacity),
        },
        { transform: finalTransform, transformOrigin: 'top left', opacity: String(to.opacity) },
      ], { duration, easing, fill: 'none' });
    }

    // Changed, unpaired objects switch discretely at the midpoint. Opacity
    // fades made dense arrow diagrams look staggered under easing even though
    // every animation had the same duration.
    for (const target of next.elements) {
      if (pairedTargets.has(target.id)) continue;
      const node = this.stage.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(target.id)}"]`,
      );
      if (!node?.animate || node.style.visibility === 'hidden') continue;
      node.animate([
        { visibility: 'hidden', offset: 0 },
        { visibility: 'hidden', offset: 0.499 },
        { visibility: 'visible', offset: 0.5 },
        { visibility: 'visible', offset: 1 },
      ], { duration, easing: 'linear', fill: 'none' });
    }

    // Removed, unpaired source objects no longer exist in the target render.
    // Animate exact clones of the visible old DOM, then remove them so the
    // settled stage remains byte-for-byte the target slide.
    const targetSlide = this.stage.querySelector<HTMLElement>('.slide');
    if (!targetSlide) return;
    for (const source of previous.elements) {
      if (pairedSources.has(source.id)) continue;
      const ghost = previousNodes.get(source.id);
      if (!ghost) continue;
      ghost.classList.add('magic-move-ghost');
      ghost.dataset.magicMoveSourceId = source.id;
      delete ghost.dataset.elementId;
      ghost.style.pointerEvents = 'none';
      ghost.style.visibility = 'visible';
      targetSlide.appendChild(ghost);
      if (!ghost.animate) {
        ghost.remove();
        continue;
      }
      const animation = ghost.animate([
        { visibility: 'visible', offset: 0 },
        { visibility: 'visible', offset: 0.499 },
        { visibility: 'hidden', offset: 0.5 },
        { visibility: 'hidden', offset: 1 },
      ], { duration, easing: 'linear', fill: 'forwards' });
      void animation.finished.then(() => ghost.remove(), () => ghost.remove());
    }
  }

  /**
   * Run the entries belonging to `step` against the DOM already on screen,
   * honouring delays and media-end chaining so builds play as authored.
   */
  private advanceStep(step: number): void {
    this.clearPending();
    const slide = this.deck.slides[this.cursor.slide];
    this.cursor = { slide: this.cursor.slide, step };

    const entries = groupIntoSteps(slide)[step] ?? [];
    // State is tracked incrementally so each action lands on top of what the
    // previous ones did, matching what `resolveState` would produce.
    const state = resolveState(slide, step - 1);

    let cumulativeDelay = 0;
    for (const entry of entries) {
      const run = () => {
        applyAction(state, entry, slide);
        this.applyState(slide, state);
      };

      if (entry.trigger.on === 'mediaEnd' && entry.trigger.ref) {
        this.onMediaEnd(entry.trigger.ref, () => {
          if (entry.trigger.delay > 0) this.later(run, entry.trigger.delay);
          else run();
        });
        continue;
      }

      // `click` opens the step and `afterPrev` chains from the previous entry;
      // `withPrev` fires alongside it, so only the chaining forms accumulate.
      if (entry.trigger.on === 'afterPrev') cumulativeDelay += entry.trigger.delay;
      else if (entry.trigger.on === 'withPrev') {
        // keep cumulativeDelay as-is: fire together with the previous action
      } else cumulativeDelay = entry.trigger.delay;

      if (cumulativeDelay > 0) this.later(run, cumulativeDelay);
      else run();
    }

    this.onCursor?.(this.getCursor(), stepCount(slide));
  }

  /** Reconcile the DOM and media playback with a computed slide state. */
  private applyState(slide: Slide, state: SlideState): void {
    for (const el of slide.elements) {
      const node = this.stage.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(el.id)}"]`,
      );
      if (!node) continue;

      const visible = state.visible.has(el.id);
      node.style.visibility = visible ? 'visible' : 'hidden';
      // Hidden elements must not swallow clicks in the editor preview.
      node.style.pointerEvents = visible ? '' : 'none';

      const extra = state.classes.get(el.id);
      if (extra) {
        const base = ['element', `element-${el.type}`, ...el.class];
        node.className = [...base, ...extra].join(' ');
      }

      if (el.type !== 'video') continue;
      const video = node.querySelector('video');
      if (!video) continue;

      const seek = state.seeks.get(el.id);
      if (seek !== undefined && Math.abs(video.currentTime - seek) > 0.05) {
        video.currentTime = seek;
      }

      this.enforceTrim(el, video);

      if (state.playing.has(el.id) && visible && !this.blanked) {
        // A rejected play() is normal (autoplay policy, or the element being
        // torn down mid-promise) and must not break the rest of the build.
        void video.play().catch(() => {});
      } else if (!video.paused) {
        video.pause();
      }
    }
  }

  /**
   * Keep a video inside its trim window.
   *
   * Trimming is non-destructive — the file still holds the whole clip — so the
   * in and out points have to be enforced during playback. The native `loop`
   * attribute cannot do this: it always restarts at zero, which would replay
   * the material the trim was meant to remove. A trimmed clip therefore loops
   * back to `start` here instead.
   */
  private enforceTrim(
    el: Extract<Slide['elements'][number], { type: 'video' }>,
    video: HTMLVideoElement,
  ): void {
    if (this.trimmed.has(el.id)) return;
    const hasTrim = el.start > 0 || el.end !== null;
    if (!hasTrim) return;
    this.trimmed.add(el.id);

    const onTime = () => {
      const end = el.end ?? Number.POSITIVE_INFINITY;
      if (video.currentTime >= end - 0.03) {
        if (el.loop) {
          video.currentTime = el.start;
          void video.play().catch(() => {});
        } else {
          video.pause();
          // Hold on the last kept frame rather than the file's final frame.
          video.currentTime = Math.max(el.start, end - 0.03);
        }
      } else if (video.currentTime < el.start - 0.05) {
        video.currentTime = el.start;
      }
    };

    video.addEventListener('timeupdate', onTime);
    this.mediaListeners.push(() => video.removeEventListener('timeupdate', onTime));
  }

  /** Watch a video element for its `ended` event, once, for `mediaEnd` triggers. */
  private onMediaEnd(elementId: string, fn: () => void): void {
    const node = this.stage.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const video = node?.querySelector('video');
    if (!video) return;
    // A looping video never fires `ended`, so a mediaEnd trigger on one would
    // hang the build. Fall through immediately instead of stalling the talk.
    if (video.loop) {
      fn();
      return;
    }
    const handler = () => fn();
    video.addEventListener('ended', handler, { once: true });
    this.mediaListeners.push(() => video.removeEventListener('ended', handler));
  }

  private later(fn: () => void, ms: number): void {
    this.pending.push(setTimeout(fn, ms));
  }

  private clearPending(): void {
    for (const t of this.pending) clearTimeout(t);
    this.pending = [];
    for (const off of this.mediaListeners) off();
    this.mediaListeners = [];
    // The listeners those ids refer to have just been removed, so a fresh
    // watcher must be attached when the slide is drawn again.
    this.trimmed.clear();
  }

  /** Blank the screen (the `B` key) without losing position. */
  toggleBlank(): boolean {
    this.blanked = !this.blanked;
    this.stage.style.visibility = this.blanked ? 'hidden' : 'visible';
    for (const video of this.stage.querySelectorAll('video')) {
      if (this.blanked) video.pause();
    }
    if (!this.blanked) {
      const slide = this.deck.slides[this.cursor.slide];
      if (slide) this.applyState(slide, resolveState(slide, this.cursor.step));
    }
    return this.blanked;
  }

  private rescale(): void {
    const r = this.container.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    applyStageScale(this.stage, this.deck, { w: r.width, h: r.height });
  }
}

/** Backwards-compatible export for tests and callers; runtime matching is explicit only. */
export function matchMagicMoveElements(
  previous: SlideElement[],
  next: SlideElement[],
): Array<[SlideElement, SlideElement]> {
  return explicitMagicMovePairs(previous, next);
}
