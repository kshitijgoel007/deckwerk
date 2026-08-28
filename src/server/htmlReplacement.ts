import type { AgentOperation } from '../shared/agent.js';
import type { Deck, Slide } from '../shared/deck.js';

export interface HtmlReplacementPlan {
  operations: AgentOperation[];
  appliedSlideIds: string[];
}

/**
 * Replace an ordered set of target slides with any positive number of drafts.
 *
 * Paired slides retain their identity and review metadata. Extra draft slides
 * are inserted after the final target; extra targets are deleted. The caller
 * applies the returned operations as one collaboration transaction.
 */
export function planHtmlReplacement(
  deck: Deck,
  targetSlideIds: string[],
  draftSlides: Slide[],
): HtmlReplacementPlan {
  if (targetSlideIds.length === 0) throw new Error('replacement requires at least one target slide');
  if (draftSlides.length === 0) throw new Error('replacement requires at least one draft slide');
  if (new Set(targetSlideIds).size !== targetSlideIds.length) {
    throw new Error('replacement target contains duplicate slide ids');
  }

  const targets = targetSlideIds.map((id) => {
    const slide = deck.slides.find((candidate) => candidate.id === id);
    if (!slide) throw new Error(`no slide ${id}`);
    return slide;
  });
  const operations: AgentOperation[] = [];
  const appliedSlideIds: string[] = [];
  const paired = Math.min(targets.length, draftSlides.length);

  for (let index = 0; index < paired; index += 1) {
    const previous = targets[index];
    const visual = structuredClone(draftSlides[index]);
    visual.id = previous.id;
    visual.comments = previous.comments;
    visual.notes = previous.notes;
    visual.skipped = previous.skipped;
    operations.push({ op: 'replaceSlide', slideId: previous.id, slide: visual });
    appliedSlideIds.push(previous.id);
  }

  for (const target of targets.slice(paired)) {
    operations.push({ op: 'deleteSlide', slideId: target.id });
  }

  const additions = draftSlides.slice(paired).map((slide) => structuredClone(slide));
  if (additions.length > 0) {
    const anchor = targets.at(-1)!.id;
    operations.push({ op: 'insertSlides', afterSlideId: anchor, slides: additions });
    appliedSlideIds.push(...additions.map((slide) => slide.id));
  }

  return { operations, appliedSlideIds };
}
