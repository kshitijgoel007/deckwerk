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
import { applyStageScale, fitAutoTextElement, renderSlide } from './render.js';
import { applyParagraphVisibility } from '@shared/paragraphs.js';
import { essentialMagicMovePairs, explicitMagicMovePairs, unchangedMagicMovePairs } from '@shared/magicMove.js';

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
    // slides") must continue, not restart: keep the playing element itself and
    // adopt it into the new slide. A freshly created element — even seeked to
    // the same position — paints nothing until its decoder produces a frame,
    // which shows as a white flash at the slide switch. The live element keeps
    // its decoded frame, so the picture never drops out.
    const carry = new Map<string, HTMLVideoElement>();
    for (const video of this.stage.querySelectorAll('video')) {
      if (!video.paused && video.currentTime > 0) {
        carry.set(video.getAttribute('src') ?? '', video);
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
      const live = carry.get(video.getAttribute('src') ?? '');
      if (!live || live === video) continue;
      // The rendered element carries the new slide's presentation (crop
      // offsets, fit, trim-aware loop flag); move all of it onto the live
      // element before it takes the rendered one's place.
      live.style.cssText = video.style.cssText;
      live.loop = video.loop;
      live.muted = video.muted;
      live.controls = video.controls;
      video.replaceWith(live);
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
    // The named curves map to beziers chosen for object motion, not the CSS
    // keywords of the same name: 'ease-out' front-loads the motion (snappy
    // arrival), while the default symmetric ease-in-out keeps mid-transition
    // speed high so paths don't crawl toward the end.
    const easing = {
      'ease-in-out': 'cubic-bezier(.45,.05,.55,.95)',
      'ease-out': 'cubic-bezier(.2,.8,.2,1)',
      linear: 'linear',
    }[this.deck.magicMoveEasing];
    const targetSlide = this.stage.querySelector<HTMLElement>('.slide');
    if (!targetSlide) return;
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
    // Near-identical leftovers (same object up to a few pixels of drift, as
    // imports routinely produce) glide the tiny delta as ordinary movers
    // instead of fading out and back in as two objects.
    const essential = essentialMagicMovePairs(
      previous.elements.filter((element) => !pairedSources.has(element.id)),
      next.elements.filter((element) => !pairedTargets.has(element.id)),
    );
    for (const pair of essential) {
      pairs.push(pair);
      pairedSources.add(pair[0].id);
      pairedTargets.add(pair[1].id);
    }

    // Stacking during the transition. Paint order is normally DOM order (the
    // slide renders its elements z-sorted), but ghosts have to be appended
    // last, which would paint every removed object — a near-opaque backdrop
    // included — over objects it sat *below* on the source slide. So while the
    // transition runs, each participant carries an explicit z-index: the
    // source slide's z rank for the first half, the target's DOM rank for the
    // second, switching discretely at the same midpoint as the content. The
    // keyframes use fill 'none', so the settled stage keeps no trace of it.
    const sourceRank = new Map(
      [...previous.elements].sort((a, b) => a.z - b.z).map((element, i) => [element.id, i]),
    );
    const domRank = new Map<string, number>();
    [...targetSlide.children].forEach((child, i) => {
      const id = (child as HTMLElement).dataset.elementId;
      if (id) domRank.set(id, i);
    });
    const sourceOf = new Map<string, string>(
      [...pairs, ...unchanged].map(([source, target]) => [target.id, source.id]),
    );
    const stackingFrames = (targetId: string): Keyframe[] | null => {
      const src = sourceRank.get(sourceOf.get(targetId) ?? '');
      const dom = domRank.get(targetId);
      if (src === undefined || dom === undefined) return null;
      return [
        { zIndex: String(src), offset: 0 },
        { zIndex: String(src), offset: 0.499 },
        { zIndex: String(dom), offset: 0.5 },
        { zIndex: String(dom), offset: 1 },
      ];
    };

    for (const [from, to] of pairs) {
      const node = this.stage.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(to.id)}"]`,
      );
      if (!node?.animate) continue;
      // The settled render rotates about the element's center (the CSS
      // default), so the animation must too: translate between centers and
      // rotate before scaling, exactly mirroring how the source slide drew
      // the box. Any other origin makes rotated elements (a thin arrow stored
      // as a 90°-rotated horizontal box, say) lurch at frame 0 and snap back
      // when the fill-none animation ends.
      let dx = from.x + from.w / 2 - (to.x + to.w / 2);
      let dy = from.y + from.h / 2 - (to.y + to.h / 2);
      const sx = from.w / to.w;
      const sy = from.h / to.h;
      let origin = 'center';
      let startTransform =
        `translate(${dx}px, ${dy}px)${from.rot ? ` rotate(${from.rot}deg)` : ''} scale(${sx}, ${sy})`;
      if (from.type === 'text' && to.type === 'text') {
        // A text box is a layout container, not the glyphs: its width can
        // change without the rendered text changing at all, and scaling by the
        // box ratio would smear the glyphs. Scale by the rendered font size
        // instead, anchored at the alignment point so the text tracks the spot
        // it is aligned to within each box.
        const scale = textFontScale(from, to, previousNodes.get(from.id), node);
        const ax = { left: 0, center: 0.5, right: 1, justify: 0 }[to.align] ?? 0;
        const ay = { top: 0, middle: 0.5, bottom: 1 }[to.valign] ?? 0;
        const axFrom = { left: 0, center: 0.5, right: 1, justify: 0 }[from.align] ?? 0;
        const ayFrom = { top: 0, middle: 0.5, bottom: 1 }[from.valign] ?? 0;
        dx = from.x + axFrom * from.w - (to.x + ax * to.w);
        dy = from.y + ayFrom * from.h - (to.y + ay * to.h);
        origin = `${ax * 100}% ${ay * 100}%`;
        startTransform =
          `translate(${dx}px, ${dy}px) scale(${scale}, ${scale})${from.rot ? ` rotate(${from.rot}deg)` : ''}`;
      }
      const finalTransform = to.style.transform ?? (to.rot ? `rotate(${to.rot}deg)` : 'none');
      const stacking = stackingFrames(to.id) ?? [];
      // The ease lives on the first keyframe, not the timing options: keyframe
      // easing applies per property segment, so the motion still eases across
      // the whole duration while the stacking offsets below stay in wall time,
      // flipping at the same real midpoint as every discrete switch.
      node.animate([
        {
          transform: startTransform,
          transformOrigin: origin,
          opacity: String(from.opacity),
          offset: 0,
          easing,
          ...(stacking.length ? { zIndex: stacking[0].zIndex } : {}),
        },
        ...stacking.slice(1, 3),
        {
          transform: finalTransform,
          transformOrigin: origin,
          opacity: String(to.opacity),
          offset: 1,
          ...(stacking.length ? { zIndex: stacking[3].zIndex } : {}),
        },
      ], { duration, easing: 'linear', fill: 'none' });
    }

    // Genuinely new objects (nothing on the source slide is even essentially
    // the same) fade in over the final quarter, after the movers have mostly
    // settled. The windows are fixed fractions of wall time and linear, so
    // dense arrow diagrams fade as one — the stagger that discrete switching
    // was introduced to avoid came from easing the fades, not from fading.
    for (const target of next.elements) {
      if (pairedTargets.has(target.id)) continue;
      const node = this.stage.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(target.id)}"]`,
      );
      if (!node?.animate || node.style.visibility === 'hidden') continue;
      const dom = domRank.get(target.id);
      const zIndex = dom === undefined ? {} : { zIndex: String(dom) };
      node.animate([
        { opacity: '0', offset: 0, ...zIndex },
        { opacity: '0', offset: 0.75, ...zIndex },
        { opacity: String(target.opacity), offset: 1, ...zIndex },
      ], { duration, easing: 'linear', fill: 'none' });
    }

    // Removed, unpaired source objects no longer exist in the target render.
    // Animate exact clones of the visible old DOM, then remove them so the
    // settled stage remains byte-for-byte the target slide.
    let hasGhosts = false;
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
      hasGhosts = true;
      // Removed objects fade out over the first quarter, clearing the stage
      // before the incoming objects' final-quarter fade begins.
      const zIndex = String(sourceRank.get(source.id) ?? 0);
      const animation = ghost.animate([
        { opacity: String(source.opacity), offset: 0, zIndex },
        { opacity: '0', offset: 0.25, zIndex },
        { opacity: '0', offset: 1, zIndex },
      ], { duration, easing: 'linear', fill: 'forwards' });
      void animation.finished.then(() => ghost.remove(), () => ghost.remove());
    }

    // Ghosts only stack correctly against the rest of the source content if
    // that content is ranked on the same scale, so visually-unchanged pairs
    // join the stacking timeline — but only when there is a ghost to order
    // against, keeping ghost-free transitions free of animations entirely.
    if (hasGhosts) {
      for (const [, target] of unchanged) {
        const node = this.stage.querySelector<HTMLElement>(
          `[data-element-id="${CSS.escape(target.id)}"]`,
        );
        const frames = stackingFrames(target.id);
        if (!node?.animate || !frames || node.style.visibility === 'hidden') continue;
        node.animate(frames, { duration, easing: 'linear', fill: 'none' });
      }
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
    applyParagraphVisibility(this.stage, state);
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

/**
 * The visual scale between two renders of a paired text element: the ratio of
 * rendered font sizes, not of box sizes. Auto-fitted text reports the size it
 * actually settled on; otherwise the authored size decides. The target is
 * fitted synchronously here because its scheduled fit only lands on the next
 * frame, after the animation has already read the geometry.
 */
function textFontScale(
  from: Extract<SlideElement, { type: 'text' }>,
  to: Extract<SlideElement, { type: 'text' }>,
  sourceClone: HTMLElement | undefined,
  targetNode: HTMLElement,
): number {
  const fitted = (root: HTMLElement | undefined): number | undefined => {
    const raw = root?.querySelector<HTMLElement>('.text-content')?.dataset.fittedFontSize;
    const value = raw ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const authored = (style: Record<string, string>): number | undefined => {
    const value = Number.parseFloat(style['font-size'] ?? '');
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const toSize = (to.autoFit || to.noWrap ? fitAutoTextElement(targetNode) ?? undefined : undefined)
    ?? fitted(targetNode) ?? authored(to.style);
  const fromSize = fitted(sourceClone) ?? authored(from.style);
  return fromSize !== undefined && toSize !== undefined && toSize > 0 ? fromSize / toSize : 1;
}

/** Backwards-compatible export for tests and callers; runtime matching is explicit only. */
export function matchMagicMoveElements(
  previous: SlideElement[],
  next: SlideElement[],
): Array<[SlideElement, SlideElement]> {
  return explicitMagicMovePairs(previous, next);
}
