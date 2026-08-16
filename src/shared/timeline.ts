import type { Slide, SlideElement, TimelineEntry } from './deck.js';

/**
 * Pure timeline reasoning, kept free of the DOM so it can be unit tested and
 * reused by both the player and the editor's timeline panel.
 *
 * A slide is a sequence of *steps*. Step 0 is the state on slide entry; each
 * timeline entry with an `on: "click"` trigger starts a new step. Entries with
 * any other trigger belong to the step opened by the most recent click entry
 * (or to step 0 if they precede every click).
 */

/** Timeline entries grouped by the step they belong to. Always length >= 1. */
export function groupIntoSteps(slide: Slide): TimelineEntry[][] {
  const steps: TimelineEntry[][] = [[]];
  for (const entry of slide.timeline) {
    if (entry.trigger.on === 'click') steps.push([entry]);
    else steps[steps.length - 1].push(entry);
  }
  return steps;
}

/** Number of distinct states this slide advances through, minimum 1. */
export function stepCount(slide: Slide): number {
  return groupIntoSteps(slide).length;
}

/**
 * Which elements are visible before any step has run.
 *
 * An element starts hidden only if the first visibility action targeting it is
 * an `appear`; otherwise it is on screen from slide entry. That rule is what
 * makes "no timeline at all" mean "everything visible", so the common case
 * needs no authoring.
 */
export function initiallyHidden(slide: Slide): Set<string> {
  const hidden = new Set<string>();
  const decided = new Set<string>();
  for (const { action } of slide.timeline) {
    if (action.type !== 'appear' && action.type !== 'disappear') continue;
    if (decided.has(action.target)) continue;
    decided.add(action.target);
    if (action.type === 'appear') hidden.add(action.target);
  }
  return hidden;
}

export interface SlideState {
  /** Ids of elements that should be in the DOM and visible. */
  visible: Set<string>;
  /** Ids of video elements that should be playing. */
  playing: Set<string>;
  /** Extra CSS classes applied by `addClass`/`removeClass` actions. */
  classes: Map<string, Set<string>>;
  /** Seek positions in seconds requested by `seek` actions. */
  seeks: Map<string, number>;
}

/**
 * The state a slide should be in at `step`, computed by replaying every entry
 * from step 0 up to and including `step` with delays collapsed to zero.
 *
 * This is the authority for *jumping* — restoring a slide when you arrow
 * backwards or reopen the deck mid-talk. Live forward playback uses the same
 * actions but honours `delay` and `mediaEnd`, so the two agree on the endpoint.
 */
export function resolveState(slide: Slide, step: number): SlideState {
  const hidden = initiallyHidden(slide);
  const state: SlideState = {
    visible: new Set(
      slide.elements.filter((e) => !hidden.has(e.id)).map((e) => e.id),
    ),
    playing: new Set(
      slide.elements
        .filter((e) => e.type === 'video' && e.autoplay && !hidden.has(e.id))
        .map((e) => e.id),
    ),
    classes: new Map(),
    seeks: new Map(),
  };

  const steps = groupIntoSteps(slide);
  const last = Math.min(step, steps.length - 1);
  for (let i = 0; i <= last; i++) {
    for (const entry of steps[i]) applyAction(state, entry, slide);
  }
  return state;
}

/** Fold a single timeline entry's action into a mutable state. */
export function applyAction(
  state: SlideState,
  entry: TimelineEntry,
  slide: Slide,
): void {
  const { type, target, value } = entry.action;
  switch (type) {
    case 'appear': {
      state.visible.add(target);
      // Revealing a video that wants to autoplay also starts it, so the common
      // "click to reveal a demo clip" case needs one entry rather than two.
      const el = findElement(slide, target);
      if (el?.type === 'video' && el.autoplay) state.playing.add(target);
      break;
    }
    case 'disappear':
      state.visible.delete(target);
      state.playing.delete(target);
      break;
    case 'play':
      state.playing.add(target);
      break;
    case 'pause':
      state.playing.delete(target);
      break;
    case 'seek':
      if (typeof value === 'number') state.seeks.set(target, value);
      break;
    case 'addClass':
      if (typeof value === 'string') classSet(state, target).add(value);
      break;
    case 'removeClass':
      if (typeof value === 'string') classSet(state, target).delete(value);
      break;
  }
}

function classSet(state: SlideState, target: string): Set<string> {
  let set = state.classes.get(target);
  if (!set) {
    set = new Set();
    state.classes.set(target, set);
  }
  return set;
}

export function findElement(
  slide: Slide,
  id: string,
): SlideElement | undefined {
  return slide.elements.find((e) => e.id === id);
}

/** Absolute (slide, step) position, used for deck-wide navigation. */
export interface Cursor {
  slide: number;
  step: number;
}

/** Advance one step, rolling onto the next slide at the end. Clamps at the end of the deck. */
export function nextCursor(slides: Slide[], cur: Cursor): Cursor {
  const slide = slides[cur.slide];
  if (slide && cur.step < stepCount(slide) - 1) {
    return { slide: cur.slide, step: cur.step + 1 };
  }
  if (cur.slide < slides.length - 1) return { slide: cur.slide + 1, step: 0 };
  return cur;
}

/**
 * Go back one step, rolling onto the *last* step of the previous slide so that
 * stepping backwards over a slide boundary restores the fully-built state
 * rather than resetting it.
 */
export function prevCursor(slides: Slide[], cur: Cursor): Cursor {
  if (cur.step > 0) return { slide: cur.slide, step: cur.step - 1 };
  if (cur.slide > 0) {
    const prev = slides[cur.slide - 1];
    return { slide: cur.slide - 1, step: stepCount(prev) - 1 };
  }
  return cur;
}
