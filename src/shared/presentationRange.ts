import type { Slide } from './deck.js';
import { type Cursor, nextCursor, prevCursor } from './timeline.js';

/** Inclusive deck indexes for a presentation limited to a rail selection. */
export interface PresentationRange {
  start: number;
  end: number;
}

/**
 * A single selected slide keeps the usual "start here, then present the deck"
 * behaviour. Two or more selected slides instead define a bounded run.
 */
export function rangeForSlideSelection(
  slides: Slide[],
  selectedSlideIds: ReadonlySet<string>,
): PresentationRange | null {
  if (selectedSlideIds.size < 2) return null;
  const indexes = slides
    .map((slide, index) => selectedSlideIds.has(slide.id) ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length < 2) return null;
  return { start: indexes[0], end: indexes[indexes.length - 1] };
}

/** True when advancing would leave the inclusive range (or the deck). */
export function nextLeavesPresentationRange(
  slides: Slide[],
  cursor: Cursor,
  range: PresentationRange,
): boolean {
  const target = nextCursor(slides, cursor);
  return target.slide > range.end
    || (target.slide === cursor.slide && target.step === cursor.step);
}

/** True when going back would leave the inclusive range (or the deck). */
export function prevLeavesPresentationRange(
  slides: Slide[],
  cursor: Cursor,
  range: PresentationRange,
): boolean {
  const target = prevCursor(slides, cursor);
  return target.slide < range.start
    || (target.slide === cursor.slide && target.step === cursor.step);
}
