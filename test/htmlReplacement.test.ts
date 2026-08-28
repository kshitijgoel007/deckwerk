import { describe, expect, it } from 'vitest';
import { applyAgentTransaction } from '../src/shared/agent.js';
import { emptyDeck, parseDeck, type Slide } from '../src/shared/deck.js';
import { planHtmlReplacement } from '../src/server/htmlReplacement.js';

const slide = (id: string, name: string): Slide => parseDeck({
  ...emptyDeck(),
  slides: [{ id, name }],
}).slides[0];

describe('variable-length HTML replacement', () => {
  it('replaces paired slides and inserts extra draft slides after the final target', () => {
    const deck = parseDeck({
      ...emptyDeck(),
      slides: [
        { id: 'before', name: 'Before' },
        { id: 'target-a', name: 'A', notes: 'keep A', comments: [{ id: 'c1', author: 'Human', text: 'review', ts: 'now', resolved: false }] },
        { id: 'target-b', name: 'B', skipped: true },
        { id: 'after', name: 'After' },
      ],
    });
    const plan = planHtmlReplacement(deck, ['target-a', 'target-b'], [
      slide('draft-1', 'New 1'),
      slide('draft-2', 'New 2'),
      slide('draft-3', 'New 3'),
    ]);
    const next = applyAgentTransaction(deck, {
      version: 1,
      expectedRevision: '0'.repeat(64),
      label: 'replace',
      operations: plan.operations,
    });

    expect(next.slides.map((candidate) => candidate.id))
      .toEqual(['before', 'target-a', 'target-b', 'draft-3', 'after']);
    expect(next.slides[1]).toMatchObject({ name: 'New 1', notes: 'keep A', comments: [expect.objectContaining({ id: 'c1' })] });
    expect(next.slides[2]).toMatchObject({ name: 'New 2', skipped: true });
    expect(plan.appliedSlideIds).toEqual(['target-a', 'target-b', 'draft-3']);
  });

  it('deletes surplus targets while preserving paired target identity', () => {
    const deck = parseDeck({
      ...emptyDeck(),
      slides: [
        { id: 'before', name: 'Before' },
        { id: 'target-a', name: 'A' },
        { id: 'target-b', name: 'B' },
        { id: 'target-c', name: 'C' },
        { id: 'after', name: 'After' },
      ],
    });
    const plan = planHtmlReplacement(deck, ['target-a', 'target-b', 'target-c'], [
      slide('draft-1', 'Condensed'),
    ]);
    const next = applyAgentTransaction(deck, {
      version: 1,
      expectedRevision: '0'.repeat(64),
      label: 'replace',
      operations: plan.operations,
    });

    expect(plan.operations.map((operation) => operation.op))
      .toEqual(['replaceSlide', 'deleteSlide', 'deleteSlide']);
    expect(next.slides.map((candidate) => [candidate.id, candidate.name]))
      .toEqual([['before', 'Before'], ['target-a', 'Condensed'], ['after', 'After']]);
    expect(plan.appliedSlideIds).toEqual(['target-a']);
  });
});
