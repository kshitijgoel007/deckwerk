import type { Slide } from './deck.js';
import { stepCount } from './timeline.js';
import type { PdfBuildMode } from './ipc.js';

/** Distinct player states that become PDF pages for one slide. */
export function pdfSteps(slide: Slide, mode: PdfBuildMode): number[] {
  if (mode === 'initial') return [0];
  if (mode === 'final') return [stepCount(slide) - 1];
  return Array.from({ length: stepCount(slide) }, (_, index) => index);
}

export function pdfPageCount(slides: Slide[], mode: PdfBuildMode, includeHidden = false): number {
  return slides
    .filter((slide) => includeHidden || !slide.skipped)
    .reduce((count, slide) => count + pdfSteps(slide, mode).length, 0);
}
