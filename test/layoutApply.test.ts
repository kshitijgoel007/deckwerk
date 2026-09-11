// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CssEditor } from '../src/renderer/editor/cssEditor.js';
import { createThemePanel } from '../src/renderer/editor/themePanel.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck, type Deck, type TextEl } from '../src/shared/deck.js';
import {
  applyDesign,
  dryRunDesign,
  layoutOnlyOptions,
  summarizeDesignReport,
  themeResetOptions,
} from '../src/shared/designApply.js';
import { defaultLayoutMasters, realignSlideToLayout } from '../src/shared/layoutMasters.js';
import { THEMES, themeStyleOf } from '../src/shared/themes.js';

/**
 * The design operation has two reset axes. Layout puts slides on a master the
 * author names -- geometry only, matched by role, never inventing a box on a
 * slide that has text. Theme makes boxes follow the deck theme and hands a
 * slide's own ground back. Everything else on a slide is free styling.
 */

function slot(deck: Deck, index: number, name: 'title' | 'body'): TextEl {
  return deck.slides[index].elements.find((el): el is TextEl => (
    el.type === 'text' && el.layoutPlaceholder === name
  ))!;
}

function nudgedDeck(): Deck {
  const deck = emptyDeck('Apply layout');
  deck.layoutMasters = defaultLayoutMasters();
  deck.slides.push(structuredClone({ ...deck.slides[0], id: 's2', name: 's2' }));
  deck.slides.push(structuredClone({ ...deck.slides[0], id: 's3', name: 's3' }));
  applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
  applySlideLayout(deck.slides[1], 'standard', deck.layoutMasters);
  applySlideLayout(deck.slides[2], 'freeform', deck.layoutMasters);
  for (const index of [0, 1]) {
    const title = slot(deck, index, 'title');
    title.x = 400; title.y = 500; title.w = 300; title.h = 60; title.align = 'right';
    title.style = { color: '#ff0000', 'font-size': '200px' };
    title.html = 'Moved title';
    title.class = title.class.filter((name) => name !== 'placeholder');
  }
  return deck;
}

/** An imported slide: three untagged boxes, sized like a title, a body and a caption. */
function importedSlide(id: string): Deck['slides'][number] {
  const text = (elId: string, y: number, h: number, size: number, html: string): TextEl => ({
    id: elId, type: 'text', x: 90, y, w: 1500, h, rot: 0, z: 1, opacity: 1,
    class: ['kn-text'], style: { 'font-size': `${size}px`, 'font-family': 'Papyrus' }, html,
    align: 'left', valign: 'top',
  });
  return {
    id, name: id, background: { color: '#eaf1e6', image: null }, notes: '', layout: 'freeform',
    elements: [
      text(`${id}-a`, 40, 150, 72, 'Results on three benchmarks'),
      text(`${id}-b`, 240, 560, 34, 'Our method improves reconstruction quality across all scenes.'),
      text(`${id}-c`, 900, 60, 20, 'Figure 3: qualitative comparison'),
    ],
    timeline: [],
  };
}

describe('realignSlideToLayout', () => {
  it('moves the slot boxes back to the master geometry and touches nothing else', () => {
    const deck = nudgedDeck();
    const moved = realignSlideToLayout(deck.slides[0], deck.layoutMasters);
    const title = slot(deck, 0, 'title');
    expect(moved).toBe(2);
    expect({ x: title.x, y: title.y, w: title.w, h: title.h, align: title.align })
      .toEqual({ x: 120, y: 58, w: 1680, h: 142, align: 'left' });
    expect(title.style).toEqual({ color: '#ff0000', 'font-size': '200px' });
    expect(title.html).toBe('Moved title');
    expect(deck.slides[0].layout).toBe('standard');
  });

  it('has nothing to align on a freeform slide and never invents boxes', () => {
    const deck = nudgedDeck();
    const before = JSON.stringify(deck.slides[2]);
    expect(realignSlideToLayout(deck.slides[2], deck.layoutMasters)).toBe(0);
    expect(JSON.stringify(deck.slides[2])).toBe(before);
  });
});

describe('applyDesign: the layout axis', () => {
  it('puts the named slides on the named master, geometry only, and reports it', () => {
    const deck = nudgedDeck();
    const report = applyDesign(deck, null, layoutOnlyOptions('standard'), new Set(['s2']));
    expect(slot(deck, 1, 'title').x).toBe(120);
    expect(slot(deck, 1, 'title').align).toBe('left');
    expect(slot(deck, 0, 'title').x).toBe(400);
    // Styling is the theme axis: the box keeps its own colour and size.
    expect(slot(deck, 1, 'title').style).toEqual({ color: '#ff0000', 'font-size': '200px' });
    expect(report.moved).toEqual([slot(deck, 1, 'title').id]);
    expect(report.assigned).toEqual([]);
    expect(summarizeDesignReport(report)).toBe('moves 1 box');
  });

  it('is explicit about the target: a freeform slide is put on the layout, not skipped', () => {
    const deck = nudgedDeck();
    const report = applyDesign(deck, null, layoutOnlyOptions('standard'), new Set(['s3']));
    expect(deck.slides[2].layout).toBe('standard');
    expect(report.assigned).toEqual(['s3']);
    expect(slot(deck, 2, 'title').x).toBe(120);
  });

  it('casts untagged imported text into roles and places it, creating nothing', () => {
    const deck = emptyDeck('Import');
    deck.layoutMasters = defaultLayoutMasters();
    deck.slides = [importedSlide('imp')];
    const { report } = dryRunDesign(deck, null, layoutOnlyOptions('standard'), new Set(['imp']));
    expect(report.retagged).toEqual(['imp-a', 'imp-b', 'imp-c']);
    expect(report.created).toEqual([]);
    expect(report.moved).toEqual(['imp-a', 'imp-b']);
    expect(summarizeDesignReport(report)).toBe('moves 2 boxes, tags 3 roles');
    // The dry run left the deck alone.
    expect(deck.slides[0].elements[0].class).toEqual(['kn-text']);

    applyDesign(deck, null, layoutOnlyOptions('standard'), new Set(['imp']));
    const [a, b, c] = deck.slides[0].elements as TextEl[];
    expect(a.class).toEqual(['kn-text', 'role-title']);
    expect(b.class).toEqual(['kn-text', 'role-body']);
    expect(c.class).toEqual(['kn-text', 'role-caption']);
    expect({ x: a.x, y: a.y, w: a.w, h: a.h }).toEqual({ x: 120, y: 58, w: 1680, h: 142 });
    expect({ x: b.x, y: b.y, w: b.w, h: b.h }).toEqual({ x: 120, y: 252, w: 1680, h: 700 });
    expect(c.y).toBe(900);
    // Free styling untouched: the imported face and the slide's own ground.
    expect(a.style['font-family']).toBe('Papyrus');
    expect(deck.slides[0].background.color).toBe('#eaf1e6');
    expect(deck.slides[0].elements).toHaveLength(3);
  });

  it('warns instead of placing when detection is off and the text is untagged', () => {
    const deck = emptyDeck('Import');
    deck.layoutMasters = defaultLayoutMasters();
    deck.slides = [importedSlide('imp')];
    const options = { ...layoutOnlyOptions('standard'), detectRoles: false };
    const report = applyDesign(deck, null, options, new Set(['imp']));
    expect(report.moved).toEqual([]);
    expect(report.unplaced).toEqual([{ slideId: 'imp', slot: 'title' }, { slideId: 'imp', slot: 'body' }]);
    expect(report.undetected).toEqual(['imp']);
    expect(summarizeDesignReport(report)).toBe('no title or body box to place, untagged text cannot be placed');
  });

  it('creates the prompts only on a slide with no text at all', () => {
    const deck = emptyDeck('Empty');
    deck.layoutMasters = defaultLayoutMasters();
    const report = applyDesign(deck, null, layoutOnlyOptions('standard'), new Set([deck.slides[0].id]));
    expect(report.created).toHaveLength(2);
    expect(slot(deck, 0, 'title').class).toContain('placeholder');
    expect(slot(deck, 0, 'body').html).toBe('Body text');
    expect(summarizeDesignReport(report)).toBe('creates 2 prompts');
  });

  it('releases the slot boxes where they stand when the target is freeform', () => {
    const deck = nudgedDeck();
    const report = applyDesign(deck, null, layoutOnlyOptions('freeform'), new Set(['s2']));
    expect(deck.slides[1].layout).toBe('freeform');
    expect(report.released).toHaveLength(2);
    const title = deck.slides[1].elements.find((el) => el.class.includes('role-title')) as TextEl;
    expect(title.layoutPlaceholder).toBeUndefined();
    expect(title.x).toBe(400);
  });
});

describe('applyDesign: the theme axis', () => {
  it('makes the boxes follow the theme and hands the slide’s own ground back', () => {
    const deck = emptyDeck('Import');
    deck.layoutMasters = defaultLayoutMasters();
    deck.slides = [importedSlide('imp')];
    deck.themePreset = THEMES[0].id;
    deck.themeStyle = themeStyleOf(THEMES[0]);
    for (const [index, role] of ['title', 'body', 'caption'].entries()) {
      deck.slides[0].elements[index].class = [`role-${role}`];
    }
    const report = applyDesign(deck, THEMES[0], themeResetOptions(), new Set(['imp']));
    expect(report.followed).toEqual(['imp-a', 'imp-b', 'imp-c']);
    expect(report.overridesCleared).toEqual(['imp-a', 'imp-b', 'imp-c']);
    expect(report.backgroundsReset).toEqual(['imp']);
    expect(deck.slides[0].background).toEqual({ color: null, image: null });
    for (const el of deck.slides[0].elements as TextEl[]) {
      expect(el.style['font-family']).toBeUndefined();
      expect(el.style['font-size']).toBeUndefined();
      // Geometry is the other axis.
      expect(el.x).toBe(90);
    }
    expect(summarizeDesignReport(report))
      .toBe('3 boxes follow the theme, 3 local overrides removed, 1 background back to the theme');
  });

  it('does nothing, and says so, when everything already follows the theme', () => {
    const deck = emptyDeck('Plain');
    deck.themePreset = THEMES[0].id;
    deck.themeStyle = themeStyleOf(THEMES[0]);
    deck.slides[0].elements.push({
      id: 't', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: {}, html: 'Following', align: 'left', valign: 'top',
    });
    const snapshot = () => JSON.stringify({ ...deck.slides[0], layoutBackgroundInherited: undefined });
    const before = snapshot();
    const report = applyDesign(deck, THEMES[0], themeResetOptions(), new Set([deck.slides[0].id]));
    expect(report.overridesCleared).toEqual([]);
    expect(report.backgroundsReset).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

describe('the Design tab’s Apply', () => {
  beforeEach(() => document.body.replaceChildren());

  function panelFor(deck: Deck) {
    const store = new EditorStore(deck, '/tmp/apply-layout');
    const setStatusMessage = vi.fn();
    const save = vi.fn();
    const onPreviewSlide = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save,
      setStatusMessage,
      saveThemeCss: vi.fn(),
      onPreviewSlide,
    });
    document.body.appendChild(panel.element);
    const button = panel.element.querySelector<HTMLButtonElement>('.design-apply-button')!;
    const box = (group: string) => panel.element.querySelector<HTMLInputElement>(`input[data-group="${group}"]`)!;
    return { store, panel, button, box, setStatusMessage, save, onPreviewSlide };
  }

  const readout = (panel: HTMLElement) => [...panel.querySelectorAll('.design-readout-row')]
    .map((row) => row.textContent);

  it('names the layout as an argument and previews the dry run before applying', () => {
    const deck = nudgedDeck();
    const { store, panel, button, box, onPreviewSlide, setStatusMessage, save } = panelFor(deck);
    store.selectSlide(1);
    store.selectSlide(2, true);
    panel.syncScope(2);
    // Typography alone changes nothing on unstyled slides: the button says so.
    box('typography').click();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Nothing to change on 2 slides');

    box('layout').click();
    const target = panel.element.querySelector<HTMLSelectElement>('.design-layout-target select')!;
    expect(target.value).toBe('standard');
    expect(readout(panel.element)).toEqual([
      '1slides put on Title + Body',
      '1boxes move to Title + Body positions',
      '2prompts created on empty slides',
      '0untagged boxes get a role',
    ]);
    expect(button.textContent).toBe('Apply to 2 slides');

    button.dispatchEvent(new Event('mouseenter'));
    const [shown, label] = onPreviewSlide.mock.calls.at(-1)!;
    expect(shown.id).toBe('s3');
    expect(label).toContain('slide 3');
    expect(store.get().deck.slides[2].layout).toBe('freeform');
    button.dispatchEvent(new Event('mouseleave'));
    expect(onPreviewSlide).toHaveBeenLastCalledWith(null, '');

    button.click();
    const after = store.get().deck;
    expect(slot(after, 1, 'title').x).toBe(120);
    expect(slot(after, 0, 'title').x).toBe(400);
    expect(after.slides[2].layout).toBe('standard');
    expect(save).toHaveBeenCalled();
    expect(setStatusMessage).toHaveBeenLastCalledWith('Applied to 2 slides: creates 2 prompts, moves 1 box.');
    store.undo();
    expect(slot(store.get().deck, 1, 'title').x).toBe(400);
    expect(store.get().deck.slides[2].layout).toBe('freeform');
  });

  it('lets the master strip pick the target', () => {
    const { panel, box } = panelFor(nudgedDeck());
    box('typography').click();
    panel.element.querySelector<HTMLButtonElement>('.design-master[aria-label="Apply puts slides on Title"]')!.click();
    expect(box('layout').checked).toBe(true);
    expect(panel.element.querySelector<HTMLSelectElement>('.design-layout-target select')!.value).toBe('title');
    expect(readout(panel.element)[0]).toBe('1slides put on Title');
  });
});
