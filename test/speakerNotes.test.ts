import { describe, expect, it } from 'vitest';
import { type Deck, emptyDeck, parseDeck } from '../src/shared/deck.js';
import {
  applySpeakerNotes,
  parseSpeakerNotes,
  serializeSpeakerNotes,
} from '../src/shared/speakerNotes.js';

/**
 * `notes.md` is the hand-editable mirror of the per-slide `notes` strings in
 * deck.json. It has to survive a round trip through the editor untouched, and
 * an edit made in a plain text editor — with or without the lines the editor
 * generates — has to land on the right slides.
 */

function deckWith(notes: Array<string | { notes: string; name?: string; title?: string }>): Deck {
  const deck = emptyDeck('Notes');
  deck.slides = notes.map((entry, index) => {
    const spec = typeof entry === 'string' ? { notes: entry } : entry;
    return parseDeck({
      ...deck,
      slides: [{
        id: `slide-${index + 1}`,
        name: spec.name ?? '',
        notes: spec.notes,
        elements: spec.title
          ? [{
            id: `title-${index + 1}`,
            type: 'text',
            x: 0, y: 0, w: 100, h: 50,
            class: ['role-title'],
            html: `<p><b>${spec.title}</b>&nbsp;</p>`,
          }]
          : [],
      }],
    }).slides[0];
  });
  return deck;
}

describe('speaker notes markdown', () => {
  it('writes one section per slide with a heading and an id anchor', () => {
    const deck = deckWith([
      { notes: 'Open with the story.', title: 'Welcome' },
      { notes: '- lock-in\n- agents', name: 'Why' },
      '',
    ]);
    expect(serializeSpeakerNotes(deck)).toBe([
      '## 1 · Welcome',
      '<!-- slide: slide-1 -->',
      '',
      'Open with the story.',
      '',
      '---',
      '',
      '## 2 · Why',
      '<!-- slide: slide-2 -->',
      '',
      '- lock-in',
      '- agents',
      '',
      '---',
      '',
      '## Slide 3',
      '<!-- slide: slide-3 -->',
      '',
    ].join('\n'));
  });

  it('round-trips without changing any note', () => {
    const deck = deckWith(['first\n\nsecond paragraph', '', 'trailing spaces   ', 'has ## a heading\nline']);
    // Trailing whitespace is not written to the file and, coming back, is not
    // a change either — otherwise every save would dirty the deck.
    const applied = applySpeakerNotes(deck, serializeSpeakerNotes(deck));
    expect(applied.changed).toBe(false);
    expect(applied.deck).toBe(deck);
  });

  it('accepts a file that is nothing but notes and dividers', () => {
    const deck = deckWith(['', '', '']);
    const applied = applySpeakerNotes(deck, 'one\n---\ntwo\n\n---\n\nthree\r\n');
    expect(applied.deck.slides.map((s) => s.notes)).toEqual(['one', 'two', 'three']);
    expect(applied.dropped).toBe(0);
  });

  it('keeps a heading the author wrote and drops only the generated one', () => {
    const sections = parseSpeakerNotes([
      '## 1 · Intro',
      '<!-- slide: slide-1 -->',
      '',
      '## My own heading',
      'text',
      '---',
      '<!-- slide: slide-2 -->',
      '## 2 · Generated heading after the anchor is still stripped',
    ].join('\n'));
    expect(sections).toEqual([
      { id: 'slide-1', text: '## My own heading\ntext' },
      { id: 'slide-2', text: '' },
    ]);
  });

  it('follows the anchors when the file order no longer matches the deck', () => {
    const deck = deckWith(['a', 'b', 'c']);
    const file = [
      '## 1 · x', '<!-- slide: slide-3 -->', '', 'third',
      '---',
      '## 2 · x', '<!-- slide: slide-1 -->', '', 'first',
      '---',
      '## 3 · x', '<!-- slide: slide-2 -->', '', 'second',
    ].join('\n');
    const applied = applySpeakerNotes(deck, file);
    expect(applied.deck.slides.map((s) => s.notes)).toEqual(['first', 'second', 'third']);
  });

  it('fills unclaimed slides positionally with unanchored or unknown sections', () => {
    const deck = deckWith(['a', 'b', 'c', 'd']);
    const file = [
      'no anchor, so goes to the first free slide',
      '---',
      '<!-- slide: slide-3 -->', 'anchored third',
      '---',
      '<!-- slide: slide-gone -->', 'unknown id, next free slide',
    ].join('\n');
    const applied = applySpeakerNotes(deck, file);
    expect(applied.deck.slides.map((s) => s.notes)).toEqual([
      'no anchor, so goes to the first free slide',
      'unknown id, next free slide',
      'anchored third',
      '',
    ]);
    expect(applied.dropped).toBe(0);
  });

  it('empties slides the file no longer mentions and counts surplus sections', () => {
    const deck = deckWith(['a', 'b']);
    expect(applySpeakerNotes(deck, 'only one').deck.slides.map((s) => s.notes)).toEqual(['only one', '']);
    const surplus = applySpeakerNotes(deck, 'one\n---\ntwo\n---\nthree\n---\nfour');
    expect(surplus.deck.slides.map((s) => s.notes)).toEqual(['one', 'two']);
    expect(surplus.dropped).toBe(2);
  });

  it('shares untouched slide objects so the editor keeps their DOM', () => {
    const deck = deckWith(['same', 'old']);
    const applied = applySpeakerNotes(deck, 'same\n---\nnew');
    expect(applied.deck.slides[0]).toBe(deck.slides[0]);
    expect(applied.deck.slides[1]).not.toBe(deck.slides[1]);
    expect(applied.deck.slides[1].notes).toBe('new');
  });
});
