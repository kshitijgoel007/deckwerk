import { DeckSchema, parseDeck, type Deck } from './deck.js';
import type { AgentOperation } from './agent.js';

export interface LenientApplyResult {
  deck: Deck;
  /** Ops (or parts of ops) that could not apply against the current state. */
  skipped: Array<{ op: AgentOperation; reason: string }>;
}

/**
 * Apply operations with last-write-wins merge semantics.
 *
 * Unlike applyAgentTransaction — which rejects a whole transaction the moment
 * any id fails to resolve, the right contract for a CLI agent working against
 * a pinned revision — this function is total and deterministic: every op
 * either applies or is skipped by a fixed rule, and the same deck plus the
 * same op list always produces the same output. The server and every client
 * replay the same server-ordered stream through this function, which is what
 * makes replicas converge.
 *
 * Skip rules (delete wins over edit; inserts are idempotent):
 * - replaceElement / setSlideProperties / replaceSlide: target gone → skip.
 * - deleteElements: filtered to ids that still exist; deleteSlide of the last
 *   remaining slide → skip.
 * - moveSlide: slide or anchor gone → skip (slide stays put).
 * - insertElements: target slide gone → skip; elements whose id already
 *   exists deck-wide are dropped.
 * - insertSlides: slides whose id already exists are dropped; a vanished
 *   anchor appends at the end rather than discarding the user's new slide.
 * - updateDeck: always applies.
 *
 * Afterwards, timeline entries referencing elements that no longer exist on
 * their slide are pruned, so a concurrent element delete can never leave a
 * slide's timeline dangling (validateDeckIntegrity treats that as an error).
 */
export function applyOpsLenient(deck: Deck, ops: AgentOperation[]): LenientApplyResult {
  const next = structuredClone(parseDeck(deck));
  const skipped: LenientApplyResult['skipped'] = [];
  const skip = (op: AgentOperation, reason: string) => skipped.push({ op, reason });

  for (const op of ops) applyLenient(next, op, skip);
  pruneDanglingTimelines(next);
  return { deck: DeckSchema.parse(next), skipped };
}

function applyLenient(
  deck: Deck,
  op: AgentOperation,
  skip: (op: AgentOperation, reason: string) => void,
): void {
  switch (op.op) {
    case 'insertSlides': {
      const existing = slideIdSet(deck);
      const fresh = op.slides.filter((slide) => !existing.has(slide.id));
      if (fresh.length === 0) return skip(op, 'all slide ids already present');
      const at = op.afterSlideId === null
        ? 0
        : indexOfSlide(deck, op.afterSlideId) === -1
          ? deck.slides.length // anchor deleted concurrently: keep the new slides, append
          : indexOfSlide(deck, op.afterSlideId) + 1;
      deck.slides.splice(at, 0, ...structuredClone(fresh));
      return;
    }
    case 'replaceSlide': {
      const at = indexOfSlide(deck, op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      if (op.slide.id !== op.slideId) return skip(op, 'replacement changes slide id');
      deck.slides[at] = structuredClone(op.slide);
      return;
    }
    case 'deleteSlide': {
      const at = indexOfSlide(deck, op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} already deleted`);
      if (deck.slides.length === 1) return skip(op, 'a deck must retain at least one slide');
      deck.slides.splice(at, 1);
      return;
    }
    case 'moveSlide': {
      if (op.afterSlideId === op.slideId) return skip(op, 'slide cannot follow itself');
      const from = indexOfSlide(deck, op.slideId);
      if (from === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      if (op.afterSlideId !== null && indexOfSlide(deck, op.afterSlideId) === -1) {
        return skip(op, `anchor ${op.afterSlideId} no longer exists`);
      }
      const [slide] = deck.slides.splice(from, 1);
      const at = op.afterSlideId === null ? 0 : indexOfSlide(deck, op.afterSlideId) + 1;
      deck.slides.splice(at, 0, slide);
      return;
    }
    case 'insertElements': {
      const slide = deck.slides.find((candidate) => candidate.id === op.slideId);
      if (!slide) return skip(op, `slide ${op.slideId} no longer exists`);
      const existing = elementIdSet(deck);
      const fresh = op.elements.filter((element) => !existing.has(element.id));
      if (fresh.length === 0) return skip(op, 'all element ids already present');
      slide.elements.push(...structuredClone(fresh));
      return;
    }
    case 'replaceElement': {
      const slide = deck.slides.find((candidate) => candidate.id === op.slideId);
      if (!slide) return skip(op, `slide ${op.slideId} no longer exists`);
      const at = slide.elements.findIndex((element) => element.id === op.elementId);
      if (at === -1) return skip(op, `element ${op.elementId} no longer exists`);
      if (op.element.id !== op.elementId) return skip(op, 'replacement changes element id');
      slide.elements[at] = structuredClone(op.element);
      return;
    }
    case 'deleteElements': {
      const slide = deck.slides.find((candidate) => candidate.id === op.slideId);
      if (!slide) return skip(op, `slide ${op.slideId} no longer exists`);
      const ids = new Set(op.elementIds);
      const before = slide.elements.length;
      slide.elements = slide.elements.filter((element) => !ids.has(element.id));
      if (slide.elements.length === before) return skip(op, 'no listed element still exists');
      slide.timeline = slide.timeline.filter((entry) =>
        !ids.has(entry.action.target) && !(entry.trigger.ref && ids.has(entry.trigger.ref)));
      return;
    }
    case 'updateDeck':
      if (op.title !== undefined) deck.title = op.title;
      if (op.canvas !== undefined) deck.canvas = structuredClone(op.canvas);
      if (op.theme !== undefined) deck.theme = op.theme;
      if (op.themePreset !== undefined) deck.themePreset = op.themePreset;
      if (op.themeStyle !== undefined) deck.themeStyle = structuredClone(op.themeStyle);
      if (op.magicMoveEasing !== undefined) deck.magicMoveEasing = op.magicMoveEasing;
      return;
    case 'setSlideProperties': {
      const at = indexOfSlide(deck, op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      if (op.slide.id !== op.slideId) return skip(op, 'properties change slide id');
      // Merge, never replace: the op carries only the fields that changed, so
      // a concurrent edit to a different field of the same slide survives.
      deck.slides[at] = {
        ...deck.slides[at],
        ...structuredClone(op.slide),
        elements: deck.slides[at].elements,
      };
      // Absence in a patch means "unchanged", so a removal is stated instead.
      for (const key of op.clear ?? []) {
        if (key === 'id' || key === 'elements') continue;
        delete (deck.slides[at] as Record<string, unknown>)[key];
      }
      return;
    }
  }
}

function pruneDanglingTimelines(deck: Deck): void {
  for (const slide of deck.slides) {
    const local = new Set(slide.elements.map((element) => element.id));
    slide.timeline = slide.timeline.filter((entry) =>
      local.has(entry.action.target) && (!entry.trigger.ref || local.has(entry.trigger.ref)));
  }
}

function slideIdSet(deck: Deck): Set<string> {
  return new Set(deck.slides.map((slide) => slide.id));
}

function elementIdSet(deck: Deck): Set<string> {
  const ids = new Set<string>();
  for (const slide of deck.slides) for (const element of slide.elements) ids.add(element.id);
  return ids;
}

function indexOfSlide(deck: Deck, id: string): number {
  return deck.slides.findIndex((slide) => slide.id === id);
}
