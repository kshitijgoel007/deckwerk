import { describe, expect, it } from 'vitest';
import { applyAgentOperations, applyAgentTransaction, canonicalDeckJson } from '../src/shared/agent.js';
import { DECK_VERSION, emptyDeck, parseDeck } from '../src/shared/deck.js';
import { diffDecks } from '../src/shared/deckDiff.js';
import { deckOutline } from '../src/shared/deckDigest.js';
import { MORPH_NAME } from '../src/shared/featureNames.js';
import {
  RETIRED_FIELD_NAMES,
  canonicalFieldPath,
  renameRetiredDataAttributes,
  renameRetiredFields,
} from '../src/shared/fieldAliases.js';
import { authoringPageHtml } from '../src/shared/htmlMeasure.js';
import { applyNativeEdits, nativeEditContract } from '../src/shared/nativeEdits.js';

/**
 * The feature shipped as "Magic Move" until 2026-09 and is now Morph. Decks,
 * HTML sources and agent requests written against the old field names have to
 * keep loading, and the next rename has to stay this cheap — so these are
 * tests of the alias mechanism, not of one historical rename.
 */
const legacyDeck = () => ({
  version: DECK_VERSION,
  title: 'Legacy names',
  canvas: { w: 1920, h: 1080 },
  theme: 'theme.css',
  magicMoveEasing: 'ease-out',
  slides: [
    {
      id: 'slide-1',
      name: 'One',
      elements: [{
        id: 'title', type: 'text', x: 0, y: 0, w: 300, h: 80,
        html: 'Shared', magicMoveId: 'pair-1',
      }],
    },
    {
      id: 'slide-2',
      name: 'Two',
      magicMoveFromPrevious: true,
      magicMoveDuration: 700,
      elements: [{
        id: 'title', type: 'text', x: 600, y: 0, w: 300, h: 80,
        html: 'Shared', magicMoveId: 'pair-1',
      }],
    },
  ],
});

describe('retired field names', () => {
  it('loads a deck written against the retired names', () => {
    const deck = parseDeck(legacyDeck());
    expect(deck.morphEasing).toBe('ease-out');
    expect(deck.slides[1].morphFromPrevious).toBe(true);
    expect(deck.slides[1].morphDuration).toBe(700);
    expect(deck.slides[0].elements[0].morphId).toBe('pair-1');
    expect(deck.slides[1].elements[0].morphId).toBe('pair-1');
    // Nothing retired survives into the parsed deck: one canonical spelling
    // reaches the renderer, the differ and the file we save back.
    expect(JSON.stringify(deck)).not.toMatch(/magicMove/);
  });

  it('lets the current name win when a deck carries both spellings', () => {
    const raw = legacyDeck() as Record<string, any>;
    raw.slides[1].morphDuration = 1200;
    expect(parseDeck(raw).slides[1].morphDuration).toBe(1200);
  });

  it('leaves values, arrays and unrelated keys untouched', () => {
    const input = { keep: 'magicMoveId', list: [{ magicMoveId: 'a' }, 3, null], nested: { other: 1 } };
    expect(renameRetiredFields(input)).toEqual({
      keep: 'magicMoveId', list: [{ morphId: 'a' }, 3, null], nested: { other: 1 },
    });
  });

  it('canonicalises a retired edit path from an agent on an older brief', () => {
    const before = parseDeck({ ...emptyDeck('Edits'), slides: [{
      id: 's1', name: 'One',
      elements: [{ id: 'title', type: 'text', x: 0, y: 0, w: 300, h: 80, html: 'Shared' }],
    }] });
    const { deck } = applyNativeEdits(before, [
      { target: 'element', slideId: 's1', elementId: 'title', set: { magicMoveId: 'pair-1' } },
      { target: 'deck', set: { magicMoveEasing: 'linear' } },
    ]);
    expect(deck.slides[0].elements[0].morphId).toBe('pair-1');
    expect(deck.morphEasing).toBe('linear');
    expect(canonicalFieldPath('magicMoveId')).toBe('morphId');
    expect(canonicalFieldPath('style.color')).toBe('style.color');
  });

  it('applies an agent operation written against the retired names', () => {
    const deck = applyAgentOperations(parseDeck(emptyDeck('Ops')), [
      { op: 'updateDeck', magicMoveEasing: 'linear' },
    ] as never);
    expect(deck.morphEasing).toBe('linear');
  });

  it('canonicalises retired data attributes on the way into the measuring page', () => {
    const authored = '<div class="slide" data-slide-id="s1" data-magic-move-from-previous="true"'
      + ' data-magic-move-duration="700">'
      + '<div class="element element-text" data-element-id="title" data-magic-move="pair-1">Shared</div></div>';
    const page = authoringPageHtml({
      authored, typeCss: '', theme: '', canvas: { w: 1920, h: 1080 }, base: 'file:///deck/',
    });
    expect(page).toContain('data-morph-from-previous="true"');
    expect(page).toContain('data-morph-duration="700"');
    expect(page).toContain('data-morph="pair-1"');
    expect(page).not.toMatch(/data-magic-move/);
  });

  it('rewrites the longest retired attribute name whatever order the table is in', () => {
    // `data-magic-move` is a prefix of `data-magic-move-duration`; a careless
    // replacement turns the longer one into `data-morph-duration` twice over.
    expect(renameRetiredDataAttributes('<i data-magic-move-duration="700" data-magic-move="a">'))
      .toBe('<i data-morph-duration="700" data-morph="a">');
    // An attribute that merely starts with a retired name is not ours.
    expect(renameRetiredDataAttributes('<i data-magic-move-unknown="1">'))
      .toBe('<i data-magic-move-unknown="1">');
  });

  it('keeps every retired name pointing at a field the format still has', () => {
    const contract = nativeEditContract() as any;
    const paths = new Set<string>([
      ...contract.deck.map((row: any) => row.path),
      ...contract.slide.map((row: any) => row.path),
      ...contract.element.common.map((row: any) => row.path),
    ]);
    for (const [retired, current] of Object.entries(RETIRED_FIELD_NAMES)) {
      expect(retired).not.toBe(current);
      // `magicMove` -> `morph` is the HTML attribute stem rather than an
      // editable property, so it has no row in the edit contract.
      if (current === 'morph') continue;
      expect(paths, `${retired} -> ${current}`).toContain(current);
    }
  });

  it('spells the feature name in exactly one place', () => {
    expect(MORPH_NAME).toBe('Morph');
    expect(nativeEditContract() as any).toMatchObject({
      element: { common: expect.arrayContaining([
        expect.objectContaining({ path: 'morphId', description: `Explicit ${MORPH_NAME} pairing identity.` }),
      ]) },
    });
  });
});

describe('retired field names: edge cases', () => {
  it('lets the current name win whichever spelling the object lists first', () => {
    expect(renameRetiredFields({ magicMoveId: 'old', morphId: 'new' })).toEqual({ morphId: 'new' });
    expect(renameRetiredFields({ morphId: 'new', magicMoveId: 'old' })).toEqual({ morphId: 'new' });
    // A current-name key wins even when its value is null: the author cleared
    // the pairing on purpose, and the stale duplicate must not restore it.
    expect(renameRetiredFields({ magicMoveId: 'old', morphId: null })).toEqual({ morphId: null });
  });

  it('carries null and undefined values across under the current name', () => {
    const renamed = renameRetiredFields({ magicMoveId: null, magicMoveDuration: undefined });
    expect(renamed).toEqual({ morphId: null, morphDuration: undefined });
    expect(Object.keys(renamed)).toEqual(['morphId', 'morphDuration']);
  });

  it('walks arrays nested in arrays and objects nested in arrays', () => {
    expect(renameRetiredFields([[{ magicMoveEasing: 'linear' }], { slides: [[{ magicMoveId: 'a' }]] }]))
      .toEqual([[{ morphEasing: 'linear' }], { slides: [[{ morphId: 'a' }]] }]);
  });

  it('walks null-prototype objects and leaves class instances alone', () => {
    const bare = Object.assign(Object.create(null), { magicMoveId: 'a' });
    expect(renameRetiredFields(bare)).toEqual({ morphId: 'a' });
    const when = new Date(0);
    const map = new Map([['magicMoveId', 1]]);
    expect(renameRetiredFields({ when, map })).toEqual({ when, map });
    expect(renameRetiredFields({ when }).when).toBe(when);
  });

  it('matches whole key names only, never a key that merely contains one', () => {
    expect(renameRetiredFields({ magicMoveIdx: 1, xmagicMoveId: 2, magicmoveid: 3 }))
      .toEqual({ magicMoveIdx: 1, xmagicMoveId: 2, magicmoveid: 3 });
    expect(canonicalFieldPath('magicMoveIdx.magicMoveId')).toBe('magicMoveIdx.morphId');
  });

  it('canonicalises every segment of a dotted path', () => {
    expect(canonicalFieldPath('slides.0.magicMoveDuration')).toBe('slides.0.morphDuration');
    expect(canonicalFieldPath('')).toBe('');
  });

  it('migrates a retired deck-level duration onto slides after renaming it', () => {
    const raw = legacyDeck() as Record<string, any>;
    delete raw.slides[1].magicMoveDuration;
    raw.magicMoveDuration = 450;
    raw.slides[0].morphDuration = 300;
    const deck = parseDeck(raw);
    expect(deck.slides.map((slide) => slide.morphDuration)).toEqual([300, 450]);
    expect(deck).not.toHaveProperty('morphDuration');
    expect(deck).not.toHaveProperty('magicMoveDuration');
  });

  it('treats a deck saved under retired names as identical to its canonical twin', () => {
    const legacy = parseDeck(legacyDeck());
    const canonical = parseDeck(JSON.parse(JSON.stringify(legacyDeck()).replace(/magicMove/g, 'morph')));
    expect(canonicalDeckJson(legacy)).toBe(canonicalDeckJson(canonical));
    expect(diffDecks(legacy, canonical)).toEqual([]);
    expect(deckOutline(legacy)[1]).toMatchObject({ morphFromPrevious: true, morphDuration: 700 });
    expect(JSON.stringify(deckOutline(legacy))).not.toMatch(/magicMove/);
  });

  it('applies a whole transaction whose nested slides and elements use retired names', () => {
    const raw = legacyDeck();
    raw.slides[1].elements[0].id = 'title-2'; // element ids are deck-wide unique
    const before = parseDeck(raw);
    const after = applyAgentTransaction(before, {
      version: 1,
      expectedRevision: 'a'.repeat(64),
      label: 'Legacy names',
      operations: [
        { op: 'setSlideProperties', slideId: 'slide-2', slide: { id: 'slide-2', magicMoveFromPrevious: false, magicMoveDuration: 400 } },
        {
          op: 'replaceElement', slideId: 'slide-1', elementId: 'title', element: {
            id: 'title', type: 'text', x: 0, y: 0, w: 300, h: 80, html: 'Shared', magicMoveId: 'pair-2',
          },
        },
        {
          op: 'insertSlides', afterSlideId: 'slide-2', slides: [{
            id: 'slide-3', name: 'Three', magicMoveFromPrevious: true,
            elements: [{ id: 'e3', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'x', magicMoveId: 'pair-2' }],
          }],
        },
      ],
    } as never);
    expect(after.slides[1]).toMatchObject({ morphFromPrevious: false, morphDuration: 400 });
    expect(after.slides[0].elements[0].morphId).toBe('pair-2');
    expect(after.slides[2].morphFromPrevious).toBe(true);
    expect(after.slides[2].elements[0].morphId).toBe('pair-2');
    expect(JSON.stringify(after)).not.toMatch(/magicMove/);
  });

  it('unsets through a retired path and refuses both spellings of one property in one edit', () => {
    const before = parseDeck(legacyDeck());
    const { deck } = applyNativeEdits(before, [
      { target: 'slide', slideId: 'slide-2', unset: ['magicMoveDuration'] },
      { target: 'element', slideId: 'slide-1', elementId: 'title', unset: ['magicMoveId'] },
    ]);
    expect(deck.slides[1].morphDuration).toBeUndefined();
    expect(deck.slides[0].elements[0].morphId).toBeUndefined();
    expect(() => applyNativeEdits(before, [
      { target: 'deck', set: { magicMoveEasing: 'linear', morphEasing: 'ease-out' } },
    ])).toThrow(/overlap/);
  });

  it('rewrites retired attributes however they are cased or quoted', () => {
    expect(renameRetiredDataAttributes(`<i DATA-MAGIC-MOVE='a' Data-Magic-Move-Duration=700>`))
      .toBe(`<i data-morph='a' data-morph-duration=700>`);
    // Already-canonical markup passes through untouched.
    const canonical = '<i data-morph="a" data-morph-duration="700" data-morph-from-previous="true">';
    expect(renameRetiredDataAttributes(canonical)).toBe(canonical);
  });
});
