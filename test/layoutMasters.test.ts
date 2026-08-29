import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  defaultLayoutMasters,
  syncDeckWithLayoutMasters,
  syncSlideWithLayoutMaster,
} from '../src/shared/layoutMasters.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';

describe('fixed layout masters', () => {
  it('starts with the legacy placeholder geometry', () => {
    const masters = defaultLayoutMasters();
    const title = masters.standard.elements.find((element) => (
      element.type === 'text' && element.layoutPlaceholder === 'title'
    ))!;
    const body = masters.standard.elements.find((element) => (
      element.type === 'text' && element.layoutPlaceholder === 'body'
    ))!;
    expect({ x: title.x, y: title.y, w: title.w, h: title.h }).toEqual(
      { x: 120, y: 58, w: 1680, h: 142 },
    );
    expect({ x: body.x, y: body.y, w: body.w, h: body.h }).toEqual(
      { x: 120, y: 252, w: 1680, h: 700 },
    );
  });

  it('updates placeholder presentation without replacing slide content', () => {
    const deck = emptyDeck();
    const masters = defaultLayoutMasters();
    const masterTitle = masters.standard.elements.find((element) => (
      element.type === 'text' && element.layoutPlaceholder === 'title'
    ))!;
    masterTitle.x = 260;
    masterTitle.style['font-family'] = 'Georgia';
    applySlideLayout(deck.slides[0], 'standard', masters);
    const title = deck.slides[0].elements.find((element) => (
      element.type === 'text' && element.layoutPlaceholder === 'title'
    ))!;
    expect(title.type).toBe('text');
    if (title.type !== 'text') throw new Error('title placeholder was not text');
    expect(title.html).toBe('Slide title');
    expect(title.x).toBe(260);
    expect(title.style['font-family']).toBe('Georgia');
  });

  it('synchronizes repeated master objects as locked concrete copies', () => {
    const deck = emptyDeck();
    const masters = defaultLayoutMasters();
    masters.freeform.elements.push({
      id: 'master-logo', type: 'text', x: 40, y: 990, w: 300, h: 40,
      rot: 0, z: 30, opacity: 1, class: ['role-caption'], style: {},
      html: 'Company', align: 'left', valign: 'middle',
    });
    deck.layoutMasters = masters;
    syncDeckWithLayoutMasters(deck);
    const copy = deck.slides[0].elements.find((element) => element.layoutMasterId === 'master-logo');
    expect(copy).toMatchObject({
      id: `${deck.slides[0].id}--master--master-logo`,
      html: 'Company',
      z: -10000,
    });
    expect(copy?.class).toContain('layout-master-element');
  });

  it('preserves an explicit slide background while inherited backgrounds follow masters', () => {
    const deck = emptyDeck();
    const master = defaultLayoutMasters().standard;
    master.background.color = '#123456';
    deck.slides[0].background.color = '#abcdef';
    syncSlideWithLayoutMaster(deck.slides[0], 'standard', master);
    expect(deck.slides[0].background.color).toBe('#abcdef');
    expect(deck.slides[0].layoutBackgroundInherited).toBe(false);
    syncSlideWithLayoutMaster(deck.slides[0], 'standard', master, { forceBackground: true });
    expect(deck.slides[0].background.color).toBe('#123456');
    expect(deck.slides[0].layoutBackgroundInherited).toBe(true);
  });
});
