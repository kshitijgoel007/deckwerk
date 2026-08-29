import type { Deck, Slide } from '@shared/deck.js';
import {
  defaultLayoutMasters,
  syncSlideWithLayoutMaster,
  type FixedLayout,
} from '@shared/layoutMasters.js';

export type SlideLayout = FixedLayout;

/** Apply layout geometry without consulting or mutating the installed theme. */
export function applySlideLayout(
  slide: Slide,
  layout: SlideLayout,
  masters: Deck['layoutMasters'] = null,
): void {
  const master = masters?.[layout] ?? defaultLayoutMasters()[layout];
  syncSlideWithLayoutMaster(slide, layout, master, { forceBackground: Boolean(masters) });
}

export const LAYOUT_LABELS: Array<[SlideLayout, string]> = [
  ['freeform', 'Freeform'],
  ['standard', 'Title + body'],
  ['title', 'Title slide'],
];
